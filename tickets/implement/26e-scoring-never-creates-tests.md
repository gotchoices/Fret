description: A new test file was written to lock in the rule that recording a success or failure about a peer never re-adds it to the routing table, but it has not been compiled or run yet.
prereq:
files: packages/fret/test/scoring-never-creates.spec.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/helpers/maintenance-rig.ts
difficulty: medium
----

Seventh attempt (parents: `26-scoring-never-creates-tests`, `26b`, `26c`, `26d`). This run hit
`BUDGET_WARNING` mid-investigation but **wrote the deliverable before exiting**:
`packages/fret/test/scoring-never-creates.spec.ts` now exists with five tests. It has **never been
type-checked and never been run.** That is the whole remaining job — validate it, fix whatever it
gets wrong, then the two optional arms.

**Do not re-read `fret-service.ts`'s scoring helpers, `helpers/maintenance-rig.ts`, or
`churn.leave.spec.ts` to re-verify anything under "Confirmed" — every prior run died doing that.**
Start by running the two commands under "Do this first".

### Do this first

```
cd packages/fret && npx tsc --noEmit
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/scoring-never-creates.spec.ts" --timeout 30000
```

Fix whatever those two report. The likely failure points, in order — all guesses, none observed:

- **`store.size()` semantics in the maintenance-rig test.** The rig's service is never started, so
  self may or may not be in the store. The spec asserts `size() === 0` after removing the one
  seeded peer. If self *is* seeded, relax that to `size() === sizeBefore - 1` (capture it before
  the removal) rather than deleting the assertion.
- **`stabilizeOnce` visibility / arity.** The spec calls it through
  `(rig.svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce()`. Check the real
  signature (`fret-service.ts`, grep `stabilizeOnce`) and how `test/stabilize-concurrency.spec.ts`
  drives it; mirror that spec exactly.
- **The near-probe pass may not select the single seeded peer**, in which case the two rig tests
  assert on a probe that never happened (`successCount` stays 0). Seed 2–4 members instead of 1 if
  so, and assert on the specific id the rig recorded a ping for
  (`rig.rig.protocolsSeenBy(id)` contains `rig.ping()`).
- **Timing.** The mid-flight removal test uses `holdMs = 120` and `sleep(30)`. If the removal lands
  after the outcome was already scored, the entry gets re-created and the test fails *for the wrong
  reason* — widen `holdMs` and assert `rig.rig.inFlight > 0` before removing, rather than trusting
  the sleep.
- **`createMemNode` / `stopAll` import path** is `./helpers/libp2p.js` from `test/` — copied from
  `helpers/maintenance-rig.ts`, which imports it as `./libp2p.js` from inside `helpers/`.
- **`verbatimModuleSyntax`** is on: every cross-module *type* import must be `import type`. The new
  file already does this for `Libp2p`, `PeerId`, `MaintenanceRig`, `DigitreeStore`.

### What the new file contains

Five tests in two `describe` blocks:

1. `peer:disconnect` for an id the table has never held → nothing created, `size()` unchanged.
   This is the headline case and the one the source change exists for.
2. `peer:connect` (creates + scores), then `store.remove(id)`, then `peer:disconnect` → the peer
   stays gone. The leave sequence in miniature.
3. `peer:connect` then `peer:disconnect` on a peer that *is* held → `failureCount > 0`, entry
   survives. Regression guard on the arm the source change did not touch.
4. Maintenance rig: peer removed while its ping is in flight (`rig.holdMs`) → not re-admitted.
5. Maintenance rig: peer present when its ping completes → `successCount > 0`.

### Confirmed — read directly across runs 26d and 26e, do not re-verify

- **The source change already landed.** `applyTouch` (`fret-service.ts:566`), `applySuccess` (637)
  and `applyFailure` (670) each open `const entry = this.store.getById(id); if (!entry) return;`
  before any `await`. None takes a coordinate. `applyContactFailure` (696) calls `applyFailure`
  then `applyContactStrike`. `noteDiscovered` (604) is the creation seam.
- **`applyTouch` has only two call sites** — `fret-service.ts:1043` (the `peer:connect` listener)
  and `1983` (`mergeAnnounceSnapshot`) — and **both `store.upsert` the id synchronously immediately
  before scoring it.** So `applyTouch`'s never-create arm is **not reachable through any real call
  site**: the entry provably exists when its guard runs. Its guard is defence-in-depth against a
  removal landing in that window. Do not burn budget trying to drive it; the spec says so in a
  header comment and the handoff should repeat it. Only `applyFailure` (from `peer:disconnect`,
  `fret-service.ts:1058`) and `applySuccess` (from the probe paths, `2285` / `2497`) can be handed
  an absent id by a real caller.
- **`peer:disconnect` listener** registered at `fret-service.ts:1050`, inside `start()`-only setup.
  `evt.detail` is the `PeerId` **directly** (libp2p v3, not `{ id: PeerId }`). Body: `coordOf(id)`,
  `isNearNeighbor`, `noteDisconnected(id)`, `await this.applyFailure(id)`, then possibly a detached
  `announceOnDeparture`. It is `async` and nothing awaits it, so a test must poll.
- **No existing test drives a real `peer:disconnect`.** (Ticket 26b claimed `dead-state.spec.ts`
  does; it does not.) The event-dispatch idiom to copy is
  `test/membership-identify.spec.ts:149`: `node.dispatchEvent(new CustomEvent('peer:update', {...}))`.
- **`test/helpers/wait-for.ts:23` exports a `waitFor`** whose signature was never read. The new spec
  deliberately uses a local `until()` poll instead. If `waitFor` fits, swapping to it is a fine
  cleanup, not a requirement.
- **`buildMaintenanceRig(profile, cfg?)`** returns
  `{ node, svc, store, rig, ping(), neighbors(), concurrency(), setTickBudget(ms), seedPeers(count, membership, patch?), teardown() }`.
  Service constructed but **never started**. `node.getConnections` is overridden so every peer id
  resolves to one open stub connection (so every peer is connected and dialable). `rig.behavior`
  (`'answers' | 'hangs'`), `rig.holdMs` (delays a stub reply), `rig.opened` /
  `rig.protocolsSeenBy(id)`, `rig.inFlight`, `rig.highWater`. `seedPeers` uses real Ed25519 keys at
  true ring coordinates and calls `setAddressKnown(id, true)`. Ping stub replies `{ ok: true, ts }`;
  neighbors stub replies an empty snapshot.
- **`test/churn.leave.spec.ts`**: `describe('Leave amplification cap')`, rig factory
  `makeLeaveRig(profile = 'core')` at line 200, existing removal test at line 374. The factory's
  receiver service is **never started** (deliberately — the other tests in that block need
  diagnostics deltas attributable to `handleLeave` alone), so it **cannot** host a real
  `peer:disconnect`; the sibling test below needs its own small rig with a started service. Returns
  `{ receiver, svc, departing, departingCoord, addNode(), leave(replacements?, settleMs = 250), stop() }`.
  `dialableReplacement(rig)` sits just below it. S/P-window idiom:
  `rig.svc.getNeighbors(selfCoord, 'both', Math.max(2, (rig.svc as any).cfg.m as number))` with
  `selfCoord = await hashPeerId(rig.receiver.peerId)`. `(svc as any).setAddressKnown(id, true)`
  makes an id dialable without a real dial.
- **`test/dead-state.spec.ts`'s stale coord arguments are gone** (run 26d): all five call sites read
  `applyContactFailure(id)` / `applyFailure(id)` / `applySuccess(id, 12)`. Type-checked, **not yet
  run**.
- **The comment above `churn.leave.spec.ts`'s** `removes the departing peer from the id map and
  from the ring window` test (block at ~369-373) already explains the rule; its last clause reads
  "a real-`peer:disconnect` sibling case is still owed (see `tickets/implement/`)". If arm B lands,
  change that clause to name the sibling test.

### TODO

Phase 1 — validate what exists (this is the deliverable; everything else is droppable):

- Run the two commands under "Do this first"; fix the new spec until both are clean.
- Watch for handle leaks: the started-service tests dispatch events that can detach an
  `announceOnDeparture`. The mocha exit watchdog fails the run 10s after the last test if anything
  is still open. If it trips, the fix is in the test (make the departed peer undialable / assert
  the announce target list is empty), never in the watchdog.

Phase 2 — prove the tests bite:

- Temporarily restore a create-on-miss arm in `applyFailure` (`fret-service.ts:670`):
  `const entry = this.store.getById(id) ?? this.store.upsert(id, await this.coordOf(id));`
  Run **only** `test/scoring-never-creates.spec.ts`, confirm tests 1, 2 and 4 fail, then revert.
  One Edit, one targeted mocha run, one Edit back. Do not run the full suite for this check.

Phase 3 — droppable arms, in this order:

- The `churn.leave.spec.ts` sibling test: seed `departingId` as a live member at
  `rig.departingCoord`, send the leave notice via `rig.leave()`, then dispatch a real
  `peer:disconnect` for it against a **started** receiver service on its own rig. Assert after both
  steps that `store.getById(departingId) === undefined` and that the S/P window (the `getNeighbors`
  idiom above) excludes it. Then update the neighbouring comment's closing clause to name it.
- `cd packages/fret && yarn test` in the foreground, **no output redirection**. A full-suite run is
  still owed: the source half has only ever been validated against four targeted specs
  (`churn.leave`, `rpc.snapshot-merge-cap`, `failure-recovery`, `dead-state` — 97 tests), and run
  26d's `dead-state.spec.ts` edit has only been type-checked, never run.
- Any unrelated failure: follow the `.pre-existing-known.md` / `.pre-existing-error.md` protocol.
  Do not skip or loosen a test.

### Edge cases to keep in view (no separate tests needed unless a gap surfaces)

- A peer evicted mid-tick between probe selection and scoring: scoring must no-op, not throw or
  resurrect. Test 4 covers this; note `store.update` is never reached on that path, because the
  `getById` guard returns first.
- Two pooled tasks scoring the same peer with a `store.remove` landing between them: the second
  must no-op, no throw.
- Rediscovery still works via `peer:connect`, `peer:identify`, an inbound RPC, or a neighbor
  snapshot naming the peer — none of those goes through the scoring helpers, so this is not a
  regression risk, only context if a test seems to imply otherwise.
