description: Finish a batch of low-risk housekeeping cleanups in the core service file — deduplicate a near-copy of the connection warm-up logic, tighten a few loosely-typed spots, merge two listeners that do the same job, and make the service's "ready" promise actually resolve when the ring is ready.
files: packages/fret/src/service/fret-service.ts
difficulty: easy

<!-- resume-note -->
Third interrupted run. First two runs stopped on BUDGET_WARNING before any edits (pure
investigation). This run made exactly ONE edit before hitting BUDGET_WARNING again — see
"Done this run" below — then stopped per the workflow rule (no further tool calls once a
ticket update starts). This note supersedes the previous one; everything below is carried
forward and still accurate.

## Done this run (already landed in the working tree — do not redo)

- `packages/fret/src/rpc/protocols.ts`: added a named type export right after `makeProtocols`
  (around line 38-39):
  ```ts
  /** Network-namespaced protocol id set produced by {@link makeProtocols}. */
  export type FretProtocols = ReturnType<typeof makeProtocols>;
  ```
  Purely additive — new export, nothing consumes it yet, cannot have broken anything. This is
  the named type the `import type()` replacement TODO (see below) needs; the wiring at the
  `fret-service.ts` call site is NOT done yet.

## Immediate next step (small, do this first)

Wire the type just added into `fret-service.ts`:
1. Add `FretProtocols` to the existing type-only import from `../rpc/protocols.js` at line 19:
   currently `import { makeProtocols, validateTimestamp } from '../rpc/protocols.js';` — add
   `import type { FretProtocols } from '../rpc/protocols.js';` as a separate type-only import
   line (or merge via `import { makeProtocols, validateTimestamp, type FretProtocols } from ...`
   — check house style elsewhere in the file for which form is preferred, both compile).
2. Replace line 210:
   ```ts
   private readonly protocols: ReturnType<typeof import('../rpc/protocols.js').makeProtocols>;
   ```
   with:
   ```ts
   private readonly protocols: FretProtocols;
   ```
That closes out the last piece of the "inline `import()` type" TODO item.

## Confirmed file:line anchors (re-verified this run, current file state)

- `nodeListeners` field: line 203 — `private readonly nodeListeners: Array<{ type: string; handler: (evt: any) => void }> = [];`
- `firstStabilizeDone` field: line 339 — `private firstStabilizeDone = false;`
- `protocols` field (inline `import()` type to replace): line 210.
- `start()`: lines 874-972. Listener registration order unchanged from before: post-bootstrap
  one-shot `peer:connect` at 902, per-connect `peer:connect` at 907, `peer:disconnect` at 923,
  `peer:identify` at 944, `peer:update` at 958. `firstStabilizeDone = false` reset at line 886
  (right after `this.postBootstrapAnnounced = false;`) — **this is the spot to also reset the
  new ready-gate state**, see design below.
- `stop()`: lines 974-1006. Order: `started=false` → `runGen++` → `stopped=true` →
  `clearLoopTimers()` → `runAbort?.abort()` (line 994) → `removeNodeListeners()` →
  `unregisterRpcHandlers()` → `sendLeaveToNeighbors()` → clear `backoffMap`/`departureDebounce`.
  **The ready-gate resolve-on-stop belongs right around the `runAbort?.abort()` line** — same
  "unblock other pending run-scoped work" role that abort plays for RPCs.
- `addNodeListener`: lines 1020-1024 (`(evt: any) => void` param; `type as any` cast at 1023).
  `removeNodeListeners`: lines 1026-1032 (`type as any` cast again inside).
- `ready()` stub: line 1039 — `async ready(): Promise<void> {}`.
- `startStabilizationLoop`: lines 1945-1971 (confirmed full body this run, was only grepped
  before). `tick()` closure captures `const gen = this.runGen;` once at line 1947 — **the
  ready-gate design below mirrors this exact pattern**, capturing the deferred object the same
  way `gen` is captured, for the same reason (see design). Success path at 1954-1958:
  ```
  if (!this.firstStabilizeDone) {
      this.firstStabilizeDone = true;
      this.detach(this.proactiveAnnounceOnStart(), 'proactiveAnnounceOnStart');
  }
  ```
  This is exactly where the ready-gate resolve call goes.

## Not yet located (next agent must still find these — never reached this run either)

- `preconnectNeighbors` (~1488) and the active-tick warm-up body (~1538) — not read either run.
- `pingWarmupTargets` — not read either run.

## Already done (from the original plan/18 pass — no further action, listed only so it isn't re-investigated)

- `console.warn`/`console.error` → `log.error(...)` conversion: done.
- Broken-indentation import block fix: done.
- Dead `nextSuccessor`/`nextPredecessor` methods: already absent, nothing to do.
- `(res as any).busy` / `Record<string, any>` metadata type-laziness items from the *original*
  ticket text: not present in current file, already clean, don't re-search.

## Concrete design for the `ready()` TODO (derived this run, not yet applied)

Requirement recap (edge cases from the ticket body, unchanged): pre-start call must not throw
and must resolve once the *first* stabilize pass after `start()` completes; a late call after
that pass already ran must resolve immediately; `stop()` while callers are pending must settle
them (resolve, not hang/reject); a restart must gate on the *new* run's first pass, not resolve
instantly off a stale flag.

The core trick: a plain boolean flag can't distinguish "resolve the promise object a caller is
currently holding" from "hand out a fresh pending promise for the next run" — and a naive
"always make a fresh promise in `start()`" breaks the pre-start caller, whose held promise
reference would then never settle (nothing points to it anymore). Fix: only replace the
deferred in `start()` when the previous one has already settled; otherwise reuse it (covers
both "first ever start()" and "ready() was called before start() and is still waiting").

**1. New fields, next to `firstStabilizeDone` (line 339):**
```ts
/** Resolves once this run's first stabilization pass completes; see `ready()`. */
private readyDeferred: { promise: Promise<void>; resolve: () => void } = (() => {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => { resolve = res; });
	return { promise, resolve };
})();
/** Tracks whether `readyDeferred` has already settled, so `start()` knows whether to reuse it
 *  (a pre-start caller's promise must still be the one that later resolves) or replace it with
 *  a fresh pending one (a restart must gate on its own first stabilize pass, not a stale one). */
private readyResolved = false;
```

**2. In `start()`, right after `this.firstStabilizeDone = false;` (line 886):**
```ts
if (this.readyResolved) {
	// Prior run already settled this gate — a restart needs its own, fresh one.
	this.readyDeferred = (() => {
		let resolve!: () => void;
		const promise = new Promise<void>((res) => { resolve = res; });
		return { promise, resolve };
	})();
}
this.readyResolved = false;
```
(Worth factoring the IIFE into a tiny module-level `createReadyDeferred()` helper used in both
the field initializer and here, rather than duplicating it — check the top of the file for
where other small module-level helpers live before deciding where to put it.)

**3. In `stop()`, alongside `this.runAbort?.abort();` (line 994):**
```ts
this.readyDeferred.resolve();
this.readyResolved = true;
```

**4. In `startStabilizationLoop()`:** capture the deferred object at the same point `gen` is
captured (line 1947), so a tick already in flight from a *previous* run always resolves *that
run's* (by then already-settled, so this is a harmless no-op) deferred rather than the new
run's — exactly the same staleness problem `gen` solves for the reschedule check, solved the
same way:
```ts
const gen = this.runGen;
const readyDeferred = this.readyDeferred;
```
Then in the success path (lines 1954-1958):
```ts
if (!this.firstStabilizeDone) {
	this.firstStabilizeDone = true;
	this.detach(this.proactiveAnnounceOnStart(), 'proactiveAnnounceOnStart');
	readyDeferred.resolve();
	this.readyResolved = true;
}
```

**5. `ready()` itself (line 1039):**
```ts
ready(): Promise<void> {
	return this.readyDeferred.promise;
}
```
(Drop `async` — returning the promise directly is simpler and equivalent; no `await` needed
inside.)

**Why this satisfies every edge case:**
- Pre-start call: gets the constructor-initialized pending deferred; `readyResolved` starts
  `false` so the first `start()` reuses that exact object rather than orphaning it.
- Late call after first pass (same run): `readyDeferred.promise` is already settled, so the
  returned promise resolves on the next microtask — no waiting.
- `stop()` mid-wait: resolves unconditionally, so any pending `ready()` callers settle instead
  of hanging. Not a reject, matching "gate for early queries, not a liveness promise."
  Resolving an already-resolved promise a moment later (if a just-completed tick beat `stop()`
  to it) is a no-op per standard Promise semantics — no guard needed for that race.
- Restart: `stop()` already forced `readyResolved = true`, so the next `start()` sees that and
  manufactures a fresh pending deferred — new callers gate on the new run's own first pass.
  Callers that awaited `ready()` before the restart already had their (old) promise resolved by
  the `stop()` that preceded it, so nothing is left dangling.

This design is complete enough to type in directly; the only open question is exactly where to
place a shared `createReadyDeferred()` helper (or just accept the small duplication between the
field initializer and the `start()` branch — it's two lines, arguably not worth extracting).

## Remaining scope, still to do in this file (TODO items 1-3, unchanged from original ticket)

- **Factor `preconnectNeighbors` (~1488) and the active-tick warm-up body (~1538) onto one
  shared private helper.** Both gather a target peer-id list and hand it to
  `pingWarmupTargets`. Not yet located this run or last — find them first.
- **Merge the two `peer:connect` listeners** (`start()` lines 902 and 907) into one — same
  trigger, no reason to register twice and pay two dispatches per event. Preserve both
  behaviors: the one-shot post-bootstrap announce (guarded by `postBootstrapAnnounced`) and the
  per-connect store upsert / state / proof-of-life work.
- **Type laziness to tighten:**
  - `nodeListeners: Array<{ type: string; handler: (evt: any) => void }>` (line 203) and the
    four listener bodies typed `(evt: any) =>` (`peer:connect` 907, `peer:disconnect` 923,
    `peer:identify` 944, `peer:update` 958), plus `addNodeListener`'s own `(evt: any)` param
    (1021) and its two `type as any` casts (1023, 1029). Pull real libp2p event types from
    `@libp2p/interface` instead of `any`. Comments at ~910/~926 already note "libp2p v3:
    evt.detail is the PeerId directly, not `{ id: PeerId }`" — the tightened type must reflect
    that shape, not `{ id: PeerId }`.
  - Inline `import()` type at line 210 (`private readonly protocols: ReturnType<typeof
    import('../rpc/protocols.js').makeProtocols>;`) → replace with a named top-level `import
    type { ... } from '../rpc/protocols.js'` per `AGENTS.md`'s "don't use inline `import()`
    unless dynamically loading" rule.

## Edge cases & interactions (unchanged from original ticket, still the acceptance bar)

- `ready()` before `start()`: must not throw; resolves once first stabilize pass completes
  after `start()` runs. — covered by design above.
- `ready()` after first pass already done: resolves immediately. — covered above.
- `stop()` with `ready()` callers pending: they settle (resolve), don't hang. — covered above.
- Restart (`stop()` then `start()` again): `ready()` gates on the *new* run's first pass, not a
  stale flag. — covered above.
- Consolidated `peer:connect` listener: confirm the post-bootstrap-announce half still fires
  only once (`postBootstrapAnnounced` guard) and the store-upsert half still runs on every
  connect, including the same event that trips the one-time announce.
- Typed event handlers: confirm the tightened type matches the real libp2p payload shape
  (`evt.detail` is the PeerId directly per the existing comments), not a guessed shape.

## TODO tasks

- Factor `preconnectNeighbors` and the active-tick warm-up body onto one shared private helper.
- Merge the two `peer:connect` listeners into one.
- Replace `evt: any` / `type as any` on the node-listener registry and its four handler bodies
  with real libp2p event types; replace the inline `import()` type at ~210 with a named type
  import.
- Wire `ready()` per the concrete design above (fields, `start()`, `stop()`,
  `startStabilizationLoop()`, `ready()` body) — code is drafted above, just needs typing in and
  verifying against `test/*.spec.ts` if any exercise `ready()` (grep for `.ready(` in `test/`
  first — not checked yet this run).
- Run `cd packages/fret && npx tsc --noEmit` and `yarn test` before handoff.

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
