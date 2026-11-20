// Git smart HTTP: info/refs advertisements (protocol v2 for upload-pack when asked, v0 otherwise),
// v2 ls-refs and fetch, v0 fetch, and receive-pack with per-ref report-status. Objects live in the
// shared store (store.ts); packs are written without deltas and read with full delta resolution.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  DB,
  ZERO_OID,
  isAncestor,
  parseCommit,
  parseTag,
  peelToCommit,
  type GitObj,
  type ObjType,
  type RepoRec,
} from './store.ts';

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const AGENT = 'github-core-clone/1.0';

// -------------------------------------------------------------------------------------------------
// pkt-lines

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktLine {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Parse a pkt-line stream; throws on malformed framing (callers turn that into a 400). */
export function parsePkts(buffer: Buffer, offset = 0): { lines: PktLine[]; rest: number } {
  const lines: PktLine[] = [];
  let pos = offset;
  while (pos + 4 <= buffer.length) {
    const hex = buffer.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      lines.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      return { lines, rest: pos };
    }
    if (length === 1) {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      lines.push({ kind: 'data', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buffer.length) throw new Error('pkt-line overruns the body');
    lines.push({ kind: 'data', payload: buffer.subarray(pos + 4, pos + length) });
    pos += length;
  }
  if (pos !== buffer.length) throw new Error('trailing bytes after the pkt-line stream');
  return { lines, rest: pos };
}

// -------------------------------------------------------------------------------------------------
// Packfiles

export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const data = object.data;
    const code = TYPE_CODES[object.type];
    const bytes: number[] = [];
    let remaining = data.length;
    let first = (code << 4) | (remaining & 0x0f);
    remaining = Math.floor(remaining / 16);
    while (remaining > 0) {
      bytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate one entry starting at `pos`, and find how many bytes its zlib stream occupies:
 * inflateSync ignores trailing bytes, so success is monotonic in the prefix length and the
 * stream's exact length is a binary search away.
 */
function inflateEntry(buffer: Buffer, pos: number): { data: Buffer; consumed: number } {
  const rest = buffer.subarray(pos);
  const data = inflateSync(rest);
  let lo = 1;
  let hi = rest.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(rest.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data, consumed: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos]; pos += 1; }
      if (op & 0x02) { offset |= delta[pos] << 8; pos += 1; }
      if (op & 0x04) { offset |= delta[pos] << 16; pos += 1; }
      if (op & 0x08) { offset |= delta[pos] << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos]; pos += 1; }
      if (op & 0x20) { size |= delta[pos] << 8; pos += 1; }
      if (op & 0x40) { size |= delta[pos] << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || written !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  type: ObjType;
  data: Buffer;
}

/** Read a whole packfile into the object store. Throws on any structural problem. */
export function readPackIntoStore(pack: Buffer): number {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const count = pack.readUInt32BE(8);
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  const trailer = pack.subarray(pack.length - 20);
  if (!expected.equals(trailer)) throw new Error('pack checksum mismatch');
  let pos = 12;
  const pending: Array<{ baseOid?: string; baseOffset?: number; delta: Buffer }> = [];
  const byOffset = new Map<number, PackEntry>();
  const entries: PackEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = pos;
    let byte = pack[pos];
    pos += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (code === 6) {
      let b = pack[pos];
      pos += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - offset;
    } else if (code === 7) {
      baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const { data, consumed } = inflateEntry(pack, pos);
    pos += consumed;
    if (data.length !== size && code !== 6 && code !== 7) throw new Error('pack entry size mismatch');
    if (code === 6 || code === 7) {
      pending.push({ baseOid, baseOffset, delta: data });
      byOffset.set(entryOffset, { type: 'blob', data: Buffer.alloc(0) });
    } else {
      const type = CODE_TYPES[code];
      if (!type) throw new Error(`unknown pack object type ${code}`);
      const entry = { type, data };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    }
  }
  const resolveBase = (baseOid?: string, baseOffset?: number): PackEntry => {
    if (baseOffset !== undefined) {
      const found = byOffset.get(baseOffset);
      if (found && found.data.length > 0) return found;
      throw new Error('delta base not in pack');
    }
    if (baseOid !== undefined) {
      const found = DB.objects.get(baseOid);
      if (found) return found;
      throw new Error('delta base not available');
    }
    throw new Error('delta without a base');
  };
  for (const item of pending) {
    const base = resolveBase(item.baseOid, item.baseOffset);
    const data = applyDelta(base.data, item.delta);
    entries.push({ type: base.type, data });
  }
  for (const entry of entries) DB.objects.put(entry.type, entry.data);
  return entries.length;
}

// -------------------------------------------------------------------------------------------------
// Reachability for fetch

interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch must carry: the closure of `wants`, minus what the client already holds
 * (the closure of `haves`, stopping at the client's shallow boundary), optionally cut to `depth`
 * commit generations from the wants.
 */
export function planFetch(wants: readonly string[], haves: readonly string[], clientShallow: readonly string[], depth: number | null): FetchPlan {
  const store = DB.objects;
  const shallowSet = new Set(clientShallow);

  // Exclusion: everything reachable from the haves, without crossing the client's shallow commits.
  const excluded = new Set<string>();
  const excludeStack = [...haves];
  while (excludeStack.length) {
    const oid = excludeStack.pop()!;
    if (excluded.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    excluded.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      const treeStack = [info.tree];
      while (treeStack.length) {
        const treeOid = treeStack.pop()!;
        if (excluded.has(treeOid)) continue;
        const treeObj = store.get(treeOid);
        if (!treeObj || treeObj.type !== 'tree') continue;
        excluded.add(treeOid);
        for (const entry of parseTreeEntries(treeObj.data)) {
          if (entry.mode === '40000') treeStack.push(entry.oid);
          else excluded.add(entry.oid);
        }
      }
      if (!shallowSet.has(oid)) for (const parent of info.parents) excludeStack.push(parent);
    } else if (obj.type === 'tag') {
      excludeStack.push(parseTag(obj.data).object);
    }
  }

  // Inclusion: BFS by commit generation when a depth is set, full closure otherwise.
  const included = new Set<string>();
  const boundary = new Set<string>();
  const includeObject = (oid: string): void => {
    if (included.has(oid)) return;
    const obj = store.get(oid);
    if (!obj) return;
    included.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTreeEntries(obj.data)) includeObject(entry.oid);
    }
  };
  const includeCommitTree = (commitOid: string): void => {
    const obj = store.get(commitOid);
    if (!obj || obj.type !== 'commit') return;
    includeObject(parseCommit(obj.data).tree);
  };

  if (depth === null) {
    const stack = [...wants];
    while (stack.length) {
      const oid = stack.pop()!;
      if (included.has(oid)) continue;
      const obj = store.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        included.add(oid);
        includeObject(parseCommit(obj.data).tree);
        for (const parent of parseCommit(obj.data).parents) stack.push(parent);
      } else if (obj.type === 'tag') {
        included.add(oid);
        stack.push(parseTag(obj.data).object);
      } else {
        includeObject(oid);
      }
    }
  } else {
    const generations = new Map<string, number>();
    const queue: string[] = [];
    for (const want of wants) {
      const commit = peelToCommit(store, want);
      if (want !== commit && store.has(want)) included.add(want);
      if (commit && !generations.has(commit)) {
        generations.set(commit, 1);
        queue.push(commit);
      }
    }
    while (queue.length) {
      const oid = queue.shift()!;
      const generation = generations.get(oid)!;
      const obj = store.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      included.add(oid);
      includeCommitTree(oid);
      const info = parseCommit(obj.data);
      if (generation >= depth) {
        if (info.parents.length) boundary.add(oid);
        continue;
      }
      for (const parent of info.parents) {
        if (!generations.has(parent)) {
          generations.set(parent, generation + 1);
          queue.push(parent);
        }
      }
    }
  }

  const send = [...included].filter((oid) => !excluded.has(oid));
  const objects: GitObj[] = [];
  for (const oid of send) {
    const obj = store.get(oid);
    if (obj) objects.push(obj);
  }
  const shallow = [...boundary].filter((oid) => included.has(oid));
  const unshallow = clientShallow.filter((oid) => included.has(oid) && !boundary.has(oid));
  return { objects, shallow, unshallow };
}

function parseTreeEntries(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    entries.push({ mode, name: data.toString('utf8', space + 1, nul), oid: data.toString('hex', nul + 1, nul + 21) });
    pos = nul + 21;
  }
  return entries;
}

// -------------------------------------------------------------------------------------------------
// Advertisements and ref listing

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function peeledOf(oid: string): string | null {
  const obj = DB.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return peelToCommit(DB.objects, oid);
}

export function advertisementV2(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pkt(line)), PKT_FLUSH]);
}

export function advertisementV0(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k ofs-delta thin-pack shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const emit = (oid: string, name: string): void => {
      parts.push(pkt(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
    };
    if (headTip) emit(headTip, 'HEAD');
    for (const [name, oid] of refs) {
      emit(oid, name);
      const peeled = peeledOf(oid);
      if (peeled) parts.push(pkt(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 ls-refs response for the parsed argument lines. */
export function lsRefsResponse(repo: RepoRec, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  if (prefixes.length === 0) {
    const headRef = `refs/heads/${repo.defaultBranch}`;
    const tip = repo.refs.get(headRef);
    if (tip) {
      parts.push(pkt(`${tip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// Fetch / push request handling

function sidebandChunks(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(pkt(Buffer.from([1])));
  return parts;
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

export function fetchResponseV2(request: FetchRequest): Buffer {
  const plan = planFetch(request.wants, request.haves, request.shallow, request.depth);
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  const acks = request.haves.filter((have) => DB.objects.has(have));
  if (acks.length === 0) parts.push(pkt('NAK\n'));
  else for (const ack of acks) parts.push(pkt(`ACK ${ack}\n`));
  parts.push(PKT_DELIM);
  if (request.depth !== null || request.shallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pkt('packfile\n'));
  parts.push(...sidebandChunks(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function fetchResponseV0(request: FetchRequest): Buffer {
  const plan = planFetch(request.wants, request.haves, request.shallow, request.depth);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  parts.push(...sidebandChunks(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Apply a receive-pack request; returns the report-status lines (without framing). */
export async function applyPush(repo: RepoRec, commands: readonly PushCommand[], pack: Buffer): Promise<string[]> {
  let unpackLine = 'unpack ok';
  const hasPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (pack.length > 0) {
    try {
      readPackIntoStore(pack);
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'error'}`;
    }
  } else if (hasPack) {
    unpackLine = 'unpack no packfile given';
  }
  const lines: string[] = [unpackLine];
  const unpackOk = unpackLine === 'unpack ok';
  for (const command of commands) {
    const fail = (reason: string): void => {
      lines.push(`ng ${command.ref} ${reason}`);
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) {
        fail('reference does not exist');
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        fail('old value mismatch');
        continue;
      }
      repo.refs.delete(command.ref);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    const newObj = DB.objects.get(command.newOid);
    if (!newObj) {
      fail('unknown object');
      continue;
    }
    if (current === ZERO_OID) {
      if (command.oldOid !== ZERO_OID) {
        fail('reference does not exist');
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    if (command.oldOid !== current) {
      fail('old value mismatch');
      continue;
    }
    if (current === command.newOid) {
      lines.push(`ok ${command.ref}`);
      continue;
    }
    // Update: commits must fast-forward; tags and other objects may move to a new object of their kind.
    const currentCommit = peelToCommit(DB.objects, current);
    const newCommit = peelToCommit(DB.objects, command.newOid);
    if (currentCommit && newCommit) {
      if (!isAncestor(DB.objects, currentCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  return lines;
}

/** Frame report-status lines for the client that asked for side-band-64k (or not). */
export function pushReportResponse(lines: readonly string[], sideband: boolean): Buffer {
  const stream = Buffer.concat([...lines.map((line) => pkt(`${line}\n`)), PKT_FLUSH]);
  if (!sideband) return stream;
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < stream.length; offset += CHUNK) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), stream.subarray(offset, Math.min(stream.length, offset + CHUNK))])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Parse a v2 command request body into argument lines grouped by command. Throws on bad framing. */
export function parseV2Command(body: Buffer): { command: string; args: string[]; requestLines: string[] } {
  const { lines } = parsePkts(body);
  const texts: string[] = [];
  let sawDelim = false;
  const args: string[] = [];
  const requestLines: string[] = [];
  for (const line of lines) {
    if (line.kind === 'flush') break;
    if (line.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    texts.push(text);
    if (!sawDelim) args.push(text);
    else requestLines.push(text);
  }
  const commandLine = texts.find((text) => text.startsWith('command='));
  if (!commandLine) throw new Error('no command in the v2 request');
  return { command: commandLine.slice('command='.length), args, requestLines };
}

/** Parse a v0 fetch body. Throws on bad framing. */
export function parseV0Fetch(body: Buffer): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let pos = 0;
  let section = 0;
  while (pos < body.length) {
    const { lines, rest } = parsePkts(body, pos);
    pos = rest;
    for (const line of lines) {
      if (line.kind === 'flush') {
        section += 1;
        continue;
      }
      if (line.kind !== 'data') continue;
      const text = line.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) {
        if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
        else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
      } else if (text.startsWith('have ')) {
        haves.push(text.slice(5).trim());
      }
    }
    if (section >= 2) break;
  }
  return { wants, haves, shallow, depth };
}

/** Parse a receive-pack body into commands plus the trailing pack bytes. Throws on bad framing. */
export function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer; capabilities: string[] } {
  const commands: PushCommand[] = [];
  const capabilities: string[] = [];
  let pos = 0;
  for (;;) {
    if (pos + 4 > body.length) throw new Error('receive-pack body ended mid-command');
    const hex = body.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line in receive-pack commands');
    const length = parseInt(hex, 16);
    if (length === 0) {
      pos += 4;
      break;
    }
    if (length < 4 || pos + length > body.length) throw new Error('receive-pack command overruns the body');
    let text = body.toString('utf8', pos + 4, pos + length).replace(/\n$/, '');
    pos += length;
    const nul = text.indexOf('\0');
    if (nul !== -1) {
      for (const cap of text.slice(nul + 1).split(' ')) if (cap) capabilities.push(cap);
      text = text.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (!match) throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  return { commands, pack: body.subarray(pos), capabilities };
}
