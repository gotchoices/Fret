----
description: Finish a batch of low-risk housekeeping cleanups in the core service file — deduplicate a near-copy of the connection warm-up logic, tighten a few loosely-typed spots, merge two listeners that do the same job, and make the service's "ready" promise actually resolve when the ring is ready.
files: packages/fret/src/service/fret-service.ts
difficulty: easy
----
<!-- resume-note -->
Prior agent run stopped on a BUDGET_WARNING before making any edits — pure investigation only,
no code changed, no tests run. All four TODO items below are still fully open. No log file was
written (nothing ran long enough to need one); the findings below are everything that prior run
learned, inlined so the next run does not have to re-discover them.

Confirmed file:line anchors (read directly, current file state):
- `nodeListeners` field: line 203 — `private readonly nodeListeners: Array<{ type: string; handler: (evt: any) => void }> = [];`
- `protocols` field (the inline `import()` type to replace): line 210 — `private readonly protocols: ReturnType<typeof import('../rpc/protocols.js').makeProtocols>;`
- `addNodeListener` method: lines 1020-1024 — `(evt: any) => void` param, `type as any` cast at 1023 (`node.addEventListener`) and again at 1029 in `removeNodeListeners` (`node.removeEventListener`).
- `start()` body: lines 874-972. Registers listeners in this order:
  - line 902: one-shot `peer:connect` (post-bootstrap announce, guarded by `postBootstrapAnnounced`) — no typed `evt` param used, handler ignores its arg entirely.
  - line 907: second `peer:connect` (`evt: any`) — store upsert / state / proof-of-life. This is the one to merge the above into.
  - line 923: `peer:disconnect` (`evt: any`).
  - line 944: `peer:identify` (`evt: any`) — reads `evt?.detail?.peerId`.
  - line 958: `peer:update` (`evt: any`) — reads `evt?.detail?.peer`.
  - Both `peer:connect` handlers already carry the comment "libp2p v3: evt.detail is the PeerId directly, not `{ id: PeerId }`" at lines ~910/~926 (ticket's edge-cases section references this — confirm it's still accurate when typing).
- `ready()` stub: line 1039 — `async ready(): Promise<void> {}`.
- `firstStabilizeDone`: declared line 339 (`private firstStabilizeDone = false;`), reset in `start()` at line 886, set `true` inside the stabilization tick's success path at lines 1955-1956 (grepped, not yet read in full context — read a wider window around there before wiring `ready()`, to see exactly what scope that assignment sits in and what's available to resolve a promise from).
- `stop()`: lines 974-1006. Order: `started=false` → `runGen++` → `stopped=true` → `clearLoopTimers()` → `runAbort?.abort()` → `removeNodeListeners()` → `unregisterRpcHandlers()` → `sendLeaveToNeighbors()` → clear `backoffMap`/`departureDebounce`. `ready()`'s stop-while-pending resolution should probably hook in around the `runAbort?.abort()` point, but this wasn't investigated — verify against the actual edge-case requirements below.

Not yet located (next agent must still find these — ticket's approximate line numbers below are unverified this run):
- `preconnectNeighbors` (~1488) and the active-tick warm-up body (~1538) — not read.
- `pingWarmupTargets` — not read.
- The exact code at stabilization-tick success (~1950-1960 area) — only the two `firstStabilizeDone` line numbers are confirmed via grep, not the surrounding logic.

Everything else below (the actual TODO items) is unchanged from the original ticket — re-read it fresh, don't assume partial progress on any item.

Continuation of `plan/18-cleanup-core-service` (deleted; this ticket carries the remaining scope after a budget-limited planning pass). That pass already **applied** two of the original items directly to `packages/fret/src/service/fret-service.ts` — no further action needed on them, listed here only so the remaining work isn't re-investigated:

- **Done:** the ~8 `console.warn`/`console.error` call sites now go through the module's `log.error(...)` (the `@libp2p/logger` instance already used everywhere else in the file), matching the existing `'%s failed - %e'`-style format strings. `@libp2p/logger`'s `Logger` type has no `warn` level, so former `console.warn` sites became `log.error` too, same as every other error path in this file.
- **Done:** the broken-indentation import block (was ~34-42, four-space instead of tab) is fixed. A second location the original ticket named (~563-567) was checked and is already correctly tab-indented — nothing there to fix; a repo-wide scan (`grep -nP '^\t* {2,}\S'`) found no other space-indented code lines in the file.
- **Not present / already gone:** the dead private `nextSuccessor`/`nextPredecessor` methods named in the original ticket (~1115-1122) do not exist anywhere in `fret-service.ts` (grepped, no matches) — they were evidently removed in an earlier pass. Nothing to do here.

Remaining scope, still to do in this file:

- **`preconnectNeighbors` (~1488) near-duplicates the active-mode tick body** (`startActivePreconnectLoop`'s per-tick logic, ~1538 area) — both gather a target peer-id list and hand it to `pingWarmupTargets`. Factor the shared "pick warm-up targets, pool-ping them, log failures" logic into one private helper both call, rather than two independent copies that can drift.
- **Two separate `peer:connect` listeners** registered back-to-back via `addNodeListener('peer:connect', ...)` at ~902 (one-time post-bootstrap announce) and ~907 (per-connect store upsert / state / proof-of-life). Consolidate into one listener with two responsibilities in its body — same trigger, no reason to register twice and pay two dispatches per event.
- **Type laziness to tighten:**
  - `nodeListeners: Array<{ type: string; handler: (evt: any) => void }>` (~203) and the four listener bodies that type their event parameter `(evt: any) =>` (`peer:connect` ~907, `peer:disconnect` ~923, `peer:identify` ~944, `peer:update` ~958), plus `addNodeListener`'s own `(evt: any)` param (~1021) and its two `type as any` casts when calling `node.addEventListener`/`removeEventListener` (~1023, ~1029). libp2p's `Libp2p` node is a typed `EventEmitter` — pull the real event-map type (`Libp2p['addEventListener']` event names / `CustomEvent<PeerId>` payload shapes, e.g. from `@libp2p/interface`) and use it instead of `any` for both the listener registry's handler signature and each listener body's `evt` parameter.
  - The inline `import()` type at ~210: `private readonly protocols: ReturnType<typeof import('../rpc/protocols.js').makeProtocols>;`. Project convention (`AGENTS.md`: "Don't use inline `import()` unless dynamically loading") wants a named type import instead — add a proper top-level `import type { ... } from '../rpc/protocols.js'` (or export a `Protocols`-style return type from `protocols.ts` if one doesn't already exist) and reference that here.
  - Note: the two other type-laziness items the original ticket named — `(res as any).busy` and `Record<string, any>` metadata — were **not found** in the current file (metadata is already typed `Record<string, unknown>` throughout, e.g. ~211, ~1824, ~3249-3258; no `(res as any)` pattern exists). Already clean; don't re-search for these.
- **`ready()` is an empty stub** (~1039: `async ready(): Promise<void> {}`) even though the design doc (`docs/fret.md`, Service shell & lifecycle) promises a ready gate for early queries. `firstStabilizeDone` (~339, set true at ~1956 inside the stabilization tick's success path) already tracks "first stabilization pass completed" — wire `ready()` to resolve once that flag flips (e.g. a promise created in `start()`, resolved from the same spot that sets `firstStabilizeDone = true`, and already-resolved immediately if `ready()` is called after that point). No functional change intended beyond `ready()` gaining real behavior; a `stop()` mid-wait should not leave `ready()` hanging forever — resolve (not reject) on stop too, since the design doc frames this as a gate for early queries, not a liveness promise.

## Edge cases & interactions

- `ready()` called *before* `start()`: must not throw; should return a promise that resolves once the first stabilize pass completes after `start()` runs.
- `ready()` called *after* the first stabilize pass already completed (late caller): must resolve immediately, not wait for a second pass.
- `stop()` called while one or more `ready()` callers are still pending: those promises must settle (resolve, not hang) rather than leaking pending awaits — mirrors how `runAbort` unblocks other pending run-scoped work on `stop()`.
- A restart (`stop()` then `start()` again): `ready()` must gate on the *new* run's first stabilize pass, not resolve instantly off a stale flag from the previous run (consistent with `firstStabilizeDone` being reset to `false` in `start()`/`setMode` per ~886).
- Consolidated `peer:connect` listener: confirm event ordering/independence between the former two handlers is preserved — the post-bootstrap-announce half must still fire only once (`postBootstrapAnnounced` guard) and the store-upsert half must still run on every connect, including the same event that trips the one-time announce.
- Typed event handlers: confirm the real libp2p event payload shape (`evt.detail`) still matches what the current `any`-typed code assumes (`evt?.detail?.toString?.()` for peer id) — the comments at ~910/~926 already note "libp2p v3: evt.detail is the PeerId directly, not `{ id: PeerId }`"; the tightened type must reflect that, not `{ id: PeerId }`.

TODO tasks:

- Factor `preconnectNeighbors` and the active-tick warm-up body onto one shared private helper.
- Merge the two `peer:connect` listeners into one.
- Replace `evt: any` / `type as any` on the node-listener registry and its four handler bodies with real libp2p event types; replace the inline `import()` type at ~210 with a named type import.
- Wire `ready()` to resolve on `firstStabilizeDone`, correctly handling pre-start, late-caller, stop-while-pending, and restart cases per Edge cases above.
- Run `cd packages/fret && npx tsc --noEmit` and `yarn test` before handoff.
