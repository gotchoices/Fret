description: The correct libp2p stream-open helper exists inside FRET but no import path reaches it, so the one downstream consumer has hand-copied it three times and one copy is wrong.
files: packages/fret/src/index.ts, packages/fret/src/rpc/protocols.ts, packages/fret/package.json, packages/fret/test/package-exports.spec.ts
difficulty: easy
----
## Status: implemented during planning; verified during implement stage

The design had no open questions (single additive export, tradeoff already weighed in the
original ticket header), so the change was made directly at plan stage rather than deferred.
This implement-stage pass re-verified the landed change end-to-end (see *Verification* below) —
no code changes were needed.

## What changed

`packages/fret/src/index.ts` (~line 146): added `openRpcStream` to the existing
`export { validateTimestamp, readAllBounded } from './rpc/protocols.js'` line, and added
`export type { Stream } from '@libp2p/interface'` alongside it — `openRpcStream`'s return type
is `Stream | undefined` and `Stream` was not previously part of the public surface, so a consumer
importing the function without the type would have no way to name its return type.

No changes to `src/rpc/protocols.ts` itself (`openRpcStream` already existed there, unchanged)
or to `package.json` — the existing `exports["."]` entry already covers the whole root barrel
`src/index.ts`. Internal call sites (`fret-service.ts` et al.) already import `openRpcStream`
from `../rpc/protocols.js` directly and are untouched, per the ticket's non-goal.

## Verification (this stage)

- `npx tsc --noEmit` (from `packages/fret/`) — clean.
- `yarn build` — clean.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/package-exports.spec.ts" --timeout 30000` — 2 passing.
- `yarn test` (full suite) — 690 passing, 0 failing.

### New test: `packages/fret/test/package-exports.spec.ts`

The ticket asked for more than "present in the source" — it asked for a check that the export is
reachable the way a real consumer would reach it, via the package's `exports` map. A literal
self-name `import ... from 'p2p-fret'` in a test file was considered and rejected: it would
resolve through the gitignored `dist/` build output, and the root `check` script runs
`typecheck` *before* `build` (`yarn typecheck && yarn build && yarn test`), so on a fresh clone
(no `dist/` yet) that import would fail `tsc --noEmit` before `dist/` ever gets built — breaking
the standard pre-release gate ordering documented in `AGENTS.md`. Instead the spec asserts,
without touching `dist/`:
1. `package.json`'s `exports` map has exactly one key (`"."`) with `types`/`import` both pointing
   at the root entry (`./dist/src/index.d.ts` / `./dist/src/index.js`) — i.e. there is no
   restrictive subpath hiding the symbol and nothing but the root barrel to go through.
2. That root entry (`../src/index.js`, imported the same way every other spec in this suite
   imports it) exports `openRpcStream` as a function.

Together these pin "the exports map resolves to the file that has the export" without a
build-order hazard. If a self-name import is ever wanted despite the ordering cost (e.g. once
`dist/` is committed or the `check` order changes), that is a follow-up, not a gap in this
ticket's verification.

## Non-goals confirmed untouched

Downstream `optimystic` repo's three copies (`libp2p-key-network.ts#connect`,
`cohort-topic/stream-util.ts#openStream`, `libp2p-node-base.ts:1041`) are out of scope here, per
the original ticket — this only unblocks that repo's own fix.

## Edge cases & interactions

- **Fresh-clone typecheck-before-build ordering.** Covered above — the new test is deliberately
  `dist/`-independent so it doesn't regress `yarn check`'s stated order.
- **Type-only vs value export split.** `Stream` needed a separate `export type` (not bundled into
  the value-export line) since it's a type-only re-export from a different source module
  (`@libp2p/interface` directly, not `./rpc/protocols.js`); confirmed by `tsc --noEmit` succeeding
  with type/value separation intact. Nothing else in FRET's public surface imports `Stream`, so
  this is a genuinely new re-export rather than a duplicate of an existing one.
- **Internal call sites must not start importing through the root barrel** — checked: no
  `from '../../index'` / `from '../index'` import inside `src/`; all internal usages still go
  through `./rpc/protocols.js` (or relative equivalents) directly.
- **No behavior change** — `openRpcStream`'s body is untouched; this is purely a re-export.

## Suggested review focus

- Confirm the two re-exports at `src/index.ts:146-147` are the only diff against the prior public
  surface (i.e. no accidental widening beyond `openRpcStream` + `Stream`).
- Spot-check that `package-exports.spec.ts`'s assumption ("exports map has exactly one key, `.`")
  still matches `package.json` if a reviewer is also touching that file in a sibling ticket.
- No known gaps or deferred edge cases beyond what's stated above; this is a small, fully-tested
  additive change.

## Review findings

(none yet — pending review pass)
