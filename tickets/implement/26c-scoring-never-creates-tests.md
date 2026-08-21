description: The routing-table code no longer re-adds a peer when recording a success or failure about it; tests that lock that rule in are still owed.
prereq:
files: packages/fret/src/service/fret-service.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/dead-state.spec.ts, packages/fret/test/helpers/maintenance-rig.ts
difficulty: medium
----

Fifth attempt at this work (parent `26-scoring-never-creates-tests`, then `26b`). The four prior
runs each burned their budget *reading* and landed at most a comment. This ticket exists so the
next run can go straight to writing tests. **Do not re-read `fret-service.ts` to re-verify
anything in "Confirmed" below — every line there was read directly this run.** Budget-spend order
if the run is tight: write `test/scoring-never-creates.spec.ts` first (it is self-contained), and
treat the `churn.leave.spec.ts` sibling test as the droppable arm.

### Already landed (do not redo)

- The source change itself: `applyTouch` / `applySuccess` / `applyFailure` all open
  `const entry = this.store.getById(id); if (!entry) return;` before any `await`, and the
  create-on-miss arm is gone.
- The stale comment above `churn.leave.spec.ts`'s
  `'removes the departing peer from the id map and from the ring window'` test was rewritten this
  run. It now ends by pointing at this ticket for the missing sibling case; when that test lands,
  change that last clause to name the sibling test instead.

### Confirmed this run — read directly, do not re-verify

Signatures (`packages/fret/src/service/fret-service.ts`), all `private async`, **none takes a
coordinate any more**:

| Symbol | Line | Signature |
|---|---|---|
| `applyTouch` | 566 | `(id: string): Promise<void>` |
| `noteDiscovered` | 604 | `(id: string, coord: Uint8Array): Promise<boolean>` |
| `applySuccess` | 637 | `(id: string, latencyMs?: number): Promise<void>` |
| `applyFailure` | 670 | `(id: string): Promise<void>` |
| `applyContactFailure` | 696 | `(id: string): Promise<void>` — calls `applyFailure` then `applyContactStrike` |

The `peer:disconnect` node listener is registered at `fret-service.ts:1050`, in setup that only
runs once the service has been **started**. Its body: `evt.detail` is the `PeerId` **directly**
(libp2p v3, not `{ id: PeerId }`); it reads `coordOf(id)`, computes `isNearNeighbor`, calls
`noteDisconnected(id)`, then `await this.applyFailure(id)`, then may detach an
`announceOnDeparture`. It is an **async** listener and nothing awaits it, so a test that
dispatches the event must poll (`waitFor`) rather than assert synchronously.

### Two corrections to what ticket 26b claimed

- **No existing test drives a real `peer:disconnect` event.** 26b said `dead-state.spec.ts` does;
  it does not. Its test at `dead-state.spec.ts:216`
  (`'does not strike on a bare relevance decay (the peer:disconnect path)'`) only calls
  `(svc as any).applyFailure(id, coordAt(1))` directly. The closest real idiom in the package is
  `test/membership-identify.spec.ts:149`, which dispatches a different event on a node:
  `nodeA.dispatchEvent(new CustomEvent('peer:update', { detail: ... }))`. Model the disconnect
  dispatch on that: `node.dispatchEvent(new CustomEvent('peer:disconnect', { detail: peerId }))`.
- **That `applyFailure(id, coordAt(1))` call passes a stale second argument** the signature no
  longer accepts. It compiles only because the receiver is cast to `any`. Harmless at runtime,
  misleading to read — drop the second argument while you are in the file. Grep
  `test/dead-state.spec.ts` for other `apply*(` calls carrying a coord and drop those too.

### Blocking design point for the `churn.leave.spec.ts` sibling test

`makeLeaveRig`'s receiver service is **never started** — which is exactly why the existing removal
test can observe removal in isolation, and exactly why it cannot host a real `peer:disconnect`:
with no start there is no listener. So the sibling test needs its own small rig with a *started*
receiver service. Do **not** start the shared rig's service: the other tests in that block depend
on it being unstarted so diagnostics deltas are attributable to `handleLeave` alone. (The
enclosing `describe` block name was not confirmed — read the few lines above the existing test.)

### What is left

**A. New file `packages/fret/test/scoring-never-creates.spec.ts`** — three tests, driven through
real call sites, **not** by casting to `any` to call the private helpers (a test that reaches in
pins the method's shape, not its behavior):

- *Scoring an unknown id creates nothing.* Drive each of the three helpers against an id **not**
  in the store — `applyTouch` via an announce/snapshot merge, `applySuccess` via a ping outcome,
  `applyFailure` via a `peer:disconnect`. Assert `store.size()` unchanged, `store.getById(id)`
  still `undefined`, no throw.
- *Scoring an existing entry is unaffected.* Same three paths against a peer already present;
  assert the relevance/counter outcomes still land (regression guard on the arm the source change
  did not touch).
- *Removal during a probe.* With `buildMaintenanceRig` (Core or Edge, either is fine): seed a
  peer, let a pooled maintenance pass select it as a probe target, then `store.remove(id)` before
  its outcome resolves — `rig.holdMs` on the stub reply creates the window. Assert the peer stays
  absent and nothing throws.

**B. The `churn.leave.spec.ts` sibling test** covering the two-step sequence a real graceful
departure produces: seed `departingId` as a live member at its true coordinate, send the leave
notice via the file's existing `rig.leave()` helper, then dispatch a real `peer:disconnect` for it
against a **started** receiver service. Assert after *both* steps that
`store.getById(departingId) === undefined` and that the S/P window (`rig.svc.getNeighbors(...)`,
the helper the existing test uses) excludes it.

**Prove it bites, don't assume it**: temporarily restore a create-on-miss arm in `applyFailure`
(`fret-service.ts:670`) — `const entry = this.store.getById(id) ?? this.store.upsert(id, await
this.coordOf(id));` — run just the one new test, confirm it fails, then revert. One Edit, one
targeted mocha run, one Edit back; do not run the full suite for this check.

### `maintenance-rig.ts` reference (read in full on an earlier run, unchanged since)

`buildMaintenanceRig` returns `{ node, svc, store, rig, ping, neighbors, concurrency,
setTickBudget, seedPeers, teardown }`. `rig` (a `PeerRig`) gives per-peer control of outbound
RPCs: `rig.behavior` map (`'answers' | 'hangs'`), `rig.holdMs` (delays a stub reply by N ms before
resolving — the hook for holding a probe open long enough to mutate the store mid-flight),
`rig.opened` (protocols seen per id, in order), `rig.inFlight` / `rig.highWater`.
`seedPeers(count, membership, patch?)` seeds real Ed25519-keyed peers at true ring coordinates,
dialable.

### Edge cases to keep in view (no separate tests needed unless a gap surfaces)

- A peer evicted mid-tick, between probe selection and scoring: scoring must no-op, not throw or
  resurrect.
- Two pooled tasks scoring the same peer with a `store.remove` landing between them: the second
  must no-op, no throw.
- Rediscovery still works via `peer:connect`, `peer:identify`, an inbound RPC, or a neighbor
  snapshot naming the peer — none of those goes through the scoring helpers, so this is not a
  regression risk, only context if a test seems to imply otherwise.

### TODO

- Add `test/scoring-never-creates.spec.ts` with the three tests above.
- Add the `churn.leave.spec.ts` disconnect sibling test on its own started-service rig; update the
  neighbouring comment's closing clause to name it.
- Drop the stale coord argument(s) from `test/dead-state.spec.ts`.
- Prove-then-revert the `applyFailure` bite check.
- `cd packages/fret && npx tsc --noEmit`.
- `cd packages/fret && yarn test` in the foreground, no output redirection. The source half has
  only ever been validated against four targeted specs (`churn.leave`, `rpc.snapshot-merge-cap`,
  `failure-recovery`, `dead-state` — 97 tests); a full-suite run against it is still owed.
- Any unrelated failure that surfaces: follow the `.pre-existing-known.md` /
  `.pre-existing-error.md` protocol rather than touching the test.
