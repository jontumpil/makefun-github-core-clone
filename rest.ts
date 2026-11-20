// The REST v3 surface under /api/v3: repositories, branches, git refs, commits, contents, labels,
// issues, comments and pull requests (with squash merges), all over the shared store. Every reply
// is JSON with an X-GitHub-Request-Id; errors are {message} bodies with GitHub's statuses.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DB,
  VIEWER,
  authorLine,
  buildCommit,
  buildTreeFromFiles,
  commitFileChange,
  commitTree,
  flattenTree,
  globalId,
  isoOf,
  mergeBase,
  nextTimestamp,
  parseCommit,
  parseTree,
  pullFiles,
  resolveRef,
  squashMerge,
  threeWayMergeFiles,
  walkCommits,
  type CommentRec,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { hostOf, isAuthed, isRecord, jsonBody, sendEmpty, sendJson, str } from './http.ts';

type Json = Record<string, unknown>;

const NOT_FOUND: Json = { message: 'Not Found' };

// -------------------------------------------------------------------------------------------------
// Serializers

export function userJson(): Json {
  return { login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', VIEWER.id), type: 'User', name: VIEWER.name, email: VIEWER.email };
}

export function repoJson(repo: RepoRec): Json {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.priv,
    owner: { login: repo.owner, id: VIEWER.id, node_id: globalId('User', VIEWER.id), type: 'User' },
    html_url: `https://github.local/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    created_at: isoOf(repo.createdTs),
    updated_at: isoOf(repo.createdTs),
    pushed_at: isoOf(repo.createdTs),
    default_branch: repo.defaultBranch,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length +
      [...repo.pulls.values()].filter((pull) => pull.state === 'open').length,
  };
}

function labelJson(repo: RepoRec, name: string): Json {
  const label = repo.labels.get(name);
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return { id: hash, node_id: globalId('Label', repo.id, hash), name, color: label?.color ?? 'ededed', description: null, default: false };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Json {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: issue.labels.map((name) => labelJson(repo, name)),
    state: issue.state,
    locked: false,
    comments: issue.comments.length,
    created_at: isoOf(issue.createdTs),
    updated_at: isoOf(issue.updatedTs),
    closed_at: issue.state === 'closed' ? isoOf(issue.updatedTs) : null,
    html_url: `https://github.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(comment: CommentRec): Json {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoOf(comment.createdTs),
    updated_at: isoOf(comment.createdTs),
    html_url: 'https://github.local/comment',
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Json {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoOf(pull.createdTs),
    updated_at: isoOf(pull.updatedTs),
    closed_at: pull.state === 'closed' ? isoOf(pull.updatedTs) : null,
    merged_at: pull.mergedAtTs !== null ? isoOf(pull.mergedAtTs) : null,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    draft: false,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha },
    html_url: `https://github.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitJson(oid: string): Json {
  const obj = DB.objects.get(oid);
  const info = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const person = (line: string): Json => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (!match) return { name: '', email: '', date: isoOf(0) };
    return { name: match[1], email: match[2], date: isoOf(Number(match[3])) };
  };
  return {
    sha: oid,
    node_id: globalId('Commit', 0),
    commit: {
      author: info ? person(info.author) : { name: '', email: '', date: isoOf(0) },
      committer: info ? person(info.committer) : { name: '', email: '', date: isoOf(0) },
      message: info ? info.message.replace(/\n$/, '') : '',
      tree: { sha: info?.tree ?? '' },
      comment_count: 0,
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

// -------------------------------------------------------------------------------------------------
// Small helpers

interface Page {
  page: number;
  perPage: number;
}

function pageOf(url: URL): Page {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1,
  };
}

function paginate<T>(res: ServerResponse, req: IncomingMessage, url: URL, items: readonly T[], page: Page): T[] {
  const totalPages = Math.max(1, Math.ceil(items.length / page.perPage));
  const slice = items.slice((page.page - 1) * page.perPage, page.page * page.perPage);
  const base = `http://${hostOf(req)}${url.pathname}`;
  const link = (target: number, rel: string): string => `<${base}?page=${target}&per_page=${page.perPage}>; rel="${rel}"`;
  const links: string[] = [];
  if (page.page < totalPages) links.push(link(page.page + 1, 'next'), link(totalPages, 'last'));
  if (page.page > 1) links.push(link(1, 'first'), link(page.page - 1, 'prev'));
  if (links.length) res.setHeader('link', links.join(', '));
  return slice;
}

function fail(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Create-or-validate helpers shared by the routes and (through their own wrappers) other surfaces. */
export function createIssueRecord(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
  const stamp = nextTimestamp();
  const issue: IssueRec = {
    id: DB.nextIssueId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdTs: stamp,
    updatedTs: stamp,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPullRecord(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
  const stamp = nextTimestamp();
  const pull: PullRec = {
    id: DB.nextIssueId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    merged: false,
    mergedAtTs: null,
    mergeCommitSha: null,
    createdTs: stamp,
    updatedTs: stamp,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

// -------------------------------------------------------------------------------------------------
// Route handlers

function handleRoot(res: ServerResponse): void {
  sendJson(
    res,
    200,
    {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
      rate_limit_url: '/api/v3/rate_limit',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function handleCreateRepo(res: ServerResponse, body: unknown): void {
  if (!isRecord(body)) return fail(res, 422, 'Validation Failed: name is required');
  const name = str(body.name);
  if (!name) return fail(res, 422, 'Validation Failed: name is required');
  if (DB.repo(VIEWER.login, name)) {
    sendJson(res, 422, {
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
    return;
  }
  const repo = DB.createRepo(name, str(body.description) ?? '', body.private !== false);
  sendJson(res, 201, repoJson(repo));
}

function handleContents(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, method: string, path: string, body: unknown): void {
  const store = DB.objects;
  if (method === 'GET') {
    const refName = url.searchParams.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, refName);
    if (!tip) return fail(res, 404, 'Not Found');
    const tree = commitTree(store, tip);
    if (!tree) return fail(res, 404, 'Not Found');
    const files = flattenTree(store, tree);
    if (path === '') {
      return sendDirListing(res, store, tree, '');
    }
    const file = files.get(path);
    if (file) {
      const blob = store.get(file.oid);
      if (!blob) return fail(res, 404, 'Not Found');
      sendJson(res, 200, {
        name: path.split('/').pop(),
        path,
        sha: file.oid,
        size: blob.data.length,
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
      });
      return;
    }
    // A directory? Walk the tree to the prefix.
    const dirTree = findDirTree(store, tree, path);
    if (dirTree) return sendDirListing(res, store, dirTree, path);
    return fail(res, 404, 'Not Found');
  }

  if (!isRecord(body)) return fail(res, 400, 'Problems parsing JSON');
  const branch = str(body.branch) ?? repo.defaultBranch;

  if (method === 'PUT') {
    const content = str(body.content);
    if (content === undefined) return fail(res, 422, 'Validation Failed: content is required');
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    let baseTip: string | undefined;
    if (!tip && branch !== repo.defaultBranch) {
      baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      tip = baseTip;
    }
    const tipTree = tip ? commitTree(store, tip) : null;
    const files = tipTree ? flattenTree(store, tipTree) : new Map<string, { oid: string; mode: string }>();
    const existing = files.get(path);
    const shaGiven = str(body.sha);
    if (existing) {
      if (shaGiven === undefined) return fail(res, 422, 'Validation Failed: sha is required when updating a file');
      if (shaGiven !== existing.oid) return fail(res, 409, 'Conflict: the sha does not match the current file');
    } else if (shaGiven !== undefined) {
      return fail(res, 422, 'Validation Failed: sha given for a file that does not exist');
    }
    const blobOid = store.put('blob', Buffer.from(content, 'base64'));
    const commit = commitFileChange(repo, branch, path, blobOid, str(body.message) ?? `Update ${path}`, baseTip);
    sendJson(res, existing ? 200 : 201, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: Buffer.from(content, 'base64').length,
        type: 'file',
        encoding: 'base64',
        content,
      },
      commit: { sha: commit },
    });
    return;
  }

  if (method === 'DELETE') {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const tipTree = tip ? commitTree(store, tip) : null;
    const files = tipTree ? flattenTree(store, tipTree) : new Map<string, { oid: string; mode: string }>();
    const existing = files.get(path);
    if (!existing) return fail(res, 404, 'Not Found');
    const shaGiven = str(body.sha);
    if (shaGiven !== undefined && shaGiven !== existing.oid) return fail(res, 409, 'Conflict: the sha does not match the current file');
    const commit = commitFileChange(repo, branch, path, null, str(body.message) ?? `Delete ${path}`);
    sendJson(res, 200, { content: null, commit: { sha: commit } });
    return;
  }

  return fail(res, 404, 'Not Found');
}

function findDirTree(store: typeof DB.objects, rootTree: string, path: string): string | null {
  let current = rootTree;
  for (const segment of path.split('/')) {
    const obj = store.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function sendDirListing(res: ServerResponse, store: typeof DB.objects, treeOid: string, prefix: string): void {
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return fail(res, 404, 'Not Found');
  const entries = parseTree(obj.data)
    .map((entry) => {
      const isDir = entry.mode === '40000';
      const blob = isDir ? null : store.get(entry.oid);
      return {
        name: entry.name,
        path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
        sha: entry.oid,
        size: blob ? blob.data.length : 0,
        type: isDir ? 'dir' : 'file',
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  sendJson(res, 200, entries);
}

function handleRepoRoute(req: IncomingMessage, res: ServerResponse, url: URL, segments: string[], method: string, body: unknown): void {
  const owner = segments[1];
  const name = segments[2];
  const repo = DB.repo(owner, name);
  if (!repo) return fail(res, 404, 'Not Found');
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.priv = body.private;
      }
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      DB.deleteRepo(owner, name);
      return sendEmpty(res, 204);
    }
    return fail(res, 404, 'Not Found');
  }

  const [head, ...tail] = rest;

  if (head === 'branches') {
    if (method === 'GET' && tail.length === 0) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return sendJson(res, 200, branches);
    }
    if (method === 'GET' && tail.length >= 1) {
      const branch = decodeURIComponent(tail.join('/'));
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return fail(res, 404, 'Not Found');
      return sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
    }
    return fail(res, 404, 'Not Found');
  }

  if (head === 'git' && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      if (!isRecord(body)) return fail(res, 422, 'Validation Failed');
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref || !ref.startsWith('refs/') || !sha) return fail(res, 422, 'Validation Failed: ref and sha are required');
      const object = DB.objects.get(sha);
      if (!object) return fail(res, 422, 'Object does not exist');
      if (repo.refs.has(ref)) return fail(res, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, object: { sha, type: object.type } });
    }
    if (method === 'GET' && tail.length >= 2) {
      const joined = decodeURIComponent(tail.slice(1).join('/'));
      const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
      const sha = repo.refs.get(ref);
      if (!sha) return fail(res, 404, 'Not Found');
      const object = DB.objects.get(sha);
      return sendJson(res, 200, { ref, object: { sha, type: object?.type ?? 'commit' } });
    }
    return fail(res, 404, 'Not Found');
  }

  if (head === 'commits' && tail.length === 0 && method === 'GET') {
    const shaParam = url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, shaParam);
    if (!tip) return sendJson(res, 200, []);
    const page = pageOf(url);
    const walked = walkCommits(DB.objects, tip).map((entry) => commitJson(entry.oid));
    return sendJson(res, 200, paginate(res, req, url, walked, page));
  }

  if (head === 'contents') {
    const path = tail.map((segment) => decodeURIComponent(segment)).join('/');
    return handleContents(req, res, url, repo, method, path, body);
  }

  if (head === 'labels') {
    if (method === 'POST' && tail.length === 0) {
      if (!isRecord(body) || !str(body.name)) return fail(res, 422, 'Validation Failed: name is required');
      const labelName = str(body.name)!;
      repo.labels.set(labelName, { name: labelName, color: str(body.color) ?? 'ededed' });
      return sendJson(res, 201, labelJson(repo, labelName));
    }
    if (method === 'GET' && tail.length === 0) {
      return sendJson(res, 200, [...repo.labels.keys()].map((labelName) => labelJson(repo, labelName)));
    }
    return fail(res, 404, 'Not Found');
  }

  if (head === 'issues') return handleIssues(res, url, repo, method, tail, body);
  if (head === 'pulls') return handlePulls(req, res, url, repo, method, tail, body);

  return fail(res, 404, 'Not Found');
}

function handleIssues(res: ServerResponse, url: URL, repo: RepoRec, method: string, tail: string[], body: unknown): void {
  if (tail.length === 0) {
    if (method === 'POST') {
      if (!isRecord(body) || !str(body.title)) return fail(res, 422, 'Validation Failed: title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return fail(res, 422, `Validation Failed: label "${label}" does not exist`);
      }
      const issue = createIssueRecord(repo, str(body.title)!, typeof body.body === 'string' ? body.body : '', labels);
      return sendJson(res, 201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = pageOf(url);
      const start = (page.page - 1) * page.perPage;
      return sendJson(res, 200, issues.slice(start, start + page.perPage).map((issue) => issueJson(repo, issue)));
    }
    return fail(res, 404, 'Not Found');
  }

  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (!issue) return fail(res, 404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (Array.isArray(body.labels)) {
          const labels = body.labels.filter((label): label is string => typeof label === 'string');
          for (const label of labels) if (!repo.labels.has(label)) return fail(res, 422, `Validation Failed: label "${label}" does not exist`);
          issue.labels = labels;
        }
        issue.updatedTs = nextTimestamp();
      }
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return fail(res, 404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      if (!isRecord(body) || typeof body.body !== 'string') return fail(res, 422, 'Validation Failed: body is required');
      const comment: CommentRec = { id: DB.nextCommentId(), body: body.body, createdTs: nextTimestamp() };
      issue.comments.push(comment);
      return sendJson(res, 201, commentJson(comment));
    }
    if (method === 'GET') return sendJson(res, 200, issue.comments.map(commentJson));
  }

  return fail(res, 404, 'Not Found');
}

function handlePulls(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, method: string, tail: string[], body: unknown): void {
  if (tail.length === 0) {
    if (method === 'POST') {
      if (!isRecord(body)) return fail(res, 422, 'Validation Failed');
      const title = str(body.title);
      const head = str(body.head);
      const base = str(body.base);
      if (!title || !head || !base) return fail(res, 422, 'Validation Failed: title, head and base are required');
      const headRef = head.includes(':') ? head.split(':').pop()! : head;
      const baseRef = base.includes(':') ? base.split(':').pop()! : base;
      if (!repo.refs.has(`refs/heads/${headRef}`)) return fail(res, 422, `Validation Failed: head branch "${headRef}" does not exist`);
      if (!repo.refs.has(`refs/heads/${baseRef}`)) return fail(res, 422, `Validation Failed: base branch "${baseRef}" does not exist`);
      const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
      if (existing) return fail(res, 422, `Validation Failed: a pull request already exists for ${headRef} into ${baseRef}`);
      const pull = createPullRecord(repo, title, typeof body.body === 'string' ? body.body : '', headRef, baseRef);
      return sendJson(res, 201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      const page = pageOf(url);
      const start = (page.page - 1) * page.perPage;
      return sendJson(res, 200, pulls.slice(start, start + page.perPage).map((pull) => pullJson(repo, pull)));
    }
    return fail(res, 404, 'Not Found');
  }

  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (!pull) return fail(res, 404, 'Not Found');

  if (tail.length === 1 && method === 'GET') return sendJson(res, 200, pullJson(repo, pull));

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const files = pullFiles(repo, pull).map((change) => ({
      filename: change.path,
      status: change.status === 'removed' ? 'removed' : change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    }));
    return sendJson(res, 200, files);
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull.merged) return fail(res, 405, 'Pull Request is not mergeable');
    const mergeMethod = isRecord(body) ? str(body.merge_method) : undefined;
    if (mergeMethod === 'merge') {
      const sha = mergeCommitMerge(repo, pull);
      if (!sha) return fail(res, 405, 'Pull Request is not mergeable: merge conflict');
      return sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    }
    const sha = squashMerge(repo, pull);
    if (!sha) return fail(res, 405, 'Pull Request is not mergeable: merge conflict');
    return sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return fail(res, 404, 'Not Found');
}

/** A true merge commit (two parents) for merge_method=merge; null on conflict. */
function mergeCommitMerge(repo: RepoRec, pull: PullRec): string | null {
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
  const commit = store.put('commit', buildCommit(tree, [baseTip, headTip], line, line, `Merge pull request #${pull.number} from ${pull.headRef}`));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAtTs = ts;
  pull.mergeCommitSha = commit;
  pull.updatedTs = ts;
  return commit;
}

/** The /api/v3 dispatcher. `path` is the pathname with the /api/v3 prefix already stripped. */
export function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): void {
  const method = req.method ?? 'GET';
  const restPath = url.pathname.replace(/^\/api\/v3/, '') || '/';
  const segments = restPath.split('/').filter((segment) => segment !== '');

  // Body discipline first: a malformed JSON body is a 400 on any route that takes one.
  let parsed: unknown;
  if (body.length > 0 && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    try {
      parsed = jsonBody(body);
    } catch {
      return fail(res, 400, 'Problems parsing JSON');
    }
  }

  const isPublic = method === 'GET' && (segments.length === 0 || (segments.length === 1 && segments[0] === 'meta'));
  if (!isPublic && !isAuthed(req)) return fail(res, 401, 'Bad credentials');

  if (segments.length === 0 && method === 'GET') return handleRoot(res);
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    return sendJson(res, 200, { installed_version: '1.0.0', github_version: '3.0.0' });
  }
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') return sendJson(res, 200, userJson());
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return handleCreateRepo(res, parsed);
    if (method === 'GET') {
      const page = pageOf(url);
      const items = DB.listRepos().map(repoJson);
      return sendJson(res, 200, paginate(res, req, url, items, page));
    }
    return fail(res, 404, 'Not Found');
  }
  if (segments.length >= 3 && segments[0] === 'repos') {
    return handleRepoRoute(req, res, url, segments.map((segment) => segment), method, parsed);
  }
  return fail(res, 404, 'Not Found');
}
