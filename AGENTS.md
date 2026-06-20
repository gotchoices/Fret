## Project layout

```
Fret/                              # Yarn 4 monorepo (workspace: "packages/*")
├── docs/fret.md                   # Design document — keep up to date
├── packages/fret/                 # Only package — workspace name: "p2p-fret"
│   ├── register.mjs              # ESM loader hook for running TS directly
│   ├── src/
│   │   ├── service/fret-service.ts  # Main service (~1400 lines)
│   │   ├── service/libp2p-fret-service.ts
│   │   ├── service/{discovery,peer-discovery,dedup-cache,payload-heuristic}.ts
│   │   ├── store/{digitree-store,relevance}.ts
│   │   ├── ring/{distance,hash}.ts
│   │   ├── rpc/{protocols,neighbors,maybe-act,leave,ping}.ts
│   │   ├── selector/next-hop.ts
│   │   ├── estimate/size-estimator.ts
│   │   └── utils/token-bucket.ts
│   └── test/
│       ├── helpers/libp2p.ts      # In-memory libp2p node factory
│       ├── simulation/            # Deterministic simulation harness
│       └── *.spec.ts              # Mocha + Chai
├── tess/                          # Git submodule — ticket tooling
│   └── agent-rules/tickets.md    # Ticket workflow rules
└── tickets/{plan,implement,review,blocked,complete}/
```

## Development quickstart

**All commands run from `packages/fret/`** (or use `yarn <script>` from root which proxies there).

| Action | Command |
|---|---|
| Type-check | `cd packages/fret && npx tsc --noEmit` |
| Build | `cd packages/fret && yarn build` |
| Run all tests | `cd packages/fret && yarn test` |
| Run one test | `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/<name>.spec.ts" --timeout 30000` |
| Pre-release check | `yarn check` (typecheck + build + test, from root) |
| Cut a release | `yarn release` (from root) |

- **Workspace name**: `p2p-fret` (not `fret`, not `@nichetech/fret`)
- **Test framework**: Mocha + Chai; tests are `*.spec.ts` (not `*.test.ts`)
- **TS execution**: uses `--import ./register.mjs` loader hook (not `tsx`, not `ts-node`)
- **No root tsconfig** — always run `tsc` from `packages/fret/`
- **Formatting**: tabs for indentation (see tsconfig and existing code)

### Releasing

`yarn release` (from root) runs the full flow: 5s abort window → `yarn check`
(typecheck + build + test) → `yarn bump` (bumpp: pick version, commit, tag
`v<version>`, push) → `yarn pub` (clean, build, `yarn npm publish`) →
`yarn gh-release` (GitHub release for the new tag).

- **Release notes**: drop an untracked `.release-notes.pending.md` at the repo
  root to use as the release body; otherwise GitHub auto-generates notes. The
  pending file is consumed (deleted) on success.
- **Publish only** (no version bump / GitHub release): `yarn pub`.
- **Prereqs**: authenticated `gh` CLI and npm publish rights for `p2p-fret`.

## Agent efficiency

- **Read this file first** — the project layout and quickstart above answer most structural questions. Don't explore to discover what's already documented here.
- When spawning sub-agents, pass them the relevant file paths from the tree above rather than letting them `find`/`ls`/`Glob` their way to discovery.
- `fret-service.ts` is large (~1400 lines). Read targeted line ranges rather than the full file multiple times. Key regions:
  - Constructor + profile config: lines ~1–150
  - RPC handlers: lines ~300–600
  - Stabilization: lines ~680–790
  - Neighbor snapshot: lines ~790–950
  - Iterative lookup: lines ~1200+
- Run tests directly — don't guess at invocations. See the quickstart table above.

## General

- Use lowercase SQL reserved words (e.g., `select * from Table`)
- Don't use inline `import()` unless dynamically loading
- Don't create summary documents; update existing documentation
- Stay DRY
- No lengthy summaries
- Don't worry about backwards compatibility yet
- Use yarn
- Prefix unused arguments with `_`
- Enclose `case` blocks in braces if any consts/variables
- Prefix calls to unused promises (micro-tasks) with `void`
- ES Modules
- Don't be type lazy - avoid `any`
- Don't eat exceptions w/o at least logging; exceptions should be exceptional - not control flow
- Small, single-purpose functions/methods.  Decomposed sub-functions over grouped code sections
- No half-baked janky parsers; use a full-fledged parser or better, brainstorm with the dev for another way
- Think cross-platform (browser, node, RN, etc.)
- Tabs for indentation; follow existing code style

## Tasks

- If the user mentions tasks (e.g. work task...), read @tasks/AGENTS.md to know what to do

This is an important system; write production-grade, maintainable, and expressive code that we don't have to revisit later.  Read @docs/fret.md to come up to speed — also maintain this document.

## Tickets (tess)

This project uses [tess](tess/) for AI-driven ticket management.
Read and follow the ticket workflow rules in tess/agent-rules/tickets.md.
Tickets are in the [tickets/](tickets/) directory.
