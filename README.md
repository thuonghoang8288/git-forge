# git-forge

[![bounty](https://img.shields.io/badge/bounty-github--core--clone--01-blue)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://img.shields.io/badge/rank-pending-lightgrey)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://img.shields.io/badge/reward-pending-lightgrey)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in one Node process, built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

Referral: `namj8s1b`

## What it serves

One process serves all four surfaces from its own in-memory store — no
external database or service, no UI:

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 `ls-refs` and
  `fetch` (with shallow/deepen), v0 `receive-pack` with `report-status` and
  `side-band-64k`, packfiles with SHA-1 checksums.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  refs, labels, issues, comments and pull requests (including squash merge
  with 3-way conflict detection).
- **GraphQL v4** at `/api/graphql` — viewer, repository, node, issues and
  pull requests with cursor pagination, mutations, and `__type`
  introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, modern
  `server/discover` (2026-07-28) and the legacy `initialize` handshake,
  with six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`).

## Run

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must name the environment origin; the entry binds an
ephemeral port, registers it, and exits when the environment says done.
`MAKEFUN_SHOP_TOKEN` is the bearer token every API call must carry.

## Layout

- `main.ts` — the entry ↔ environment lifecycle (bind, register, poll done).
- `app.ts` — the HTTP router.
- `gitproto.ts` — git smart HTTP.
- `gitobj.ts` — git objects, packfiles, pkt-lines.
- `store.ts` — the in-memory store and git operations.
- `rest.ts` — REST v3.
- `graphql.ts` — the GraphQL executor.
- `mcp.ts` — the MCP endpoint.
- `scenario.ts` — the seeded scenario identities (viewer login, etc.).

## License

MIT.
