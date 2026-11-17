// mcp.ts — the Model Context Protocol endpoint at POST /mcp (JSON-RPC 2.0,
// Streamable HTTP, JSON answers). Speaks the modern 2026-07-28 era
// (server/discover) and the legacy handshake era (initialize +
// notifications/initialized). Tools act on the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import {
  issueJson, pullJson, repoJson, squashMerge,
  type Issue, type Pull, type Store,
} from './store.ts';

export interface McpCtx {
  store: Store;
  token: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '0.1.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(data: unknown): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return {
    content: [{ type: 'text', text }],
    structuredContent: data,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function handleMcp(ctx: McpCtx, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.url !== '/mcp' && !req.url?.startsWith('/mcp?')) return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (ctx.token && (req.headers.authorization ?? '') !== `Bearer ${ctx.token}`) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: isRecord(body) ? (body.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = body.id ?? null;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};

  // Notifications (no id) are accepted with 202 and no body.
  if (id === null || id === undefined) {
    res.writeHead(202);
    res.end();
    return true;
  }

  const ok = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const err = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (method === 'server/discover') {
    ok({
      resultType: 'discover',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const negotiated = requested && SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    ok({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }

  if (method === 'ping') {
    ok({});
    return true;
  }

  if (method === 'tools/list') {
    ok({ tools: TOOLS });
    return true;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      err(-32601, `Method not found: ${name}`);
      return true;
    }
    const missing = tool.inputSchema.required.filter((r) => args[r] === undefined);
    if (missing.length > 0) {
      ok(toolError(`Missing required argument(s): ${missing.join(', ')}`));
      return true;
    }
    try {
      const result = await runTool(ctx, name, args);
      ok(result);
    } catch (e) {
      ok(toolError(e instanceof Error ? e.message : String(e)));
    }
    return true;
  }

  err(-32601, `Method not found: ${method}`);
  return true;
}

async function runTool(ctx: McpCtx, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const store = ctx.store;
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : '';

  if (name === 'create_repo') {
    const repoNameArg = typeof args.name === 'string' ? args.name : '';
    if (!repoNameArg) throw new Error('name is required');
    const created = store.createRepo(VIEWER.login, repoNameArg, {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    if (created === 'exists') throw new Error('Repository already exists');
    return toolResult(repoJson(created));
  }

  const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
  if (!repo) throw new Error('Repository not found');

  if (name === 'get_repo') {
    return toolResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const title = typeof args.title === 'string' ? args.title : '';
    const issue: Issue = {
      number: repo.nextIssue++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      user: VIEWER.login,
      seq: store.nextSeq(),
      comments: [],
    };
    repo.issues.push(issue);
    return toolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((i) => state === 'all' || i.state === state);
    return toolResult({ issues: list.map((i) => issueJson(repo, i)) });
  }
  if (name === 'create_pull_request') {
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) throw new Error('Head or base branch not found');
    const existing = repo.pulls.find((p) => p.state === 'open' && p.head.ref === head && p.base.ref === base);
    if (existing) return toolResult(pullJson(repo, existing));
    const pull: Pull = {
      number: repo.nextPull++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user: VIEWER.login,
      seq: store.nextSeq(),
      comments: [],
    };
    repo.pulls.push(pull);
    return toolResult(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) throw new Error('Pull request not found');
    const merged = squashMerge(repo, store, pull);
    if (!merged.ok) throw new Error(merged.reason);
    return toolResult(pullJson(repo, pull));
  }
  throw new Error(`Unknown tool: ${name}`);
}
