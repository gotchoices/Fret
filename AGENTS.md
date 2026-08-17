## Project layout

```
Fret/                              # Yarn 4 monorepo (workspace: "packages/*")
├── docs/fret.md                   # Design document — keep up to date
├── packages/fret/                 # Only package — workspace name: "p2p-fret"
│   ├── register.mjs              # ESM loader hook for running TS directly
│   ├── src/
│   │   ├── service/fret-service.ts  # Main service (~2960 lines)
│   │   ├── service/libp2p-fret-service.ts
│   │   ├── service/{discovery,peer-discovery,dedup-cache,payload-heuristic}.ts
│   │   ├── store/{digitree-store,relevance}.ts
│   │   ├── ring/{distance,hash}.ts
│   │   ├── rpc/{protocols,neighbors,maybe-act,leave,ping}.ts
│   │   ├── selector/next-hop.ts
│   │   ├── estimate/size-estimator.ts
│   │   └── utils/{token-bucket,expiring-map,deadline,pool}.ts
│   └── test/
│       ├── helpers/libp2p.ts      # In-memory libp2p node factory
│       ├── helpers/maintenance-rig.ts # Stub-connection rig for pooled maintenance passes
│       ├── simulation/            # Deterministic simulation harness
│       └── *.spec.ts              # Mocha + Chai
├── tess/                          # Git submodule — ticket tooling
│   └── agent-rules/tickets.md    # Ticket workflow rules
└── tickets/{plan,implement,review,blocked,complete}/
```

## Development quickstart

**All commands run from `packages/fret/`** (or `yarn <script>` from root proxies there).

| Action | Command |
|---|---|
| Type-check | `cd packages/fret && npx tsc --noEmit` |
| Build | `cd packages/fret && yarn build` |
| Run all tests | `cd packages/fret && yarn test` |
| Run one test | `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/<name>.spec.ts" --timeout 30000` |
| Pre-release check | `yarn check` (typecheck + build + test, from root) |
| Cut a release | `yarn release` (from root) |

- **Workspace name**: `p2p-fret` (not `fret`, not `@nichetech/fret`)
- **Test framework**: Mocha + Chai; tests `*.spec.ts` (not `*.test.ts`)
- **TS execution**: `--import ./register.mjs` loader hook (not `tsx`, not `ts-node`)
- **No root tsconfig** — always run `tsc` from `packages/fret/`
- **Exit watchdog**: `packages/fret/.mocharc.json` requires `test/mocha-exit-watchdog.ts` into
  every mocha run started from `packages/fret/`. If the process is still alive 10s after the last
  test, it dumps what is still open to stderr and fails the run instead of hanging. Widen with
  `FRET_TEST_EXIT_GRACE_MS`. The `test` script no longer passes `--exit`, so any future handle
  leak now fails the run loudly instead of being force-quit over. Set `FRET_TEST_EXIT_TRACE=1` to
  have the watchdog capture a creation stack per live `setTimeout`/`setInterval` and print the
  stacks of whatever is still open — off by default since it wraps both globals for the whole
  process.
- **Formatting**: tabs for indent (see tsconfig + existing code)
- **NOTE: don't run `yarn format`.** There is no prettier config, so it applies prettier's
  space-indent defaults and rewrites every source file against the house style above.
  `yarn format:check` fails on all 21 source files for the same reason — known and not a
  regression. There is no lint step; `yarn check` (typecheck + build + test) is the gate.
  Revisit if a prettier config is ever added that matches the tab style.

### Releasing

`yarn release` (from root) runs full flow: preflight prompt →
`yarn bump` (bumpp: pick version, commit, tag `v<version>`, push) →
`yarn pub` (clean, build, `yarn npm publish`) → `yarn gh-release`
(GitHub release for new tag).

- **Preflight** (`scripts/release-preflight.js`) does **not** run
  `yarn check` — it asks whether you already did, the same gate
  `../quereus` and `../optimystic` use. It reports branch / dirty tree /
  upstream drift / pending-notes state, then requires typing `release`.
  Bypass with `--yes` / `-y` / `CI=1`; without a TTY and without a bypass
  it aborts rather than assuming consent. **Run `yarn check` yourself
  before releasing** — nothing else does.
- **Release notes**: drop untracked `.release-notes.pending.md` at repo
  root for release body; else GitHub auto-generates. Pending file
  consumed (deleted) on success.
- **Publish only** (no bump / GitHub release): `yarn pub`.
- **Prereqs**: authenticated `gh` CLI + npm publish rights for `p2p-fret`.

## Agent efficiency

- **Read this file first** — layout + quickstart above answer most structural questions. Don't explore to find what already documented here.
- Spawning sub-agents: pass them relevant file paths from tree above, not let them `find`/`ls`/`Glob` to discovery.
- `fret-service.ts` large (~2960 lines). Read targeted line ranges, not full file repeatedly. Key
  regions (approximate — grep the named symbol rather than trusting the number):
  - Config defaults + constructor: `constructor(` ~365
  - Lifecycle (`start` / `stop` / `setMode`): ~780–950
  - Inbound RPC registration + handlers: `registerRpcHandlers` ~955, `handleMaybeAct` ~1100
  - Maintenance fan-outs (announce, warm-up, leave): ~1280–1500
  - Stabilization tick: `stabilizeOnce` ~1850
  - Outgoing neighbor snapshot: `snapshot()` ~2160
  - Routing: `routeAct` ~2320, `iterativeLookup` ~2690
- Run tests directly — don't guess invocations. See quickstart table above.

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
- No half-baked janky parsers; use full-fledged parser or better, brainstorm with dev for another way
- Think cross-platform (browser, node, RN, etc.)
- Tabs for indent; follow existing code style

## Tasks

- If user mentions tasks (e.g. work task...), read @tasks/AGENTS.md to know what to do

Important system; write production-grade, maintainable, expressive code we don't revisit later.  Read @docs/fret.md to come up to speed — also maintain this document.

## Tickets (tess)

Project uses [tess](tess/) for AI-driven ticket management.
Read + follow ticket workflow rules in tess/agent-rules/tickets.md.
Tickets in [tickets/](tickets/) directory.
If asked to "tend the garden" or similar, see tess/agent-rules/tend.md.


## Caveman

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
