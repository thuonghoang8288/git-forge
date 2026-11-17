# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/thuonghoang8288/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/thuonghoang8288/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process: git smart HTTP, REST v3, GraphQL and MCP from its own in-memory store, no external service.

## Run it

```sh
node --experimental-strip-types main.ts
```

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

---

<sub>Entered on [make.fun](https://make.fun/?ref=namj8s1b&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
