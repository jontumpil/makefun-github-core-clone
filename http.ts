// Shared HTTP plumbing for the entry's surfaces: JSON replies with the request-id header every
// REST answer must carry, the bearer-token check, and request body parsing.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

export function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(36)}-${Date.now().toString(36)}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...(text ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  res.end(text);
}

export function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

/** The token the harness issued, when the process was given one. Empty means auth is not enforced. */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

export function isAuthed(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  return header === `Bearer ${token}` || header === `token ${token}`;
}

/** Parse a JSON request body; returns undefined for an empty body, throws on malformed JSON. */
export function jsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return undefined;
  return JSON.parse(text) as unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function hostOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return typeof host === 'string' && host !== '' ? host : '127.0.0.1';
}
