// app.ts — the server: one in-memory store, one HTTP router.
//   GET /healthz            the env's boot check (200 {"ok":true}, twice)
//   /{owner}/{repo}.git/*   git smart HTTP (info/refs, upload-pack, receive-pack)
//   /api/v3/*               REST v3
//   POST /api/graphql       GraphQL v4
//   POST /mcp               MCP (JSON-RPC 2.0)
// Everything else is a JSON 404. main.ts (the env lifecycle) is untouched.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { newRequestId } from './gitobj.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, parseGitPath } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const ctx = { store, token };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    const requestId = newRequestId();

    void (async () => {
      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        // Git smart HTTP.
        const git = parseGitPath(path);
        if (git) {
          if (method === 'GET' && git.rest === 'info/refs') {
            const service = queryOf(req).get('service') ?? '';
            await handleInfoRefs(ctx, req, res, git.owner, git.repo, service, requestId);
            return;
          }
          if (method === 'POST' && git.rest === 'git-upload-pack') {
            await handleUploadPack(ctx, req, res, git.owner, git.repo, requestId);
            return;
          }
          if (method === 'POST' && git.rest === 'git-receive-pack') {
            await handleReceivePack(ctx, req, res, git.owner, git.repo, requestId);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        // GraphQL v4.
        if (path.startsWith('/api/graphql')) {
          if (await handleGraphQL(ctx, req, res)) return;
        }

        // MCP.
        if (path === '/mcp' || path.startsWith('/mcp?')) {
          if (await handleMcp(ctx, req, res)) return;
        }

        // REST v3.
        if (path.startsWith('/api/v3')) {
          if (await handleRest(ctx, req, res)) return;
        }

        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        // A handler must never take the server down (repo-survives-errors).
        try {
          if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, requestId);
          else res.end();
        } catch {
          // Nothing left to do for this request.
        }
      }
    })();
  });
}
