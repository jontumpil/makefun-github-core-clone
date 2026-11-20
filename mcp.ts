// The MCP endpoint at POST /mcp: JSON-RPC 2.0 over streamable HTTP. Speaks the modern revision
// (server/discover, stateless calls) and the legacy handshake (initialize +
// notifications/initialized). Six tools over the same store as REST/GraphQL, so an object made
// through one surface is the same object on the others.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { DB, VIEWER, squashMerge, type RepoRec } from './store.ts';
import { isAuthed, isRecord, sendJson } from './http.ts';
import { createIssueRecord, createPullRecord, issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const strProp = (description: string): Record<string, unknown> => ({ type: 'string', description });

export const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    name: strProp('The repository name.'),
    description: strProp('The repository description.'),
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: strProp('The repository owner login.'),
    repo: strProp('The repository name.'),
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: strProp('The repository owner login.'),
    repo: strProp('The repository name.'),
    title: strProp('The issue title.'),
    body: strProp('The issue body.'),
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository.', {
    owner: strProp('The repository owner login.'),
    repo: strProp('The repository name.'),
    state: strProp('Filter by state: open, closed or all.'),
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: strProp('The repository owner login.'),
    repo: strProp('The repository name.'),
    title: strProp('The pull request title.'),
    body: strProp('The pull request body.'),
    head: strProp('The head branch name.'),
    base: strProp('The base branch name.'),
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request (squash).', {
    owner: strProp('The repository owner login.'),
    repo: strProp('The repository name.'),
    pull_number: { type: 'number', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
];

type Json = Record<string, unknown>;

function toolResult(payload: unknown): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Json,
    isError: false,
  };
}

function toolError(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

class InvalidParams extends Error {}

function need(args: Json, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new InvalidParams(`Missing required argument: ${key}`);
  return value;
}

function findRepo(args: Json): RepoRec {
  const owner = need(args, 'owner');
  const name = need(args, 'repo');
  const repo = DB.repo(owner, name);
  if (!repo) throw new InvalidParams(`Repository ${owner}/${name} not found`);
  return repo;
}

function callTool(name: string, args: Json): Json {
  switch (name) {
    case 'create_repo': {
      const repoName = need(args, 'name');
      const existing = DB.repo(VIEWER.login, repoName);
      if (existing) return toolResult(repoJson(existing));
      const repo = DB.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private !== false);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      return toolResult(repoJson(findRepo(args)));
    }
    case 'create_issue': {
      const repo = findRepo(args);
      const title = need(args, 'title');
      const issue = createIssueRecord(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = findRepo(args);
      const title = need(args, 'title');
      const head = need(args, 'head');
      const base = need(args, 'base');
      if (!repo.refs.has(`refs/heads/${head}`)) return toolError(`Head branch "${head}" does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return toolError(`Base branch "${base}" does not exist`);
      const pull = createPullRecord(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (!pull) return toolError(`Pull request not found`);
      if (pull.merged) return toolResult(pullJson(repo, pull));
      const sha = squashMerge(repo, pull);
      if (!sha) return toolError('Pull Request is not mergeable');
      return toolResult(pullJson(repo, pull));
    }
    default:
      throw new InvalidParams(`Unknown tool: ${name}`);
  }
}

interface RpcOutcome {
  status: number;
  payload: unknown;
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleRpc(message: Json): RpcOutcome | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = isRecord(message.params) ? message.params : {};
  if (id === undefined) return null; // A notification: accepted, no answer.

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        payload: {
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            _meta: {
              'io.modelcontextprotocol/serverInfo': SERVER_INFO,
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            },
          },
        },
      };
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return {
        status: 200,
        payload: { jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO } },
      };
    }
    case 'ping':
      return { status: 200, payload: { jsonrpc: '2.0', id, result: {} } };
    case 'tools/list':
      return { status: 200, payload: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (!TOOLS.some((candidate) => candidate.name === name)) {
        return { status: 200, payload: rpcError(id, -32602, `Unknown tool: ${name}`) };
      }
      try {
        return { status: 200, payload: { jsonrpc: '2.0', id, result: callTool(name, args) } };
      } catch (err) {
        if (err instanceof InvalidParams) return { status: 200, payload: rpcError(id, -32602, err.message) };
        return { status: 200, payload: { jsonrpc: '2.0', id, result: toolError(err instanceof Error ? err.message : String(err)) } };
      }
    }
    default:
      return { status: 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

/** The /mcp handler. */
export function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => (isRecord(entry) ? handleRpc(entry) : null)).filter((entry) => entry !== null);
    if (answers.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, answers.map((entry) => entry.payload));
    return;
  }
  if (!isRecord(parsed)) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(rpcError(null, -32600, 'Invalid Request')));
    return;
  }
  const outcome = handleRpc(parsed);
  if (outcome === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  if (parsed.method === 'initialize') res.setHeader('mcp-session-id', 'github-core-clone-session');
  sendJson(res, outcome.status, outcome.payload);
}
