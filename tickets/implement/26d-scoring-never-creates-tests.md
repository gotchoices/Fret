description: The routing-table code no longer re-adds a peer when recording a success or failure about it; tests that lock that rule in are still owed.
prereq:
files: packages/fret/src/service/fret-service.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/helpers/maintenance-rig.ts
difficulty: medium
----

Sixth attempt (parents: `26-scoring-never-creates-tests`, `26b`, `26c`). Every prior run burned its
budget *reading* and landed at most a comment or a mechanical edit; this run hit `BUDGET_WARNING`
on its fourth tool call, before writing any test. **Everything under "Confirmed" below was read
directly — do not re-read `fret-service.ts`, `helpers/maintenance-rig.ts`, or `churn.leave.spec.ts`
to re-verify any of it.** Go straight to writing `test/scoring-never-creates.spec.ts`; if the run
is tight, that file is the whole deliverable and the `churn.leave.spec.ts` sibling test is the
droppable arm.

### Already landed (do not redo)

- **The source change itself.** `applyTouch` / `applySuccess` / `applyFailure` all open
  `const entry = this.store.getById(id); if (!entry) return;` before any `await`, and the
  create-on-miss arm is gone.
- **The stale comment above `churn.leave.spec.ts`'s** `removes the departing peer from the id map
  and from the ring window` test (block at lines ~369-373). It already explains the rule and its
  last clause reads "a real-`peer:disconnect` sibling case is still owed (see `tickets/implement/`)".
  When arm B below lands, change that clause to name the sibling test instead.
- **The stale coord arguments in `test/dead-state.spec.ts` are gone** (this run). All five call
  sites now read `applyContactFailure(id)` / `applyFailure(id)` / `applySuccess(id, 12)`.
  `coordAt` is still used 25x elsewhere in that file, so the helper stays. `npx tsc --noEmit`
  passes with those edits in the tree. Nothing else in the package calls the private helpers.

### Confirmed — read directly, do not re-verify

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
`announceOnDeparture`. It is an **async** listener and nothing awaits it, so a test that dispatches
the event must poll (`waitFor`) rather than assert synchronously.

**No existing test drives a real `peer:disconnect` event.** (Ticket 26b claimed `dead-state.spec.ts`
does; it does not — that file only called the private helpers directly.) The closest real idiom in
the package is `test/membership-identify.spec.ts:149`, which dispatches a different event on a node:
`nodeA.dispatchEvent(new CustomEvent('peer:update', { detail: ... }))`. Model the disconnect
dispatch on that: `node.dispatchEvent(new CustomEvent('peer:disconnect', { detail: peerId }))`.

### Confirmed rig APIs (read in full this run)

**`test/helpers/maintenance-rig.ts`** — `buildMaintenanceRig(profile, cfg?)` returns
`{ node, svc, store, rig, ping, neighbors, concurrency, setTickBudget, seedPeers, teardown }`.

- The service is **constructed but never started**; passes are driven directly.
- `node.getConnections` is overridden so *every* peer id resolves to one open stub connection —
  every peer is therefore connected and dialable.
- `rig` (a `PeerRig`) gives per-peer control of outbound RPCs: `rig.behavior` map
  (`'answers' | 'hangs'`), `rig.holdMs` (delays a stub reply by N ms before resolving — the hook
  for holding a probe open long enough to mutate the store mid-flight), `rig.opened` (protocols
  seen per id, in call order), `rig.inFlight` / `rig.highWater`.
- `seedPeers(count, membership, patch?)` seeds real Ed25519-keyed peers at true ring coordinates
  and calls `(svc as any).setAddressKnown(id, true)`, so they are dialable.
- The ping stub replies `{ ok: true, ts }`; the neighbors stub replies an empty snapshot. Both are
  length-prefix framed via `lp.encode.single`.

**`test/churn.leave.spec.ts`** — inside `describe('Leave amplification cap')` (rig factory at
line 200, the existing removal test at line 374):

- `makeLeaveRig(profile = 'core')` builds a receiver memory node whose `CoreFretService` is
  **never started**, registering *only* `registerLeave`. Returns
  `{ receiver, svc, departing, departingCoord, addNode(), leave(replacements?, settleMs = 250), stop() }`.
- `dialableReplacement(rig)` (just below the factory) adds a node and dials it from the receiver,
  returning a dialable peer id.
- The existing removal test's S/P-window idiom, reusable verbatim:
  `rig.svc.getNeighbors(selfCoord, 'both', Math.max(2, (rig.svc as any).cfg.m as number))`
  with `selfCoord = await hashPeerId(rig.receiver.peerId)`.
- `(svc as any).setAddressKnown(id, true)` is how a test makes an id dialable without a real dial.

### Blocking design point for the `churn.leave.spec.ts` sibling test

`makeLeaveRig`'s receiver service is **never started** — which is exactly why the existing removal
test can observe removal in isolation, and exactly why it cannot host a real `peer:disconnect`:
with no start there is no listener. So the sibling test needs its own small rig with a *started*
receiver service. Do **not** start the shared rig's service: the other tests in
`describe('Leave amplification cap')` depend on it being unstarted so diagnostics deltas are
attributable to `handleLeave` alone.

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
departure produces: seed `departingId` as a live member at `rig.departingCoord`, send the leave
notice via `rig.leave()`, then dispatch a real `peer:disconnect` for it against a **started**
receiver service. Assert after *both* steps that `store.getById(departingId) === undefined` and
that the S/P window (the `getNeighbors` idiom above) excludes it. Then update the neighbouring
comment's closing clause to name this test.

**Prove it bites, don't assume it**: temporarily restore a create-on-miss arm in `applyFailure`
(`fret-service.ts:670`) — `const entry = this.store.getById(id) ?? this.store.upsert(id, await
this.coordOf(id));` — run just the one new test, confirm it fails, then revert. One Edit, one
targeted mocha run, one Edit back; do not run the full suite for this check.

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
- Prove-then-revert the `applyFailure` bite check.
- `cd packages/fret && npx tsc --noEmit`.
- `cd packages/fret && yarn test` in the foreground, no output redirection. **A full-suite run is
  still owed** — the source half has only ever been validated against four targeted specs
  (`churn.leave`, `rpc.snapshot-merge-cap`, `failure-recovery`, `dead-state` — 97 tests), and this
  run's `dead-state.spec.ts` edit has only been type-checked, not run.
- Any unrelated failure that surfaces: follow the `.pre-existing-known.md` /
  `.pre-existing-error.md` protocol rather than touching the test.
