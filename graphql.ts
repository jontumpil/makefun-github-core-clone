// The GraphQL v4 surface at POST /api/graphql: a small parser and executor for the documents gh and
// github-mcp-server send (viewer, repository reads, issue/pull-request connections with cursor
// pagination, the create/close/merge/comment mutations, node(id:) and the __type feature probes),
// executed against the same store as REST. GraphQL-level failures are HTTP 200 with an errors
// array; only a missing/invalid token is an HTTP error (401).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DB,
  VIEWER,
  globalId,
  isoOf,
  nextTimestamp,
  parseGlobalId,
  pullFiles,
  pullMergeable,
  squashMerge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { isAuthed, isRecord, jsonBody, sendJson } from './http.ts';
import { createIssueRecord, createPullRecord } from './rest.ts';

// -------------------------------------------------------------------------------------------------
// Parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selection?: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():[]!$=@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          text += source[j + 1] === 'u' ? String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)) : escapeChar(source[j + 1]);
          j += source[j + 1] === 'u' ? 6 : 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push(`"${text}"`);
      i = j + 1;
      continue;
    }
    const match = /^-?[0-9]+\.?[0-9]*([eE][+-]?[0-9]+)?|^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
    if (match) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

function escapeChar(ch: string): string {
  switch (ch) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'b': return '\b';
    case 'f': return '\f';
    case '/': return '/';
    case '\\': return '\\';
    case '"': return '"';
    default: return ch;
  }
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  private skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === open) depth += 1;
      else if (token === close) depth -= 1;
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')');
        operations.push({ type: token === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else if (token === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?[0-9]/.test(token)) return { kind: 'number', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Schema surface for introspection

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'user', 'organization', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt', 'repositories', 'issues'],
  Organization: ['id', 'databaseId', 'login', 'name', 'url', 'repositories'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
    'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'isFork',
    'createdAt', 'updatedAt', 'url', 'homepageUrl', 'labels', 'ref', 'refs', 'stargazerCount', 'forkCount', 'primaryLanguage',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt',
    'closedAt', 'url', 'repository', 'assignees', 'milestone', 'reactions', 'viewerDidAuthor',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'commits', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'url',
    'repository', 'additions', 'deletions', 'changedFiles', 'mergeCommit', 'isDraft',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'prefix', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  Commit: ['id', 'oid', 'message', 'authoredDate', 'tree'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestChangedFileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED'],
  TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
};

function typeKind(name: string): string {
  if (name in ENUM_VALUES) return 'ENUM';
  if (['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'Base64String'].includes(name)) return 'SCALAR';
  if (name in OBJECT_FIELDS) return name === 'Node' ? 'INTERFACE' : 'OBJECT';
  return 'OBJECT';
}

// -------------------------------------------------------------------------------------------------
// Runtime values and field resolution

type Obj =
  | { t: 'User' }
  | { t: 'Repository'; repo: RepoRec }
  | { t: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { t: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { t: 'Label'; repo: RepoRec; name: string }
  | { t: 'Ref'; name: string }
  | { t: 'IssueConnection'; nodes: Obj[]; total: number; hasNext: boolean; endCursor: string | null }
  | { t: 'PullRequestConnection'; nodes: Obj[]; total: number; hasNext: boolean; endCursor: string | null }
  | { t: 'Nodes'; nodes: Obj[] }
  | { t: 'Edge'; node: Obj; cursor: string }
  | { t: 'PageInfo'; hasNext: boolean; endCursor: string | null }
  | { t: 'ChangedFile'; path: string; additions: number; deletions: number; changeType: string }
  | { t: '__Type'; name: string }
  | { t: '__Field'; name: string }
  | { t: '__EnumValue'; name: string }
  | { t: 'Payload'; kind: string; repo?: RepoRec; issue?: IssueRec; pull?: PullRec; comment?: { id: number; body: string }; clientMutationId?: unknown }
  | { t: 'IssueComment'; id: number; body: string };

class GqlFieldError extends Error {}

interface Ctx {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function cursorFor(kind: string, number: number): string {
  return Buffer.from(`cursor:${kind}:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(after: unknown): number | null {
  if (typeof after !== 'string' || after === '') return null;
  try {
    const text = Buffer.from(after, 'base64url').toString('utf8');
    const match = /^cursor:[a-z]+:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function repoByDbId(id: number): RepoRec | undefined {
  return DB.listRepos().find((repo) => repo.id === id);
}

function findIssueByGlobalId(id: string): { repo: RepoRec; issue: IssueRec } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const repo = repoByDbId(parsed.nums[0]);
  const issue = repo?.issues.get(parsed.nums[1]);
  return repo && issue ? { repo, issue } : null;
}

function findPullByGlobalId(id: string): { repo: RepoRec; pull: PullRec } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const repo = repoByDbId(parsed.nums[0]);
  const pull = repo?.pulls.get(parsed.nums[1]);
  return repo && pull ? { repo, pull } : null;
}

function issueConnection(repo: RepoRec, args: Record<string, unknown>): Obj {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? args.states.map(String) : null;
  if (states) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const total = issues.length;
  const afterNumber = numberFromCursor(args.after);
  let start = 0;
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    if (index !== -1) start = index + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : total;
  const slice = issues.slice(start, start + first);
  const nodes: Obj[] = slice.map((issue) => ({ t: 'Issue', repo, issue }));
  return {
    t: 'IssueConnection',
    nodes,
    total,
    hasNext: start + slice.length < total,
    endCursor: slice.length ? cursorFor('issue', slice[slice.length - 1].number) : null,
  };
}

function pullConnection(repo: RepoRec, args: Record<string, unknown>): Obj {
  let pulls = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? args.states.map(String) : null;
  if (states) {
    pulls = pulls.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
      return states.includes(state);
    });
  }
  pulls.sort((a, b) => b.number - a.number);
  const total = pulls.length;
  const afterNumber = numberFromCursor(args.after);
  let start = 0;
  if (afterNumber !== null) {
    const index = pulls.findIndex((pull) => pull.number === afterNumber);
    if (index !== -1) start = index + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : total;
  const slice = pulls.slice(start, start + first);
  const nodes: Obj[] = slice.map((pull) => ({ t: 'PullRequest', repo, pull }));
  return {
    t: 'PullRequestConnection',
    nodes,
    total,
    hasNext: start + slice.length < total,
    endCursor: slice.length ? cursorFor('pull', slice[slice.length - 1].number) : null,
  };
}

function pullState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state.toUpperCase();
}

function resolveField(obj: Obj | null, typeName: string, field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  if (field === '__typename') return typeName;

  if (typeName === 'Query') {
    switch (field) {
      case 'viewer':
        return { t: 'User' } satisfies Obj;
      case 'repository': {
        const repo = DB.repo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? ({ t: 'Repository', repo } satisfies Obj) : null;
      }
      case 'node': {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const repo = repoByDbId(parsed.nums[0]);
          return repo ? ({ t: 'Repository', repo } satisfies Obj) : null;
        }
        if (parsed.kind === 'Issue') {
          const found = findIssueByGlobalId(String(args.id));
          return found ? ({ t: 'Issue', repo: found.repo, issue: found.issue } satisfies Obj) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const found = findPullByGlobalId(String(args.id));
          return found ? ({ t: 'PullRequest', repo: found.repo, pull: found.pull } satisfies Obj) : null;
        }
        if (parsed.kind === 'User') return { t: 'User' } satisfies Obj;
        return null;
      }
      case '__type': {
        const name = String(args.name ?? '');
        if (name in OBJECT_FIELDS || name in ENUM_VALUES || ['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name)) {
          return { t: '__Type', name } satisfies Obj;
        }
        return null;
      }
      case '__schema':
        return { t: '__Type', name: '__Schema' } satisfies Obj;
      default:
        throw new GqlFieldError(`Cannot query field "${field}" on type "Query".`);
    }
  }

  if (typeName === 'Mutation') {
    const input = isRecord(args.input) ? args.input : {};
    switch (field) {
      case 'createIssue': {
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed && parsed.kind === 'Repository' ? repoByDbId(parsed.nums[0]) : undefined;
        if (!repo) throw new GqlFieldError('Repository not found.');
        const issue = createIssueRecord(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
        return { t: 'Payload', kind: 'CreateIssuePayload', repo, issue, clientMutationId: input.clientMutationId } satisfies Obj;
      }
      case 'closeIssue': {
        const found = findIssueByGlobalId(String(input.issueId ?? ''));
        if (!found) throw new GqlFieldError('Issue not found.');
        found.issue.state = 'closed';
        return { t: 'Payload', kind: 'CloseIssuePayload', repo: found.repo, issue: found.issue, clientMutationId: input.clientMutationId } satisfies Obj;
      }
      case 'createPullRequest': {
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed && parsed.kind === 'Repository' ? repoByDbId(parsed.nums[0]) : undefined;
        if (!repo) throw new GqlFieldError('Repository not found.');
        const headRefName = String(input.headRefName ?? '');
        const baseRefName = String(input.baseRefName ?? '');
        if (!repo.refs.has(`refs/heads/${headRefName}`)) throw new GqlFieldError(`Head branch "${headRefName}" does not exist.`);
        if (!repo.refs.has(`refs/heads/${baseRefName}`)) throw new GqlFieldError(`Base branch "${baseRefName}" does not exist.`);
        const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === headRefName && pull.baseRef === baseRefName);
        if (existing) throw new GqlFieldError('A pull request already exists for this branch combination.');
        const pull = createPullRecord(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', headRefName, baseRefName);
        return { t: 'Payload', kind: 'CreatePullRequestPayload', repo, pull, clientMutationId: input.clientMutationId } satisfies Obj;
      }
      case 'mergePullRequest': {
        const found = findPullByGlobalId(String(input.pullRequestId ?? ''));
        if (!found) throw new GqlFieldError('Pull request not found.');
        if (found.pull.merged) throw new GqlFieldError('Pull request is already merged.');
        const sha = squashMerge(found.repo, found.pull);
        if (!sha) throw new GqlFieldError('Pull Request is not mergeable.');
        return { t: 'Payload', kind: 'MergePullRequestPayload', repo: found.repo, pull: found.pull, clientMutationId: input.clientMutationId } satisfies Obj;
      }
      case 'addComment': {
        const found = findIssueByGlobalId(String(input.subjectId ?? ''));
        if (!found) throw new GqlFieldError('Subject not found.');
        const comment = { id: DB.nextCommentId(), body: String(input.body ?? ''), createdTs: nextTimestamp() };
        found.issue.comments.push({ id: comment.id, body: comment.body, createdTs: comment.createdTs });
        return { t: 'Payload', kind: 'AddCommentPayload', repo: found.repo, issue: found.issue, comment, clientMutationId: input.clientMutationId } satisfies Obj;
      }
      default:
        throw new GqlFieldError(`Cannot query field "${field}" on type "Mutation".`);
    }
  }

  if (obj === null) return null;

  switch (obj.t) {
    case 'User':
      switch (field) {
        case 'login': return VIEWER.login;
        case 'id': return globalId('User', VIEWER.id);
        case 'databaseId': return VIEWER.id;
        case 'name': return VIEWER.name;
        case 'email': return VIEWER.email;
        case 'url': return 'https://github.local/adaiversen';
        case 'createdAt': return isoOf(1_700_000_000);
        case 'updatedAt': return isoOf(1_700_000_000);
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "User".`);
      }
    case 'Repository': {
      const repo = obj.repo;
      switch (field) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { t: 'User' } satisfies Obj;
        case 'description': return repo.description;
        case 'isPrivate': return repo.priv;
        case 'isFork': return false;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasPullRequestsEnabled': return true;
        case 'defaultBranchRef': {
          const name = repo.defaultBranch;
          return repo.refs.has(`refs/heads/${name}`) ? ({ t: 'Ref', name } satisfies Obj) : null;
        }
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? ({ t: 'Issue', repo, issue } satisfies Obj) : null;
        }
        case 'issues': return issueConnection(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? ({ t: 'PullRequest', repo, pull } satisfies Obj) : null;
        }
        case 'pullRequests': return pullConnection(repo, args);
        case 'createdAt': return isoOf(repo.createdTs);
        case 'updatedAt': return isoOf(repo.createdTs);
        case 'url': return `https://github.local/${repo.owner}/${repo.name}`;
        case 'stargazerCount': return 0;
        case 'forkCount': return 0;
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "Repository".`);
      }
    }
    case 'Issue': {
      const issue = obj.issue;
      switch (field) {
        case 'id': return globalId('Issue', obj.repo.id, issue.number);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return { t: 'User' } satisfies Obj;
        case 'repository': return { t: 'Repository', repo: obj.repo } satisfies Obj;
        case 'labels': return { t: 'Nodes', nodes: issue.labels.map((name) => ({ t: 'Label', repo: obj.repo, name }) satisfies Obj) } satisfies Obj;
        case 'createdAt': return isoOf(issue.createdTs);
        case 'updatedAt': return isoOf(issue.updatedTs);
        case 'closedAt': return issue.state === 'closed' ? isoOf(issue.updatedTs) : null;
        case 'url': return `https://github.local/${obj.repo.owner}/${obj.repo.name}/issues/${issue.number}`;
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "Issue".`);
      }
    }
    case 'PullRequest': {
      const pull = obj.pull;
      switch (field) {
        case 'id': return globalId('PullRequest', obj.repo.id, pull.number);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'mergeable': return pull.merged || pull.state === 'closed' ? 'UNKNOWN' : pullMergeable(obj.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'author': return { t: 'User' } satisfies Obj;
        case 'repository': return { t: 'Repository', repo: obj.repo } satisfies Obj;
        case 'files': {
          const changes = pullFiles(obj.repo, pull);
          const first = typeof args.first === 'number' ? Math.trunc(args.first) : changes.length;
          return {
            t: 'Nodes',
            nodes: changes.slice(0, Math.max(0, first)).map((change) => ({
              t: 'ChangedFile',
              path: change.path,
              additions: change.additions,
              deletions: change.deletions,
              changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
            }) satisfies Obj),
          } satisfies Obj;
        }
        case 'additions': return pullFiles(obj.repo, pull).reduce((sum, change) => sum + change.additions, 0);
        case 'deletions': return pullFiles(obj.repo, pull).reduce((sum, change) => sum + change.deletions, 0);
        case 'changedFiles': return pullFiles(obj.repo, pull).length;
        case 'createdAt': return isoOf(pull.createdTs);
        case 'updatedAt': return isoOf(pull.updatedTs);
        case 'closedAt': return pull.state === 'closed' ? isoOf(pull.updatedTs) : null;
        case 'mergedAt': return pull.mergedAtTs !== null ? isoOf(pull.mergedAtTs) : null;
        case 'url': return `https://github.local/${obj.repo.owner}/${obj.repo.name}/pull/${pull.number}`;
        case 'isDraft': return false;
        case 'mergeCommit': return null;
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "PullRequest".`);
      }
    }
    case 'Label':
      switch (field) {
        case 'id': return globalId('Label', obj.repo.id, obj.name.length);
        case 'name': return obj.name;
        case 'color': return obj.repo.labels.get(obj.name)?.color ?? 'ededed';
        case 'description': return null;
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "Label".`);
      }
    case 'Ref':
      switch (field) {
        case 'name': return obj.name;
        case 'prefix': return 'refs/heads/';
        case 'target': return null;
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "Ref".`);
      }
    case 'IssueConnection':
    case 'PullRequestConnection':
      switch (field) {
        case 'nodes': return obj.nodes;
        case 'edges': return obj.nodes.map((node) => ({ t: 'Edge', node, cursor: obj.endCursor ?? '' }) satisfies Obj);
        case 'pageInfo': return { t: 'PageInfo', hasNext: obj.hasNext, endCursor: obj.endCursor } satisfies Obj;
        case 'totalCount': return obj.total;
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "${typeName}".`);
      }
    case 'Nodes':
      if (field === 'nodes') return obj.nodes;
      if (field === 'totalCount') return obj.nodes.length;
      throw new GqlFieldError(`Cannot query field "${field}" on type "${typeName}".`);
    case 'Edge':
      if (field === 'node') return obj.node;
      if (field === 'cursor') return obj.cursor;
      throw new GqlFieldError(`Cannot query field "${field}" on type "${typeName}".`);
    case 'PageInfo':
      switch (field) {
        case 'hasNextPage': return obj.hasNext;
        case 'hasPreviousPage': return false;
        case 'startCursor': return obj.endCursor;
        case 'endCursor': return obj.endCursor;
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "PageInfo".`);
      }
    case 'ChangedFile':
      switch (field) {
        case 'path': return obj.path;
        case 'additions': return obj.additions;
        case 'deletions': return obj.deletions;
        case 'changeType': return obj.changeType;
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "PullRequestChangedFile".`);
      }
    case '__Type':
      switch (field) {
        case 'name': return obj.name;
        case 'kind': return typeKind(obj.name);
        case 'description': return null;
        case 'fields': {
          const fields = OBJECT_FIELDS[obj.name];
          return fields ? fields.map((name) => ({ t: '__Field', name }) satisfies Obj) : null;
        }
        case 'enumValues': {
          const values = ENUM_VALUES[obj.name];
          return values ? values.map((name) => ({ t: '__EnumValue', name }) satisfies Obj) : null;
        }
        case 'possibleTypes': return null;
        case 'inputFields': return null;
        case 'ofType': return null;
        case 'specifiedByURL': return null;
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "__Type".`);
      }
    case '__Field':
      switch (field) {
        case 'name': return obj.name;
        case 'description': return null;
        case 'args': return [];
        case 'type': return { t: '__Type', name: 'String' } satisfies Obj;
        case 'isDeprecated': return false;
        case 'deprecationReason': return null;
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "__Field".`);
      }
    case '__EnumValue':
      switch (field) {
        case 'name': return obj.name;
        case 'description': return null;
        case 'isDeprecated': return false;
        case 'deprecationReason': return null;
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "__EnumValue".`);
      }
    case 'Payload':
      switch (field) {
        case 'issue': return obj.issue && obj.repo ? ({ t: 'Issue', repo: obj.repo, issue: obj.issue } satisfies Obj) : null;
        case 'pullRequest': return obj.pull && obj.repo ? ({ t: 'PullRequest', repo: obj.repo, pull: obj.pull } satisfies Obj) : null;
        case 'commentEdge': {
          if (!obj.comment) return null;
          const node: Obj = { t: 'IssueComment', id: obj.comment.id, body: obj.comment.body };
          return { t: 'Edge', node, cursor: '' } satisfies Obj;
        }
        case 'subject': return obj.issue && obj.repo ? ({ t: 'Issue', repo: obj.repo, issue: obj.issue } satisfies Obj) : null;
        case 'clientMutationId': return obj.clientMutationId ?? null;
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "${obj.kind}".`);
      }
    case 'IssueComment':
      switch (field) {
        case 'id': return globalId('IssueComment', obj.id);
        case 'databaseId': return obj.id;
        case 'body': return obj.body;
        case 'author': return { t: 'User' } satisfies Obj;
        case 'createdAt': return isoOf(1_763_000_000);
        case 'updatedAt': return isoOf(1_763_000_000);
        default: throw new GqlFieldError(`Cannot query field "${field}" on type "IssueComment".`);
      }
  }
}

function typeNameOf(obj: Obj | null, fallback: string): string {
  if (obj === null) return fallback;
  switch (obj.t) {
    case 'Payload': return obj.kind;
    case 'Nodes': return fallback;
    case 'Edge': return fallback;
    default: return obj.t;
  }
}

function executeSelection(obj: Obj | null, typeName: string, selections: SelectionNode[], doc: DocumentNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      const runtimeType = typeNameOf(obj, typeName);
      if (selection.typeCondition === runtimeType || selection.typeCondition === 'Node' || selection.typeCondition === typeName) {
        Object.assign(out, executeSelection(obj, selection.typeCondition === 'Node' ? runtimeType : selection.typeCondition, selection.selection, doc, ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment) {
        const runtimeType = typeNameOf(obj, typeName);
        if (fragment.typeCondition === runtimeType || fragment.typeCondition === 'Node') {
          Object.assign(out, executeSelection(obj, fragment.typeCondition, fragment.selection, doc, ctx));
        }
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const args: Record<string, unknown> = {};
    for (const [argName, valueNode] of Object.entries(field.args)) args[argName] = evalValue(valueNode, ctx.variables);
    let value: unknown;
    try {
      value = resolveField(obj, typeName, field.name, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, field, doc, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, doc: DocumentNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, doc, ctx));
  if (typeof value === 'object') {
    const obj = value as Obj;
    if (!field.selection) return null;
    const childType = typeNameOf(obj, field.name);
    return executeSelection(obj, childType, field.selection, doc, ctx);
  }
  return value;
}

function executeOperation(operation: OperationNode, doc: DocumentNode, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const ctx: Ctx = { variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(null, rootType, operation.selection, doc, ctx);
  return ctx.errors.length ? { data, errors: ctx.errors } : { data };
}

/** The /api/graphql handler. */
export function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = jsonBody(body);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): { data: unknown; errors?: Array<{ message: string }> } => {
    if (!isRecord(entry) || typeof entry.query !== 'string') return { data: null, errors: [{ message: 'A query document is required.' }] };
    try {
      const doc = new Parser(tokenize(entry.query)).parseDocument();
      const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
      const operation = doc.operations.find((candidate) => operationName === undefined || candidate.name === operationName) ?? doc.operations[0];
      if (!operation) return { data: null, errors: [{ message: 'No operation in the document.' }] };
      const variables = isRecord(entry.variables) ? entry.variables : {};
      return executeOperation(operation, doc, variables);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}
