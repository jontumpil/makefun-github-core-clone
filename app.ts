// The entry's HTTP server: a health probe, then the four scored surfaces — git smart HTTP under
// /<owner>/<repo>.git, REST v3 under /api/v3, GraphQL at /api/graphql and MCP at /mcp — over one
// shared in-memory store (store.ts). main.ts owns the lifecycle; this file only routes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DB } from './store.ts';
import { sendJson, sendRaw } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertisementV0,
  advertisementV2,
  applyPush,
  fetchResponseV0,
  fetchResponseV2,
  lsRefsResponse,
  parsePushBody,
  parseV0Fetch,
  parseV2Command,
  pushReportResponse,
  type FetchRequest,
} from './gitproto.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<void> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!match) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const service = match[3];
  const repo = DB.repo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (service === 'info/refs' && req.method === 'GET') {
    const wanted = url.searchParams.get('service');
    if (wanted === 'git-upload-pack') {
      const protocol = req.headers['git-protocol'];
      if (typeof protocol === 'string' && protocol.includes('version=2')) {
        sendRaw(res, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendRaw(res, 200, advertisementV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      }
      return;
    }
    if (wanted === 'git-receive-pack') {
      sendRaw(res, 200, advertisementV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendJson(res, 400, { message: 'Unknown service' });
    return;
  }

  if (service === 'git-upload-pack' && req.method === 'POST') {
    try {
      const protocol = req.headers['git-protocol'];
      if (typeof protocol === 'string' && protocol.includes('version=2')) {
        const { command, args, requestLines } = parseV2Command(body);
        if (command === 'ls-refs') {
          // ls-refs arguments (peel, symrefs, ref-prefix, ...) travel after the delimiter pkt-line.
          sendRaw(res, 200, lsRefsResponse(repo, [...args, ...requestLines]), 'application/x-git-upload-pack-result');
          return;
        }
        if (command === 'fetch') {
          const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
          for (const line of requestLines) {
            if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
            else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
            else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
            else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
          }
          sendRaw(res, 200, fetchResponseV2(request), 'application/x-git-upload-pack-result');
          return;
        }
        sendRaw(res, 400, Buffer.from(`unsupported command ${command}\n`), 'text/plain');
        return;
      }
      const request = parseV0Fetch(body);
      sendRaw(res, 200, fetchResponseV0(request), 'application/x-git-upload-pack-result');
      return;
    } catch (err) {
      sendRaw(res, 400, Buffer.from(`bad upload-pack request: ${err instanceof Error ? err.message : 'error'}\n`), 'text/plain');
      return;
    }
  }

  if (service === 'git-receive-pack' && req.method === 'POST') {
    try {
      const { commands, pack, capabilities } = parsePushBody(body);
      const lines = await applyPush(repo, commands, pack);
      const sideband = capabilities.includes('side-band-64k');
      sendRaw(res, 200, pushReportResponse(lines, sideband), 'application/x-git-receive-pack-result');
      return;
    } catch (err) {
      sendRaw(res, 400, Buffer.from(`bad receive-pack request: ${err instanceof Error ? err.message : 'error'}\n`), 'text/plain');
      return;
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    handleRest(req, res, url, body);
    return;
  }
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    handleGraphQL(req, res, body);
    return;
  }
  if (path === '/mcp') {
    handleMcp(req, res, body);
    return;
  }
  if (path.endsWith('.git/info/refs') || path.endsWith('.git/git-upload-pack') || path.endsWith('.git/git-receive-pack')) {
    await handleGit(req, res, url, body);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    dispatch(req, res).catch((err: unknown) => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: `Internal error: ${err instanceof Error ? err.message : 'unknown'}` });
        else res.end();
      } catch {
        // The connection is already gone; nothing more to do.
      }
    });
  });
}
