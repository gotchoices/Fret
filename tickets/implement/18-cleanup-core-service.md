description: Finish a batch of low-risk housekeeping cleanups in the core service file — deduplicate a near-copy of the connection warm-up logic, tighten a few loosely-typed spots, merge two listeners that do the same job, and make the service's "ready" promise actually resolve when the ring is ready.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/protocols.ts
difficulty: easy

<!-- resume-note -->
Sixth interrupted run. Runs 1-2: pure investigation, stopped on BUDGET_WARNING before any
edits. Run 3: landed one edit (added `FretProtocols` type export to `protocols.ts`), then hit
BUDGET_WARNING before wiring it in. Run 4: wired that type in, re-verified all prior anchors
still hold, found one new concrete duplication, hit BUDGET_WARNING again before applying
anything else. Run 5: made **zero code edits** — verified the build instead. Result:
`cd packages/fret && npx tsc --noEmit` clean, `yarn test` **1116 passing, 0 failing** — so the
runs 3-4 type-only edits (the `FretProtocols` import and field type at lines 19/210, still there
unchanged) are confirmed safe. Hit BUDGET_WARNING right after. Run 6 (this run): made **zero
code edits** — re-read `start()` (874-972), `addNodeListener`/`removeNodeListeners` (1020-1032),
`ready()` (1039), `stop()` (974-1006): every file:line anchor below is re-confirmed byte-for-byte
unchanged from run 4/5. Then looked up the one open unknown for the "type laziness" TODO — the
real libp2p event-payload types — and hit BUDGET_WARNING immediately after, before writing any
code. That lookup's answer is recorded below; it removes the only remaining unknown blocking that
TODO item. This note supersedes all previous ones; everything below is carried forward and still
accurate. **tsc/test verification was clean as of run 5's commit — do not re-run reflexively at
the very start of the next run; re-run it only after applying real code edits.**

**New this run — libp2p event payload types** (from
`node_modules/@libp2p/interface/dist/src/index.d.ts`, `Libp2pEvents` interface, ~line 219):
```
'peer:connect': CustomEvent<PeerId>;
'peer:disconnect': CustomEvent<PeerId>;
'peer:identify': CustomEvent<IdentifyResult>;
'peer:update': CustomEvent<PeerUpdate>;
```
Confirms the existing code comments ("libp2p v3: evt.detail is the PeerId directly") are correct
for connect/disconnect. `IdentifyResult` and `PeerUpdate` are exported from `@libp2p/interface`
too (import alongside `PeerId`/`Startable` at the top of `fret-service.ts`, line 1). So the
concrete typing for `nodeListeners`/`addNodeListener`/the four handlers is:
- `peer:connect`, `peer:disconnect` handlers: `(evt: CustomEvent<PeerId>) => void`
- `peer:identify` handler: `(evt: CustomEvent<IdentifyResult>) => void`
- `peer:update` handler: `(evt: CustomEvent<PeerUpdate>) => void`
Four different payload types is why `nodeListeners`/`addNodeListener` (which store all four
under one array) can't trivially drop to one non-`any` handler shape — either keep `addNodeListener`
generic (`addNodeListener<K extends keyof Libp2pEvents>(type: K, handler: (evt: Libp2pEvents[K]) => void)`,
importing `Libp2pEvents` from `@libp2p/interface`, which is the type the real `node.addEventListener`
already expects — check this compiles against `this.node`'s type, since `Libp2p<T>` extends
`TypedEventTarget<Libp2pEvents<T>>`) or leave the array typed loosely but type each individual
`addNodeListener('peer:connect', (evt: CustomEvent<PeerId>) => ...)` call site by hand and keep
`nodeListeners`'s own storage as `Array<{ type: string; handler: (evt: Event) => void }>` (narrower
than `any` — `Event` is the real base type `CustomEvent` extends, not an escape hatch) with a cast
only at the two `addEventListener`/`removeEventListener` call sites inside
`addNodeListener`/`removeNodeListeners` themselves (those casts are structurally necessary — a
heterogeneous array of specifically-typed handlers cannot line up with libp2p's own overloaded
`addEventListener<K>` signature without one). The generic-method route is cleaner if it type-checks;
try that first.

## Done this run (already landed in the working tree — do not redo)

- `packages/fret/src/service/fret-service.ts` line 19: import changed from
  `import { makeProtocols, validateTimestamp } from '../rpc/protocols.js';` to
  `import { makeProtocols, validateTimestamp, type FretProtocols } from '../rpc/protocols.js';`
  — matches house style in this file (see `PeerEntry`/`PeerPatch`, `PoolResult`,
  `NextHopOptions` — all merged `type X` into their value import rather than separate lines).
- `packages/fret/src/service/fret-service.ts` line 210: field type changed from
  `private readonly protocols: ReturnType<typeof import('../rpc/protocols.js').makeProtocols>;`
  to `private readonly protocols: FretProtocols;`.
- Both edits are same-line replacements — no line-count shift, so every file:line anchor below
  and from prior runs is still accurate at time of writing.
- This closes out the "inline `import()` type" TODO item completely.

## Confirmed file:line anchors (re-verified this run, current file state)

- `nodeListeners` field: line 203 — `private readonly nodeListeners: Array<{ type: string; handler: (evt: any) => void }> = [];`
- `firstStabilizeDone` field: line 339 — `private firstStabilizeDone = false;`
- `protocols` field: line 210 — now `FretProtocols` (done, see above).
- `start()`: lines 874-972. Listener registration order unchanged: post-bootstrap one-shot
  `peer:connect` at 902, per-connect `peer:connect` at 907, `peer:disconnect` at 923,
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
- `startStabilizationLoop`: lines 1945-1971 (confirmed full body in run 3). `tick()` closure
  captures `const gen = this.runGen;` once at line 1947 — **the ready-gate design below mirrors
  this exact pattern**, capturing the deferred object the same way `gen` is captured, for the
  same reason. Success path at 1954-1958:
  ```
  if (!this.firstStabilizeDone) {
      this.firstStabilizeDone = true;
      this.detach(this.proactiveAnnounceOnStart(), 'proactiveAnnounceOnStart');
  }
  ```
  This is exactly where the ready-gate resolve call goes.
- `pingWarmupTargets` (lines 1461-1486): **already exists** as the shared pooled-ping fan-out
  helper — takes `(ids, label, budget?)`, filters dialable, pools at `maintenanceConcurrency`
  against the run signal. This is NOT what the "factor onto one shared helper" TODO is about;
  see next section for what actually still duplicates.
- `preconnectNeighbors` (lines 1488-1500) and `activePreconnectTick` (lines 1527-1539): read in
  full this run (not reached in runs 1-2). Both already call `pingWarmupTargets` for the actual
  ping fan-out — the duplication is upstream of that, in how each gathers its target id list:
  ```ts
  // preconnectNeighbors, lines 1494-1497:
  const ids = Array.from(new Set([
      ...this.store.neighborsRight(selfCoord, Math.min(6, this.cfg.m)),
      ...this.store.neighborsLeft(selfCoord, Math.min(6, this.cfg.m))
  ])).filter((id) => id !== selfStr);

  // activePreconnectTick, lines 1533-1536:
  const ids = Array.from(new Set([
      ...this.store.neighborsRight(selfCoord, Math.min(12, this.cfg.m)),
      ...this.store.neighborsLeft(selfCoord, Math.min(12, this.cfg.m))
  ])).filter((id) => id !== selfStr);
  ```
  Identical shape, differing only in the radius constant (6 vs 12) — both preceded by the same
  `const selfCoord = await this.selfCoord(); const selfStr = this.node.peerId.toString();`.
  **Concrete, ready-to-apply fix:**
  ```ts
  private async warmupTargetIds(radius: number): Promise<string[]> {
      const selfCoord = await this.selfCoord();
      const selfStr = this.node.peerId.toString();
      return Array.from(new Set([
          ...this.store.neighborsRight(selfCoord, Math.min(radius, this.cfg.m)),
          ...this.store.neighborsLeft(selfCoord, Math.min(radius, this.cfg.m))
      ])).filter((id) => id !== selfStr);
  }
  ```
  Then in `preconnectNeighbors`: replace lines 1490-1497 with
  `const ids = await this.warmupTargetIds(6);` (keep the existing `await this.pingWarmupTargets(ids, 'preconnectNeighbors');` after it).
  In `activePreconnectTick`: replace lines 1529-1536 with
  `const ids = await this.warmupTargetIds(12);` (keep the `budget` line and the
  `pingWarmupTargets(ids, 'active preconnect', budget)` call after it).
  Both call sites keep their own comment about "unfiltered store walk... ring reads use
  getNeighbors" — fold that comment into the new `warmupTargetIds` doc comment instead of
  repeating it at both call sites.

## Not yet located (next agent must still find, if not already obvious from above)

- Nothing outstanding — `preconnectNeighbors`/`pingWarmupTargets` now fully read (see above).

## Already done (from the original plan/18 pass and run 3 — no further action, listed only so
it isn't re-investigated)

- `console.warn`/`console.error` → `log.error(...)` conversion: done.
- Broken-indentation import block fix: done.
- Dead `nextSuccessor`/`nextPredecessor` methods: already absent, nothing to do.
- `(res as any).busy` / `Record<string, any>` metadata type-laziness items from the *original*
  ticket text: not present in current file, already clean, don't re-search.
- Inline `import()` type at line 210 → named `FretProtocols` import: **done this run**, see above.

## Concrete design for the `ready()` TODO (derived run 3, re-confirmed run 4, not yet applied)

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

No existing test references `.ready(` (grepped `test/` this run — zero matches), so this is
greenfield: nothing to reconcile against, just implement to the design below.

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

## Remaining scope, still to do in this file

- **Apply the `warmupTargetIds` extraction above** — the actual remaining "factor onto one
  shared helper" work; concrete diff is written out, just needs typing in.
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
- **Wire `ready()`** per the concrete design above (fields, `start()`, `stop()`,
  `startStabilizationLoop()`, `ready()` body) — code is drafted above, just needs typing in.

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
- `warmupTargetIds` extraction: confirm `preconnectNeighbors` still uses radius 6 and
  `activePreconnectTick` still uses radius 12 post-refactor (easy to transpose by accident).

## TODO tasks

- Apply the `warmupTargetIds(radius)` extraction (design above) to de-duplicate
  `preconnectNeighbors` and `activePreconnectTick`.
- Merge the two `peer:connect` listeners into one.
- Replace `evt: any` / `type as any` on the node-listener registry and its four handler bodies
  with real libp2p event types.
- Wire `ready()` per the concrete design above (fields, `start()`, `stop()`,
  `startStabilizationLoop()`, `ready()` body).
- Run `cd packages/fret && npx tsc --noEmit` and `yarn test` again after applying the edits
  above, before handoff. (Run 5 already confirmed a clean baseline — tsc clean, 1116 passing,
  0 failing — so this is a re-check after new code changes, not the first-ever run.)

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
