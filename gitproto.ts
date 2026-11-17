// gitproto.ts — git smart HTTP: info/refs advertisements (v0/v2),
// protocol v2 ls-refs + fetch, and v0 receive-pack with report-status.
// The wire shapes follow program/env/src/git-client.ts exactly: the client
// is the contract.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import {
  decodePktLines, encodePktLine, encodePktLines, isObjectId,
  parseCommit, parseTag, readPack, sidebandPack, verifyPackChecksum,
  writePack, ZERO_OID, type GitObject,
} from './gitobj.ts';
import {
  fetchObjects, getObject, isAncestor, putObject, resolveRef,
  type Repo, type Store,
} from './store.ts';

const AGENT = 'git-forge/0.1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitCtx {
  store: Store;
  /** The bearer token the env gave this process ('' = accept any, local dev). */
  token: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(ctx: GitCtx, req: IncomingMessage): boolean {
  if (!ctx.token) return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${ctx.token}`;
}

/** Parse /{owner}/{repo}.git/<rest> — returns null when the shape is off. */
export function parseGitPath(path: string): { owner: string; repo: string; rest: string } | null {
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/);
  if (!m) return null;
  return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), rest: m[3] ?? '' };
}

function refLines(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const obj = repo.objects.get(oid);
    let peeled: string | undefined;
    if (obj?.type === 'tag') {
      const tag = parseTag(obj.data);
      peeled = tag.object;
    }
    out.push({ oid, name, peeled });
  }
  return out;
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** v0 capability list for upload-pack (first ref line carries it after NUL). */
const UPLOAD_V0_CAPS = [
  'multi_ack', 'thin-pack', 'side-band', 'side-band-64k', 'ofs-delta', 'shallow',
  'deepen-since', 'deepen-not', 'deepen-relative', 'no-progress', 'include-tag',
  'multi_ack_detailed', 'allow-tip-sha1-in-want', 'allow-reachable-sha1-in-want',
  'no-done', `symref=HEAD:refs/heads/${'main'}`, 'filter', 'object-format=sha1', `agent=${AGENT}`,
].join(' ');

/** v0 capability list for receive-pack. No report-status-v2 (keep report-status). */
const RECEIVE_V0_CAPS = [
  'report-status', 'side-band-64k', 'delete-refs', 'ofs-delta',
  `symref=HEAD:refs/heads/main`, `agent=${AGENT}`,
].join(' ');

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const preamble = `# service=${service}\n`;
  const lines: Array<string | Buffer | 'flush'> = [preamble, 'flush'];
  const refs = refLines(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    if (head) lines.push(`${head} HEAD\0${caps}\n`);
    refs.forEach((ref, i) => {
      const prefix = head ? '' : i === 0 ? `\0${caps}` : '';
      lines.push(`${ref.oid} ${ref.name}${prefix}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

export async function handleInfoRefs(
  ctx: GitCtx, req: IncomingMessage, res: ServerResponse,
  owner: string, repoName: string, service: string, requestId: string,
): Promise<void> {
  if (!authed(ctx, req)) { sendJson(res, 401, { message: 'Requires authentication' }, requestId); return; }
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo || owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }
  if (service === 'git-upload-pack') {
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    sendBytes(res, 200, UPLOAD_AD, v2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack'));
    return;
  }
  if (service === 'git-receive-pack') {
    sendBytes(res, 200, RECEIVE_AD, v0Advertisement(repo, 'git-receive-pack'));
    return;
  }
  sendJson(res, 404, { message: 'Not Found' }, requestId);
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
  command: 'ls-refs' | 'fetch' | null;
}

function parseUploadPackArgs(packets: ReturnType<typeof decodePktLines>): FetchArgs {
  const args: FetchArgs = {
    wants: [], haves: [], shallow: [], peel: false, symrefs: false, unborn: false,
    prefixes: [], command: null,
  };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) {
      args.command = line.slice(8) as 'ls-refs' | 'fetch';
    } else if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice(11));
    else if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // agent=, object-format=, thin-pack, no-progress, ofs-delta, filter,
    // deepen-since, deepen-not, done: acknowledged, no action needed.
  }
  return args;
}

function handleLsRefs(repo: Repo, args: FetchArgs): Buffer {
  const refs = refLines(repo);
  const head = headOid(repo);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const lines: Array<string | 'flush'> = [];
  // HEAD is only listed when no ref-prefix filter is active (it matches no
  // prefix, and the suite asserts prefix results contain only that prefix).
  if (head && args.symrefs && args.prefixes.length === 0) {
    lines.push(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function handleFetch(repo: Repo, args: FetchArgs): Buffer {
  const wants = [...new Set(args.wants.filter((w) => isObjectId(w)))];
  const { objects, boundary, unshallow } = fetchObjects(repo, wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  // acknowledgments section
  const ackLines: string[] = ['acknowledgments\n'];
  if (args.haves.length === 0) {
    ackLines.push('NAK\n');
  } else {
    for (const h of args.haves) if (repo.objects.has(h)) ackLines.push(`ACK ${h}\n`);
    ackLines.push('ready\n');
  }
  parts.push(encodePktLines([...ackLines, 'delim']));
  // shallow-info section
  if (boundary.length > 0 || unshallow.length > 0) {
    const lines: string[] = ['shallow-info\n'];
    for (const b of boundary) lines.push(`shallow ${b}\n`);
    for (const u of unshallow) lines.push(`unshallow ${u}\n`);
    parts.push(encodePktLines([...lines, 'delim']));
  }
  // packfile section (omitted entirely when nothing is new). The pack bytes
  // for one (repo version, wants, haves, shallow, depth) are deterministic,
  // so identical fetches — the clone workload's 50 concurrent shallow clones
  // of one history — reuse one built pack.
  if (objects.size > 0) {
    const pack = cachedPack(repo, wants, args.haves, args.shallow, args.depth, objects);
    parts.push(encodePktLines(['packfile\n']));
    parts.push(Buffer.concat(sidebandPack(pack)));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** Pack cache: one built pack per (repo version, wants, haves, shallow, depth). */
const PACK_CACHE_MAX = 16;
const packCache = new Map<string, Buffer>();

function cachedPack(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | undefined,
  objects: Map<string, GitObject>,
): Buffer {
  const key = [
    repo.id, repo.version,
    [...wants].sort().join(','),
    [...haves].sort().join(','),
    [...shallow].sort().join(','),
    depth ?? '',
  ].join('|');
  const hit = packCache.get(key);
  if (hit) return hit;
  const sorted = [...objects.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, obj]) => obj);
  const pack = writePack(sorted);
  packCache.set(key, pack);
  if (packCache.size > PACK_CACHE_MAX) {
    const first = packCache.keys().next().value;
    if (first !== undefined) packCache.delete(first);
  }
  return pack;
}

export async function handleUploadPack(
  ctx: GitCtx, req: IncomingMessage, res: ServerResponse,
  owner: string, repoName: string, requestId: string,
): Promise<void> {
  if (!authed(ctx, req)) { sendJson(res, 401, { message: 'Requires authentication' }, requestId); return; }
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo || owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'could not read request body' }, requestId);
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body);
  } catch (err) {
    sendJson(res, 400, { message: `bad pkt-line: ${err instanceof Error ? err.message : String(err)}` }, requestId);
    return;
  }
  const args = parseUploadPackArgs(packets);
  if (args.command === 'ls-refs') {
    sendBytes(res, 200, UPLOAD_RESULT, handleLsRefs(repo, args));
    return;
  }
  if (args.command === 'fetch') {
    sendBytes(res, 200, UPLOAD_RESULT, handleFetch(repo, args));
    return;
  }
  sendJson(res, 400, { message: 'unknown upload-pack command' }, requestId);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function peelToCommit(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj) return undefined;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') return peelToCommit(repo, parseTag(obj.data).object);
  return undefined;
}

export async function handleReceivePack(
  ctx: GitCtx, req: IncomingMessage, res: ServerResponse,
  owner: string, repoName: string, requestId: string,
): Promise<void> {
  if (!authed(ctx, req)) { sendJson(res, 401, { message: 'Requires authentication' }, requestId); return; }
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo || owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'could not read request body' }, requestId);
    return;
  }
  // Decode pkt-lines only up to the flush that ends the command list; the
  // bytes after it are the pack (which starts "PACK" and is NOT pkt-lines).
  let packets: ReturnType<typeof decodePktLines>;
  let packStart = body.length;
  try {
    packets = [];
    let off = 0;
    let flushed = false;
    while (off < body.length) {
      if (off + 4 > body.length) throw new Error('truncated pkt-line header');
      const head = body.subarray(off, off + 4).toString('ascii');
      if (head === '0000') {
        packets.push({ kind: 'flush' });
        packStart = off + 4;
        flushed = true;
        break;
      }
      if (head === '0001') { packets.push({ kind: 'delim' }); off += 4; continue; }
      if (head === '0002') { packets.push({ kind: 'response-end' }); off += 4; continue; }
      const len = parseInt(head, 16);
      if (!Number.isFinite(len) || len < 4 || off + len > body.length) {
        throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
      }
      packets.push({ kind: 'data', payload: body.subarray(off + 4, off + len) });
      off += len;
    }
    if (!flushed) throw new Error('command list has no flush');
  } catch (err) {
    sendJson(res, 400, { message: `bad pkt-line: ${err instanceof Error ? err.message : String(err)}` }, requestId);
    return;
  }
  const commands: PushCommand[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const parts = head.split(' ');
    if (parts.length < 3 || !isObjectId(parts[0]) || !isObjectId(parts[1])) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const reportLines: string[] = [];
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) throw new Error('pack trailer checksum mismatch');
      const read = readPack(packBytes, (oid) => getObject(repo, oid));
      for (const [oid, obj] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      let ok = false;
      let reason = '';
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) { reason = 'remote ref does not exist'; }
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { reason = 'stale info'; }
        else { repo.refs.delete(cmd.ref); ok = true; }
      } else if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) { reason = 'already exists'; }
        else if (!repo.objects.has(cmd.newOid)) { reason = 'object not found'; }
        else { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
      } else {
        // Update.
        if (current === undefined) { reason = 'remote ref does not exist'; }
        else if (cmd.oldOid !== current) { reason = 'stale info'; }
        else if (!repo.objects.has(cmd.newOid)) { reason = 'object not found'; }
        else {
          const newCommit = peelToCommit(repo, cmd.newOid);
          const oldCommit = peelToCommit(repo, cmd.oldOid);
          if (newCommit && oldCommit && isAncestor(repo, oldCommit, newCommit)) {
            repo.refs.set(cmd.ref, cmd.newOid);
            ok = true;
          } else {
            reason = 'non-fast-forward';
          }
        }
      }
      reportLines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
    }
    // The repo's objects/refs may have changed: invalidate the pack cache.
    repo.version += 1;
  }
  // Sideband-framed report: band 1 carries the report pkt-line stream.
  const outer: Buffer[] = [];
  const progress = encodePktLine(Buffer.concat([Buffer.from([2]), Buffer.from('Counting objects: done.\n', 'utf8')]));
  outer.push(progress);
  for (const line of reportLines) {
    outer.push(encodePktLine(Buffer.concat([Buffer.from([1]), encodePktLine(line)])));
  }
  outer.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.from('0000', 'ascii')])));
  outer.push(Buffer.from('0000', 'ascii'));
  sendBytes(res, 200, RECEIVE_RESULT, Buffer.concat(outer));
}

export function isGitPath(path: string): boolean {
  return parseGitPath(path) !== null;
}
