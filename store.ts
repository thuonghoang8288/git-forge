// store.ts — the forge's whole state: repositories, refs, git objects,
// issues, pull requests, labels and comments. One process, in-memory, no
// external service. All timestamps are fixed constants (deterministic export);
// ordering uses monotonically increasing sequence numbers.

import { VIEWER } from './scenario.ts';
import {
  objectId, parseCommit, parseTree, buildTree,
  type GitObject, type ObjType, ZERO_OID,
} from './gitobj.ts';

export const FIXED_TIME = '2025-01-01T00:00:00Z';
export const FIXED_TS = 1735689600;
export const SERVER_AUTHOR = `${VIEWER.name} <${VIEWER.email}>`;

export interface Label { name: string; color: string }
export interface Comment { id: number; body: string; user: string; seq: number }
export interface Issue {
  number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; user: string;
  seq: number; comments: Comment[];
}
export interface Pull {
  number: number; title: string; body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  user: string; seq: number; comments: Comment[];
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  /** Bumped on every refs/objects mutation; invalidates the pack cache. */
  version: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

export function fullNameOf(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function ungid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  seq = 1;

  nextSeq(): number {
    return this.seq++;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(fullNameOf(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean }): Repo | 'exists' {
    if (this.repos.has(fullNameOf(owner, name))) return 'exists';
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      version: 0,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.repos.set(fullNameOf(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(fullNameOf(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((r) => r.owner === VIEWER.login)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }
}

// ---------------------------------------------------------------- git object helpers (per repo)

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`? */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** First common ancestor of a and b (BFS from b over a's ancestor set). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const oid = stack.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

/**
 * The object closure of `tips`.
 *
 * - `depth`: limit the commit walk to generations 0..depth-1 (generation 0
 *   is the tips). `boundary` is then the deepest included commits (their
 *   parents are NOT included) — the new shallow boundary.
 * - `stopAt`: commits whose own objects are included but whose parents are
 *   NOT traversed (the client's existing shallow boundary: the client holds
 *   the boundary commit itself, not its history).
 *
 * The fetch algorithm uses two closures: `held` = closure(haves, stopAt =
 * client's shallow set) and `send` = closure(wants, depth) minus held.
 */
export function reachable(
  repo: Repo,
  tips: readonly string[],
  opts: { depth?: number; stopAt?: readonly string[] } = {},
): { objects: Map<string, GitObject>; boundary: string[] } {
  const stopAt = new Set(opts.stopAt ?? []);
  const depth = opts.depth;
  const objects = new Map<string, GitObject>();
  const boundary: string[] = [];
  const visitObject = (oid: string): void => {
    if (objects.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    objects.set(oid, obj);
    if (obj.type === 'commit') {
      visitObject(parseCommit(obj.data).tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) visitObject(e.oid);
    } else if (obj.type === 'tag') {
      const line = obj.data.toString('utf8').split('\n').find((l) => l.startsWith('object '));
      if (line) visitObject(line.slice(7).trim());
    }
  };
  const queue: Array<{ oid: string; gen: number }> = tips.map((oid) => ({ oid, gen: 0 }));
  const seenCommits = new Set<string>();
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type !== 'commit') {
      visitObject(oid);
      continue;
    }
    visitObject(oid);
    const parents = parseCommit(obj.data).parents;
    if (stopAt.has(oid)) continue; // boundary commit: parents not traversed
    if (depth !== undefined && gen + 1 >= depth) {
      // Deepest included generation: this commit is the new boundary.
      if (parents.length > 0 && !boundary.includes(oid)) boundary.push(oid);
      continue;
    }
    for (const p of parents) queue.push({ oid: p, gen: gen + 1 });
  }
  return { objects, boundary };
}

/** Objects to send for a fetch: closure(wants, depth) minus closure(haves, stopAt=clientShallow). */
export function fetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth?: number,
): { objects: Map<string, GitObject>; boundary: string[]; unshallow: string[] } {
  const held = haves.length ? reachable(repo, haves, { stopAt: clientShallow }).objects : new Map<string, GitObject>();
  const { objects, boundary } = reachable(repo, wants, { depth });
  for (const oid of held.keys()) objects.delete(oid);
  // A client shallow boundary is unshallowed when it is held (in the send
  // set or already held) AND its parents are now held too.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const itselfHeld = objects.has(oid) || held.has(oid);
    if (!itselfHeld) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const parentsHeld = parents.every((p) => objects.has(p) || held.has(p));
    if (parentsHeld && !boundary.includes(oid)) unshallow.push(oid);
  }
  return { objects, boundary, unshallow };
}

/** Flatten a tree into path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = pre ? `${pre}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build trees from a flat path map; returns the root tree oid. */
export function buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const build = (paths: Array<[string, { oid: string; mode: string }]>, depth: number): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const dirs = new Map<string, Array<[string, { oid: string; mode: string }]>>();
    for (const [path, info] of paths) {
      const parts = path.split('/');
      if (parts.length === depth + 1) {
        entries.push({ mode: info.mode, name: parts[depth], oid: info.oid });
      } else {
        const dir = parts[depth];
        const rest = paths.filter(([p]) => p.split('/')[depth] === dir);
        if (!dirs.has(dir)) dirs.set(dir, rest);
      }
    }
    for (const [dir, sub] of dirs) {
      entries.push({ mode: '40000', name: dir, oid: build(sub, depth + 1) });
    }
    return putObject(repo, 'tree', buildTree(entries.map((e) => ({ ...e, type: e.mode === '40000' ? 'tree' as const : 'blob' as const }))));
  };
  return build([...files.entries()], 0);
}

/** Create a commit object; returns its oid. Timestamp is deterministic. */
export function createCommit(
  repo: Repo,
  store: Store,
  opts: { tree: string; parents: string[]; message: string; author?: string; committer?: string },
): string {
  const ts = FIXED_TS + store.nextSeq();
  const who = opts.author ?? `${SERVER_AUTHOR} ${ts} +0000`;
  const committer = opts.committer ?? `${SERVER_AUTHOR} ${ts} +0000`;
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`);
  lines.push(`committer ${committer}`);
  const msg = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  const data = Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
  return putObject(repo, 'commit', data);
}

/** Resolve a ref name, branch name or oid to an object id. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : undefined;
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const branch = `refs/heads/${ref}`;
  if (repo.refs.has(branch)) return repo.refs.get(branch);
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return undefined;
}

/** Commits reachable from a tip, newest first (pre-order DFS). */
export function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return out;
}

/** Diff two trees: path -> {status, oldOid, newOid}. */
export function diffTrees(
  repo: Repo,
  baseTree: string | null,
  headTree: string,
): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
  const base = baseTree ? flattenTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
  const head = flattenTree(repo, headTree);
  const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
  for (const [path, h] of head) {
    const b = base.get(path);
    if (!b) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  for (const [path, b] of base) {
    if (!head.has(path)) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

/** Line counts for a blob diff (multiset difference, fast and adequate). */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData ? oldData.toString('utf8').split('\n') : [];
  const newLines = newData ? newData.toString('utf8').split('\n') : [];
  const counts = new Map<string, number>();
  for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of counts.values()) deletions += c;
  return { additions, deletions };
}

/** Is a pull request mergeable (no 3-way conflict)? */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const base = mergeBase(repo, headTip, baseTip);
  const headTree = parseCommit(getObject(repo, headTip)!.data).tree;
  const baseTree = base ? parseCommit(getObject(repo, base)!.data).tree : null;
  const baseTipTree = parseCommit(getObject(repo, baseTip)!.data).tree;
  const headDiff = diffTrees(repo, baseTree, headTree);
  const baseChanged = new Map(diffTrees(repo, baseTree, baseTipTree).map((d) => [d.path, d]));
  for (const d of headDiff) {
    const b = baseChanged.get(d.path);
    if (b && (b.newOid !== d.newOid || b.status !== d.status)) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Squash-merge a pull request onto its base branch. Shared by REST + GraphQL. */
export function squashMerge(
  repo: Repo,
  store: Store,
  pull: Pull,
): { ok: true; sha: string } | { ok: false; reason: string } {
  if (pull.merged || pull.state !== 'open') return { ok: false, reason: 'Pull request is already merged or closed' };
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (!headTip || !baseTip) return { ok: false, reason: 'head or base branch not found' };
  if (pullMergeable(repo, pull) === 'CONFLICTING') {
    return { ok: false, reason: 'Merge conflict: the head and base both changed the same files' };
  }
  const base = mergeBase(repo, headTip, baseTip);
  const headTree = parseCommit(getObject(repo, headTip)!.data).tree;
  const baseTree = base ? parseCommit(getObject(repo, base)!.data).tree : null;
  const baseTipTree = parseCommit(getObject(repo, baseTip)!.data).tree;
  const files = flattenTree(repo, baseTipTree);
  for (const d of diffTrees(repo, baseTree, headTree)) {
    if (d.status === 'removed') files.delete(d.path);
    else files.set(d.path, { oid: d.newOid!, mode: '100644' });
  }
  const newTree = buildTreeFromFiles(repo, files);
  const squashSha = createCommit(repo, store, {
    tree: newTree,
    parents: [baseTip],
    message: pull.title || `Merge pull request #${pull.number}`,
  });
  repo.refs.set(`refs/heads/${pull.base.ref}`, squashSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = FIXED_TIME;
  pull.mergeCommitSha = squashSha;
  repo.version += 1;
  return { ok: true, sha: squashSha };
}
// ---------------------------------------------------------------- serializers (shared by REST/GraphQL/MCP)

export function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: gid('user', login),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
    name: login,
    email: `${login}@example.invalid`,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('repo', repo.id),
    name: repo.name,
    full_name: fullNameOf(repo.owner, repo.name),
    private: repo.private,
    owner: userJson(repo.owner, 1000),
    html_url: `https://github.com/${fullNameOf(repo.owner, repo.name)}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${fullNameOf(repo.owner, repo.name)}`,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    pushed_at: FIXED_TIME,
    git_url: `git://github.com/${fullNameOf(repo.owner, repo.name)}.git`,
    ssh_url: `git@github.com:${fullNameOf(repo.owner, repo.name)}.git`,
    clone_url: `https://github.com/${fullNameOf(repo.owner, repo.name)}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, node_id: gid('label', label.name), url: '', name: label.name, color: label.color, default: false, description: '' };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: gid('issue', repo.id, issue.number),
    url: `/api/v3/repos/${fullNameOf(repo.owner, repo.name)}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${fullNameOf(repo.owner, repo.name)}`,
    labels_url: `/api/v3/repos/${fullNameOf(repo.owner, repo.name)}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${fullNameOf(repo.owner, repo.name)}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${fullNameOf(repo.owner, repo.name)}/issues/${issue.number}/events`,
    html_url: `https://github.com/${fullNameOf(repo.owner, repo.name)}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: userJson(issue.user, 1000),
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: '000000' })),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: issue.state === 'closed' ? FIXED_TIME : null,
    author_association: 'OWNER',
    body: issue.body,
  };
}

export function commentJson(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: gid('comment', repo.id, issueNumber, comment.id),
    url: `/api/v3/repos/${fullNameOf(repo.owner, repo.name)}/issues/${issueNumber}/comments/${comment.id}`,
    html_url: `https://github.com/${fullNameOf(repo.owner, repo.name)}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user, 1000),
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    author_association: 'OWNER',
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: gid('pull', repo.id, pull.number),
    url: `/api/v3/repos/${fullNameOf(repo.owner, repo.name)}/pulls/${pull.number}`,
    html_url: `https://github.com/${fullNameOf(repo.owner, repo.name)}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    user: userJson(pull.user, 1000),
    body: pull.body,
    state: pull.state,
    locked: false,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: pull.state === 'closed' ? FIXED_TIME : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? true : null,
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    merged_by: pull.merged ? userJson(pull.user, 1000) : null,
    head: { label: `${repo.owner}:${pull.head.ref}`, ref: pull.head.ref, sha: pull.head.sha, user: userJson(repo.owner, 1000), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.base.ref}`, ref: pull.base.ref, sha: pull.base.sha, user: userJson(repo.owner, 1000), repo: repoJson(repo) },
    _links: {},
    author_association: 'OWNER',
    draft: false,
  };
}
