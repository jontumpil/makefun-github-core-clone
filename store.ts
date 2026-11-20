// The forge's store: one content-addressed git object store shared by every repository, plus the
// repository records (refs, labels, issues, pull requests) the REST, GraphQL and MCP surfaces all
// read and write. Everything is in memory; a trial starts from an empty forge.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

export class ObjectStore {
  readonly map = new Map<string, GitObj>();

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.map.has(oid)) this.map.set(oid, { type, data });
    return oid;
  }

  putKnown(oid: string, type: ObjType, data: Buffer): void {
    if (!this.map.has(oid)) this.map.set(oid, { type, data });
  }

  get(oid: string): GitObj | undefined {
    return this.map.get(oid);
  }

  has(oid: string): boolean {
    return this.map.has(oid);
  }
}

// -------------------------------------------------------------------------------------------------
// Commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Committer timestamp, seconds (0 when unparsable). */
  timestamp: number;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const match = / (\d+) [+-]\d{4}$/.exec(committer);
  return { tree, parents, author, committer, message, timestamp: match ? Number(match[1]) : 0 };
}

export function buildCommit(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${author}\ncommitter ${committer}\n`;
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${head}\n${body}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every blob under a tree, as path -> {oid, mode}. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = store.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> blob oid map; returns the root tree oid. */
export function buildTreeFromFiles(store: ObjectStore, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Dir {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const segments = path.split('/');
    let dir = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      let next = dir.dirs.get(segments[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segments[i], next);
      }
      dir = next;
    }
    dir.files.set(segments[segments.length - 1], file);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return store.put('tree', buildTree(entries));
  };
  return emit(root);
}

/** The tree oid of a commit, or null. */
export function commitTree(store: ObjectStore, commitOid: string): string | null {
  const obj = store.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Peel tags until a commit; returns the commit oid or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const obj = store.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Every ancestor commit of `tip` (including itself), as a set. */
export function ancestorSet(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  return ancestorSet(store, descendant).has(ancestor);
}

/** A commit both histories share: walk `a`'s history newest-first until one is an ancestor of `b`. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const bAncestors = ancestorSet(store, b);
  const ordered = walkCommits(store, a);
  for (const entry of ordered) if (bAncestors.has(entry.oid)) return entry.oid;
  return null;
}

export interface WalkedCommit {
  oid: string;
  info: CommitInfo;
}

/** git-log order: newest first (by committer timestamp, ties keep discovery order). */
export function walkCommits(store: ObjectStore, tip: string): WalkedCommit[] {
  const seen = new Map<string, CommitInfo>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    seen.set(oid, info);
    for (const parent of info.parents) stack.push(parent);
  }
  return [...seen.entries()]
    .map(([oid, info]) => ({ oid, info }))
    .sort((x, y) => y.info.timestamp - x.info.timestamp);
}

// -------------------------------------------------------------------------------------------------
// The forge database

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.com',
} as const;

/** A deterministic in-process clock: fixed anchor + a counter, so ordering never depends on wall time. */
let clockSeq = 0;
const CLOCK_ANCHOR = 1_763_000_000;

export function nextTimestamp(): number {
  clockSeq += 1;
  return CLOCK_ANCHOR + clockSeq;
}

export function isoOf(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toISOString();
}

export function authorLine(timestamp: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${timestamp} +0000`;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdTs: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdTs: number;
  updatedTs: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAtTs: number | null;
  mergeCommitSha: string | null;
  createdTs: number;
  updatedTs: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  createdTs: number;
}

export class Forge {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;

  createRepo(name: string, description: string, priv: boolean): RepoRec {
    this.repoSeq += 1;
    const repo: RepoRec = {
      id: this.repoSeq,
      owner: VIEWER.login,
      name,
      description,
      priv,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdTs: nextTimestamp(),
    };
    this.repos.set(repoKey(repo.owner, name), repo);
    return repo;
  }

  repo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return 10_000 + this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return 500_000 + this.commentSeq;
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

// -------------------------------------------------------------------------------------------------
// Relay-style global ids (GraphQL `id` fields and REST `node_id`s): opaque, stable, reversible.

export function globalId(kind: string, ...nums: number[]): string {
  return Buffer.from(`${kind}:${nums.join(':')}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; nums: number[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0];
    const nums = parts.slice(1).map((part) => Number(part));
    if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
    return { kind, nums };
  } catch {
    return null;
  }
}

export const DB = new Forge();

/** Resolve a branch name, full ref, HEAD or commit sha to an oid inside a repo. */
export function resolveRef(repo: RepoRec, ref: string): string | null {
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag) return tag;
  if (/^[0-9a-f]{40}$/.test(ref) && DB.objects.has(ref)) return ref;
  return null;
}

// -------------------------------------------------------------------------------------------------
// File-level diff and three-way merge over trees

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const lcs = dp[b.length];
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

function blobText(store: ObjectStore, oid: string | undefined): string {
  if (!oid) return '';
  const obj = store.get(oid);
  return obj && obj.type === 'blob' ? obj.data.toString('utf8') : '';
}

/** The changed paths between two trees, with line counts. */
export function diffTrees(store: ObjectStore, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = baseTree ? flattenTree(store, baseTree) : new Map<string, { oid: string; mode: string }>();
  const head = headTree ? flattenTree(store, headTree) : new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.oid === h.oid) continue;
    if (!b && h) {
      changes.push({ path, status: 'added', ...lineDiffCounts('', blobText(store, h.oid)) });
    } else if (b && !h) {
      changes.push({ path, status: 'removed', ...lineDiffCounts(blobText(store, b.oid), '') });
    } else if (b && h) {
      changes.push({ path, status: 'modified', ...lineDiffCounts(blobText(store, b.oid), blobText(store, h.oid)) });
    }
  }
  return changes;
}

/**
 * File-level three-way merge of flattened trees. Returns the merged flat map, or null on a conflict
 * (a path both sides changed differently, or changed on one side and deleted on the other).
 */
export function threeWayMergeFiles(
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  ours: ReadonlyMap<string, { oid: string; mode: string }>,
  theirs: ReadonlyMap<string, { oid: string; mode: string }>,
): Map<string, { oid: string; mode: string }> | null {
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, { oid: string; mode: string }>();
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }) => (x?.oid ?? null) === (y?.oid ?? null);
    if (same(o, t)) {
      if (o) merged.set(path, o);
    } else if (same(b, o)) {
      if (t) merged.set(path, t);
    } else if (same(b, t)) {
      if (o) merged.set(path, o);
    } else {
      return null;
    }
  }
  return merged;
}

/** Whether a pull request's head merges cleanly into its base right now. */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  const store = DB.objects;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return false;
  const base = mergeBase(store, baseTip, headTip);
  if (!base) return false;
  if (base === headTip) return true;
  const baseTree = commitTree(store, base);
  const oursTree = commitTree(store, baseTip);
  const theirsTree = commitTree(store, headTip);
  if (!baseTree || !oursTree || !theirsTree) return false;
  return threeWayMergeFiles(flattenTree(store, baseTree), flattenTree(store, oursTree), flattenTree(store, theirsTree)) !== null;
}

/**
 * Squash-merge a pull request: one new commit on the base branch carrying the three-way merged
 * tree. Returns the merge commit oid, or null when the merge conflicts.
 */
export function squashMerge(repo: RepoRec, pull: PullRec): string | null {
  const store = DB.objects;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return null;
  const base = mergeBase(store, baseTip, headTip);
  if (!base) return null;
  const baseTree = commitTree(store, base);
  const oursTree = commitTree(store, baseTip);
  const theirsTree = commitTree(store, headTip);
  if (!baseTree || !oursTree || !theirsTree) return null;
  const mergedFiles = threeWayMergeFiles(flattenTree(store, baseTree), flattenTree(store, oursTree), flattenTree(store, theirsTree));
  if (mergedFiles === null) return null;
  const tree = buildTreeFromFiles(store, mergedFiles);
  const ts = nextTimestamp();
  const line = authorLine(ts);
  const message = `${pull.title} (#${pull.number})${pull.body ? `\n\n${pull.body}` : ''}`;
  const commit = store.put('commit', buildCommit(tree, [baseTip], line, line, message));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAtTs = ts;
  pull.mergeCommitSha = commit;
  pull.updatedTs = ts;
  return commit;
}

/** The files a pull request changes: merge-base tree versus head tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
  const store = DB.objects;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!headTip) return [];
  const headTree = commitTree(store, headTip);
  if (!baseTip) return diffTrees(store, null, headTree);
  const base = mergeBase(store, baseTip, headTip) ?? baseTip;
  return diffTrees(store, commitTree(store, base), headTree);
}

/** Commit a file map change on a branch: set `path` to `blobOid` (or delete it when null). */
export function commitFileChange(repo: RepoRec, branch: string, path: string, blobOid: string | null, message: string, baseTip?: string): string {
  const store = DB.objects;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? baseTip;
  const tipTree = tip ? commitTree(store, tip) : null;
  const files = tipTree ? flattenTree(store, tipTree) : new Map<string, { oid: string; mode: string }>();
  if (blobOid === null) files.delete(path);
  else files.set(path, { oid: blobOid, mode: '100644' });
  const tree = buildTreeFromFiles(store, files);
  const ts = nextTimestamp();
  const line = authorLine(ts);
  const commit = store.put('commit', buildCommit(tree, tip ? [tip] : [], line, line, message));
  repo.refs.set(ref, commit);
  return commit;
}
