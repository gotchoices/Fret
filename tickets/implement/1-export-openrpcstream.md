description: The correct libp2p stream-open helper exists inside FRET but no import path reaches it, so the one downstream consumer has hand-copied it three times and one copy is wrong.
files: packages/fret/src/index.ts, packages/fret/src/rpc/protocols.ts, packages/fret/package.json, packages/fret/test/package-exports.spec.ts
difficulty: easy
----
## Status: implemented during planning

The design in this ticket had no open questions (single additive export, tradeoff already
weighed in the header above), so the change was made directly rather than deferred to a
separate implement run. What follows is the handoff a reviewer needs.

## What changed

`packages/fret/src/index.ts` (~line 145): added `openRpcStream` to the existing
`export { validateTimestamp, readAllBounded } from './rpc/protocols.js'` line, and added
`export type { Stream } from '@libp2p/interface'` alongside it — `openRpcStream`'s return type
is `Stream | undefined` and `Stream` was not previously part of the public surface, so a consumer
importing the function without the type would have no way to name its return type.

No changes to `src/rpc/protocols.ts` itself (`openRpcStream` already existed there, unchanged)
or to `package.json` — the existing `exports["."]` entry already covers the whole root barrel
`src/index.ts`, so nothing needed to change there once the re-export was added. Internal call
sites (`fret-service.ts` et al.) already import `openRpcStream` from `../rpc/protocols.js`
directly and are untouched, per the ticket's non-goal.

## Verification

- `npx tsc --noEmit` — clean.
- `yarn build` — clean; confirmed `dist/src/index.d.ts` and `dist/src/index.js` both carry
  `openRpcStream` in their `export { ... } from './rpc/protocols.js'` line.
- `yarn test` (full suite, from `packages/fret/`) — 657 passing, 0 failing.

### New test: `packages/fret/test/package-exports.spec.ts`

The ticket asked for more than "present in the source" — it asked for a check that the export is
reachable the way a real consumer would reach it, via the package's `exports` map. A literal
self-name `import ... from 'p2p-fret'` in a test file was considered and rejected: it would
resolve through the gitignored `dist/` build output, and the root `check` script runs
`typecheck` *before* `build` (`yarn typecheck && yarn build && yarn test`), so on a fresh clone
(no `dist/` yet) that import would fail `tsc --noEmit` before `dist/` ever gets built — breaking
the standard pre-release gate ordering documented in `AGENTS.md`. Instead the new spec asserts,
without touching `dist/`:
1. `package.json`'s `exports` map has exactly one key (`"."`) with `types`/`import` both pointing
   at the root entry (`./dist/src/index.d.ts` / `./dist/src/index.js`) — i.e. there is no
   restrictive subpath hiding the symbol and nothing but the root barrel to go through.
2. That root entry (`../src/index.js`, imported the same way every other spec in this suite
   imports it) exports `openRpcStream` as a function.

Together these pin "the exports map resolves to the file that has the export" without a
build-order hazard. If a self-name import is ever wanted despite the ordering cost (e.g. once
`dist/` is committed or the `check` order changes), that is a follow-up, not a gap in this
ticket's verification — the two assertions above already cover the reachability claim the ticket
asked for.

## Non-goals confirmed untouched

Downstream `optimystic` repo's three copies (`libp2p-key-network.ts#connect`,
`cohort-topic/stream-util.ts#openStream`, `libp2p-node-base.ts:1041`) are out of scope here, per
the original ticket — this only unblocks that repo's own fix.

## Edge cases & interactions

- **Fresh-clone typecheck-before-build ordering.** Covered above — the new test is deliberately
  `dist/`-independent so it doesn't regress `yarn check`'s stated order.
- **Type-only vs value export split.** `Stream` needed a separate `export type` (not bundled into
  the value-export line) since it's a type-only re-export from a different source module
  (`@libp2p/interface` directly, not `./rpc/protocols.js`); verified by `tsc --noEmit` succeeding
  with `isolatedModules`-style type/value separation intact (no `verbatimModuleSyntax` issue).
  Nothing else in FRET's public surface imports `Stream`, so this is a genuinely new re-export
  rather than a duplicate of an existing one.
- **Internal call sites must not start importing through the root barrel** — checked: `grep -rn
  "from '\.\./\.\./index"` / `"from '\.\./index"` inside `src/` finds no such import; all internal
  usages still go through `./rpc/protocols.js` (or relative equivalents) directly.
- **No behavior change** — `openRpcStream`'s body is untouched; this is purely a re-export.

## TODO

(none — implementation complete; ready for review stage)
