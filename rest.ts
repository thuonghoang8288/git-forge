// rest.ts — the GitHub REST v3 surface under /api/v3: repos, branches,
// commits, contents, refs, labels, issues, comments and pull requests.
// Every reply is application/json with a non-empty X-GitHub-Request-Id;
// errors carry {"message": string}; unknown routes are JSON 404s and
// malformed JSON bodies are 400s.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, USERS_BY_LOGIN } from './scenario.ts';
import { newRequestId, parseCommit, parseTree } from './gitobj.ts';
import {
  buildTreeFromFiles, createCommit, diffTrees, flattenTree, getObject,
  gid, lineDiff, listCommits, mergeBase, putObject, resolveRef,
  repoJson, issueJson, commentJson, pullJson, labelJson, userJson,
  squashMerge,
  FIXED_TIME, type Comment, type Issue, type Pull, type Repo, type Store,
} from './store.ts';

export interface RestCtx {
  store: Store;
  token: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'x-github-request-id': requestId,
    ...extra,
  };
  if (status !== 204) {
    headers['content-type'] = JSON_TYPE;
    headers['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, headers);
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function authed(ctx: RestCtx, req: IncomingMessage): boolean {
  if (!ctx.token) return true;
  return (req.headers.authorization ?? '') === `Bearer ${ctx.token}`;
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function paginate<T>(items: T[], q: URLSearchParams): { page: T[]; total: number; perPage: number; pageNum: number } {
  let perPage = parseInt(q.get('per_page') ?? '30', 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  let pageNum = parseInt(q.get('page') ?? '1', 10);
  if (!Number.isFinite(pageNum) || pageNum < 1) pageNum = 1;
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, perPage, pageNum };
}

function linkHeader(req: IncomingMessage, path: string, q: URLSearchParams, total: number, perPage: number, pageNum: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (page: number): string => {
    const nq = new URLSearchParams(q);
    nq.set('per_page', String(perPage));
    nq.set('page', String(page));
    return `${originOf(req)}${path}?${nq.toString()}`;
  };
  const links: string[] = [];
  if (pageNum < lastPage) links.push(`<${urlFor(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) links.push(`<${urlFor(pageNum - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(lastPage)}>; rel="last"`);
  return links.join(', ');
}

/** Load a repo for a /repos/:owner/:name route; foreign owners are 404. */
function loadRepo(ctx: RestCtx, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return ctx.store.getRepo(owner, name);
}

function parseIdent(line: string): { name: string; email: string; date: string } | null {
  const m = line.match(/^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/);
  if (!m) return null;
  return { name: m[1], email: m[2], date: new Date(parseInt(m[3], 10) * 1000).toISOString() };
}

function loginForEmail(email: string): string | null {
  for (const [login, user] of USERS_BY_LOGIN) if (user.email === email) return login;
  return null;
}

export async function handleRest(ctx: RestCtx, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const requestId = newRequestId();
  const q = queryOf(req);

  // API root: no auth (starter behaviour), 200 + scopes.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, requestId, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (!authed(ctx, req)) {
    sendJson(res, 401, { message: 'Requires authentication' }, requestId);
    return true;
  }

  const seg = path.split('/').filter((s) => s !== '');
  // seg: ['api','v3', ...]

  // ---- /api/v3/meta
  if (method === 'GET' && seg.length === 3 && seg[2] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false }, requestId);
    return true;
  }

  // ---- /api/v3/user
  if (seg.length >= 3 && seg[2] === 'user') {
    if (method === 'GET' && seg.length === 3) {
      sendJson(res, 200, { ...userJson(VIEWER.login, VIEWER.id), name: VIEWER.name, email: VIEWER.email }, requestId);
      return true;
    }
    if (method === 'POST' && seg.length === 4 && seg[3] === 'repos') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId); return true; }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendJson(res, 422, { message: 'Validation Failed: name is invalid' }, requestId);
        return true;
      }
      const created = ctx.store.createRepo(VIEWER.login, name, {
        description: typeof body.description === 'string' ? body.description : '',
        private: body.private === true,
      });
      if (created === 'exists') {
        sendJson(res, 422, { message: 'Repository creation failed. name already exists on this account' }, requestId);
        return true;
      }
      sendJson(res, 201, repoJson(created), requestId);
      return true;
    }
    if (method === 'GET' && seg.length === 4 && seg[3] === 'repos') {
      const all = ctx.store.listViewerRepos();
      const { page, total, perPage, pageNum } = paginate(all, q);
      sendJson(res, 200, page.map(repoJson), requestId, { link: linkHeader(req, path, q, total, perPage, pageNum) });
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return true;
  }

  // ---- /api/v3/users/:login
  if (method === 'GET' && seg.length === 4 && seg[2] === 'users') {
    const user = USERS_BY_LOGIN.get(decodeURIComponent(seg[3]));
    if (!user) { sendJson(res, 404, { message: 'Not Found' }, requestId); return true; }
    sendJson(res, 200, { ...userJson(user.login, user.id), name: user.name, email: user.email }, requestId);
    return true;
  }

  // ---- /api/v3/repos/:owner/:name[/...]
  if (seg.length >= 5 && seg[2] === 'repos') {
    const owner = decodeURIComponent(seg[3]);
    const name = decodeURIComponent(seg[4]);
    const repo = loadRepo(ctx, owner, name);
    const rest = seg.slice(5);

    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return true;
    }
    const repoPath = `/api/v3/repos/${owner}/${name}`;

    // GET/PATCH/DELETE the repo itself
    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo), requestId); return true; }
      if (method === 'PATCH') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        sendJson(res, 200, repoJson(repo), requestId);
        return true;
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(owner, name);
        sendJson(res, 204, null, requestId);
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return true;
    }

    // ---- branches
    if (rest[0] === 'branches') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort();
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, branches.map((b) => ({
          name: b,
          commit: { sha: repo.refs.get(`refs/heads/${b}`), url: `${repoPath}/commits/${repo.refs.get(`refs/heads/${b}`)}` },
          protected: false,
        })), requestId);
        return true;
      }
      if (method === 'GET' && rest.length >= 2) {
        const branch = rest.slice(1).map(decodeURIComponent).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) { sendJson(res, 404, { message: 'Branch not found' }, requestId); return true; }
        sendJson(res, 200, {
          name: branch,
          commit: { sha, url: `${repoPath}/commits/${sha}` },
          protected: false,
        }, requestId);
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return true;
    }

    // ---- commits
    if (rest[0] === 'commits' && method === 'GET') {
      const shaParam = q.get('sha');
      const tip = shaParam ? resolveRef(repo, shaParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) { sendJson(res, 200, [], requestId); return true; }
      const commits = listCommits(repo, tip);
      const { page } = paginate(commits, q);
      sendJson(res, 200, page.map((oid) => {
        const obj = getObject(repo, oid)!;
        const c = parseCommit(obj.data);
        const author = parseIdent(c.author);
        const committer = parseIdent(c.committer);
        return {
          sha: oid,
          node_id: gid('commit', oid),
          commit: {
            author: author ? { name: author.name, email: author.email, date: author.date } : null,
            committer: committer ? { name: committer.name, email: committer.email, date: committer.date } : null,
            message: c.message.replace(/\n$/, ''),
            tree: { sha: c.tree },
            url: `${repoPath}/git/commits/${oid}`,
            comment_count: 0,
          },
          url: `${repoPath}/commits/${oid}`,
          html_url: `https://github.com/${owner}/${name}/commit/${oid}`,
          author: author && loginForEmail(author.email) ? userJson(loginForEmail(author.email)!, 1000) : null,
          committer: committer && loginForEmail(committer.email) ? userJson(loginForEmail(committer.email)!, 1000) : null,
          parents: c.parents.map((p) => ({ sha: p, url: `${repoPath}/commits/${p}` })),
        };
      }), requestId);
      return true;
    }

    // ---- git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).map(decodeURIComponent).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) { sendJson(res, 404, { message: 'Not Found' }, requestId); return true; }
        sendJson(res, 200, {
          ref: `refs/heads/${branch}`,
          node_id: `R_${sha}`,
          url: `${repoPath}/git/refs/heads/${branch}`,
          object: { sha, type: 'commit', url: `${repoPath}/git/commits/${sha}` },
        }, requestId);
        return true;
      }
      if (method === 'POST' && rest.length === 2) {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Validation Failed: ref or sha is invalid' }, requestId);
          return true;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' }, requestId);
          return true;
        }
        repo.refs.set(ref, sha);
        repo.version += 1;
        sendJson(res, 201, {
          ref,
          node_id: `R_${sha}`,
          url: `${repoPath}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: getObject(repo, sha)?.type ?? 'commit', url: `${repoPath}/git/commits/${sha}` },
        }, requestId);
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return true;
    }

    // ---- labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson), requestId);
        return true;
      }
      if (method === 'POST' && rest.length === 1) {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const name = typeof body.name === 'string' ? body.name : '';
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        if (!name) { sendJson(res, 422, { message: 'Validation Failed: name is required' }, requestId); return true; }
        const existing = repo.labels.get(name);
        if (existing) { sendJson(res, 201, labelJson(existing), requestId); return true; }
        const label = { name, color };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label), requestId);
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return true;
    }

    // ---- issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId); return true; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const title = typeof body.title === 'string' ? body.title : '';
          const labelsIn: string[] = Array.isArray(body.labels)
            ? body.labels.filter((l): l is string => typeof l === 'string')
            : [];
          for (const l of labelsIn) {
            if (!repo.labels.has(l)) {
              sendJson(res, 422, { message: `Validation Failed: label "${l}" does not exist` }, requestId);
              return true;
            }
          }
          const issue: Issue = {
            number: repo.nextIssue++,
            title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            labels: labelsIn,
            user: VIEWER.login,
            seq: ctx.store.nextSeq(),
            comments: [],
          };
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue), requestId);
          return true;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          let list = repo.issues.filter((i) => state === 'all' || i.state === state);
          if (sort === 'created') {
            list = [...list].sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          }
          const { page, total, perPage, pageNum } = paginate(list, q);
          sendJson(res, 200, page.map((i) => issueJson(repo, i)), requestId, { link: linkHeader(req, path, q, total, perPage, pageNum) });
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return true;
      }
      const num = parseInt(rest[1], 10);
      const issue = Number.isFinite(num) ? repo.issues.find((i) => i.number === num) : undefined;
      if (!issue) { sendJson(res, 404, { message: 'Not Found' }, requestId); return true; }
      if (rest.length === 2) {
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue), requestId); return true; }
        if (method === 'PATCH') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId); return true; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          sendJson(res, 200, issueJson(repo, issue), requestId);
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue.number, c)), requestId);
          return true;
        }
        if (method === 'POST') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId); return true; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const comment: Comment = {
            id: repo.nextComment++,
            body: typeof body.body === 'string' ? body.body : '',
            user: VIEWER.login,
            seq: ctx.store.nextSeq(),
          };
          issue.comments.push(comment);
          sendJson(res, 201, commentJson(repo, issue.number, comment), requestId);
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return true;
    }

    // ---- pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId); return true; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : '';
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) {
            sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist' }, requestId);
            return true;
          }
          const dup = repo.pulls.find((p) => p.state === 'open' && p.head.ref === head && p.base.ref === base);
          if (dup) {
            sendJson(res, 422, { message: 'Validation Failed: a pull request already exists for this head branch' }, requestId);
            return true;
          }
          const pull: Pull = {
            number: repo.nextPull++,
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            head: { ref: head, sha: headSha },
            base: { ref: base, sha: baseSha },
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            user: VIEWER.login,
            seq: ctx.store.nextSeq(),
            comments: [],
          };
          repo.pulls.push(pull);
          sendJson(res, 201, pullJson(repo, pull), requestId);
          return true;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = repo.pulls.filter((p) => state === 'all' || p.state === state);
          list = [...list].sort((a, b) => b.seq - a.seq);
          const { page, total, perPage, pageNum } = paginate(list, q);
          sendJson(res, 200, page.map((p) => pullJson(repo, p)), requestId, { link: linkHeader(req, path, q, total, perPage, pageNum) });
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return true;
      }
      const num = parseInt(rest[1], 10);
      const pull = Number.isFinite(num) ? repo.pulls.find((p) => p.number === num) : undefined;
      if (!pull) { sendJson(res, 404, { message: 'Not Found' }, requestId); return true; }
      if (rest.length === 2 && method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull), requestId);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const base = mergeBase(repo, pull.head.sha, pull.base.sha);
        const headTree = parseCommit(getObject(repo, pull.head.sha)!.data).tree;
        const baseTree = base ? parseCommit(getObject(repo, base)!.data).tree : null;
        const diffs = diffTrees(repo, baseTree, headTree);
        sendJson(res, 200, diffs.map((d) => {
          const oldData = d.oldOid ? getObject(repo, d.oldOid)?.data ?? null : null;
          const newData = d.newOid ? getObject(repo, d.newOid)?.data ?? null : null;
          const { additions, deletions } = lineDiff(oldData, newData);
          return {
            sha: d.newOid ?? d.oldOid,
            filename: d.path,
            status: d.status === 'removed' ? 'changed' : d.status,
            additions,
            deletions,
            changes: additions + deletions,
            blob_url: `https://github.com/${owner}/${name}/blob/${pull.head.sha}/${d.path}`,
            raw_url: `https://github.com/${owner}/${name}/raw/${pull.head.sha}/${d.path}`,
            contents_url: `${repoPath}/contents/${d.path}?ref=${pull.head.sha}`,
            patch: '',
          };
        }), requestId);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId); return true; }
        if (pull.merged || pull.state === 'closed') {
          sendJson(res, 405, { message: 'Pull request is already merged or closed' }, requestId);
          return true;
        }
        const merged = squashMerge(repo, ctx.store, pull);
        if (!merged.ok) {
          const status = merged.reason.startsWith('Merge conflict') ? 405 : 404;
          sendJson(res, status, { message: merged.reason }, requestId);
          return true;
        }
        sendJson(res, 200, { sha: merged.sha, merged: true, message: pull.title || `Merge pull request #${pull.number}` }, requestId);
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return true;
    }

    // ---- contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map(decodeURIComponent).join('/');
      const refParam = q.get('ref');
      const branchParam = (b: Record<string, unknown>): string | undefined =>
        typeof b.branch === 'string' ? b.branch : undefined;
      if (method === 'GET') {
        const tip = refParam ? resolveRef(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) { sendJson(res, 404, { message: 'Not Found' }, requestId); return true; }
        const commitObj = getObject(repo, tip);
        if (!commitObj || commitObj.type !== 'commit') { sendJson(res, 404, { message: 'Not Found' }, requestId); return true; }
        const rootTree = parseCommit(commitObj.data).tree;
        if (!filePath) {
          sendJson(res, 200, treeListing(repo, rootTree, '', owner, name, repoPath), requestId);
          return true;
        }
        const parts = filePath.split('/');
        let treeOid = rootTree;
        for (let i = 0; i < parts.length; i += 1) {
          const tree = getObject(repo, treeOid);
          if (!tree || tree.type !== 'tree') { sendJson(res, 404, { message: 'Not Found' }, requestId); return true; }
          const entry = parseTree(tree.data).find((e) => e.name === parts[i]);
          if (!entry) { sendJson(res, 404, { message: 'Not Found' }, requestId); return true; }
          if (i === parts.length - 1) {
            if (entry.mode === '40000') {
              sendJson(res, 200, treeListing(repo, entry.oid, filePath, owner, name, repoPath), requestId);
              return true;
            }
            const blob = getObject(repo, entry.oid);
            if (!blob) { sendJson(res, 404, { message: 'Not Found' }, requestId); return true; }
            sendJson(res, 200, {
              type: 'file',
              encoding: 'base64',
              size: blob.data.length,
              name: parts[i],
              path: filePath,
              content: blob.data.toString('base64'),
              sha: entry.oid,
              url: `${repoPath}/contents/${filePath}`,
              git_url: `${repoPath}/git/blobs/${entry.oid}`,
              html_url: `https://github.com/${owner}/${name}/blob/${tip}/${filePath}`,
              download_url: `https://raw.githubusercontent.com/${owner}/${name}/${tip}/${filePath}`,
            }, requestId);
            return true;
          }
          if (entry.mode !== '40000') { sendJson(res, 404, { message: 'Not Found' }, requestId); return true; }
          treeOid = entry.oid;
        }
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return true;
      }
      if (method === 'PUT' || method === 'DELETE') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const branch = branchParam(body) ?? repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        const baseTip = repo.refs.get(branchRef) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        const message = typeof body.message === 'string' ? body.message : 'update';
        if (method === 'PUT') {
          const contentB64 = typeof body.content === 'string' ? body.content : '';
          let content: Buffer;
          try {
            content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
          } catch {
            sendJson(res, 422, { message: 'Validation Failed: content is not valid base64' }, requestId);
            return true;
          }
          const files = baseTip ? flattenTree(repo, parseCommit(getObject(repo, baseTip)!.data).tree) : new Map<string, { oid: string; mode: string }>();
          const existing = files.get(filePath);
          const shaParam = typeof body.sha === 'string' ? body.sha : undefined;
          if (shaParam !== undefined && (!existing || existing.oid !== shaParam)) {
            sendJson(res, 409, { message: 'sha does not match the current blob' }, requestId);
            return true;
          }
          const blobOid = putObject(repo, 'blob', content);
          files.set(filePath, { oid: blobOid, mode: '100644' });
          const newTree = buildTreeFromFiles(repo, files);
          const commitSha = createCommit(repo, ctx.store, {
            tree: newTree,
            parents: baseTip ? [baseTip] : [],
            message,
          });
          repo.refs.set(branchRef, commitSha);
          repo.version += 1;
          const status = existing ? 200 : 201;
          sendJson(res, status, {
            content: {
              name: filePath.split('/').pop(),
              path: filePath,
              sha: blobOid,
              size: content.length,
              url: `${repoPath}/contents/${filePath}`,
              html_url: `https://github.com/${owner}/${name}/blob/${commitSha}/${filePath}`,
              git_url: `${repoPath}/git/blobs/${blobOid}`,
              download_url: `https://raw.githubusercontent.com/${owner}/${name}/${commitSha}/${filePath}`,
              type: 'file',
              encoding: 'base64',
              content: contentB64,
            },
            commit: {
              sha: commitSha,
              message,
              author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TIME },
              committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TIME },
              parents: baseTip ? [{ sha: baseTip }] : [],
            },
          }, requestId);
          return true;
        }
        // DELETE
        if (!baseTip) { sendJson(res, 404, { message: 'Not Found' }, requestId); return true; }
        const files = flattenTree(repo, parseCommit(getObject(repo, baseTip)!.data).tree);
        const existing = files.get(filePath);
        if (!existing) { sendJson(res, 404, { message: 'Not Found' }, requestId); return true; }
        const shaParam = typeof body.sha === 'string' ? body.sha : undefined;
        if (shaParam !== undefined && existing.oid !== shaParam) {
          sendJson(res, 409, { message: 'sha does not match the current blob' }, requestId);
          return true;
        }
        files.delete(filePath);
        const newTree = buildTreeFromFiles(repo, files);
        const commitSha = createCommit(repo, ctx.store, {
          tree: newTree,
          parents: [baseTip],
          message,
        });
        repo.refs.set(branchRef, commitSha);
        repo.version += 1;
        sendJson(res, 200, {
          content: null,
          commit: {
            sha: commitSha,
            message,
            author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TIME },
            committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TIME },
            parents: [{ sha: baseTip }],
          },
        }, requestId);
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return true;
    }

    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return true;
  }

  // Unknown /api/v3 route.
  sendJson(res, 404, { message: 'Not Found' }, requestId);
  return true;
}

function treeListing(repo: Repo, treeOid: string, prefix: string, owner: string, name: string, repoPath: string): unknown[] {
  const tree = getObject(repo, treeOid);
  if (!tree || tree.type !== 'tree') return [];
  return parseTree(tree.data).map((e) => {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    const isDir = e.mode === '40000';
    const blob = isDir ? null : getObject(repo, e.oid);
    return {
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : (blob?.data.length ?? 0),
      name: e.name,
      path,
      sha: e.oid,
      url: `${repoPath}/contents/${path}`,
      git_url: `${repoPath}/git/${isDir ? 'trees' : 'blobs'}/${e.oid}`,
      html_url: `https://github.com/${owner}/${name}/blob/HEAD/${path}`,
      download_url: isDir ? null : `https://raw.githubusercontent.com/${owner}/${name}/HEAD/${path}`,
    };
  });
}
