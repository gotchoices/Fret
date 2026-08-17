----
description: The limit on how many requests the service handles at once is now checked by sending real requests and watching the counter rise and fall, instead of poking the counter directly — including when a request fails partway.
files: packages/fret/test/inflight-concurrency.spec.ts (new), packages/fret/test/profile.behavior.spec.ts, packages/fret/src/service/fret-service.ts (handleMaybeAct 1128-1187, unchanged), docs/fret.md
difficulty: medium
----

## What landed

No production code changed. This was a test-quality ticket: the inbound `maybeAct` concurrency cap
(Core 16 / Edge 4) was previously "pinned" by two cases that **assigned** the private counter
(`(svc as any).inflightAct = 4`) and then fired one request. That proved only that the comparison
reads the field — it could not observe the increment/decrement pairing, which is the whole point of
a counter. Its healthy-arm assertion (`retry_after_ms !== 500`) also passed for the wrong reason: on
a non-busy reply that field is `undefined`.

Three deliverables:

- **New `packages/fret/test/inflight-concurrency.spec.ts`** (5 cases, ~32 ms wall clock) driving
  real calls through `handleMaybeAct` into a gated activity handler.
- **`profile.behavior.spec.ts`**: the two counter-writing cases in the `Concurrent act limits` block
  deleted, replaced by a pointer comment naming the new spec and why the old version proved nothing.
  The three bucket-exhaustion cases in that block are untouched — they test the token bucket.
- **`docs/fret.md`**, *Operating profiles*: the cap was described only as "Smaller/Higher inbound RPC
  concurrency" with no numbers. Now states Core 16 / Edge 4, the fixed 500 ms inflight sentinel, that
  a refused message returns before the increment, the decrement-on-error-path invariant, and that the
  cap sits behind the token bucket so both rejections share `diag.rejected.rateLimited`.

## How the spec works (and why it is deterministic)

One `createMemNode()` + one `FretService` per case, no network, no `setTimeout` anywhere.

1. **A single-node service is in-cluster for every key.** After `start()` the store holds only self,
   seeded `member`, so the key's cohort is `[self]` and `routeAct` awaits the installed activity
   handler. A handler that blocks on a promise gate is the lever that holds the counter up.
2. **Every guard from the token-bucket take down to `inflightAct++` is synchronous.** So calling
   `handleMaybeAct` N times in a plain `for` loop *without awaiting* leaves the counter at exactly
   the cap when the loop returns, with the surplus already resolved busy.
3. **Fan-out sizes stay inside the token bucket** (Core 32 / Edge 8), which is taken *before* the
   inflight check and increments the same `diag.rejected.rateLimited` counter. Edge fans out 6
   (cap 4), Core fans out 20 (cap 16). Load-bearing for the diagnostic assertion, not a convenience.

| Case | What it pins |
|---|---|
| `edge: admits exactly 4 concurrent calls and refuses the surplus` | counter equals cap immediately post-fan-out; 2 busy replies with `retry_after_ms === 500`; 4 commit certificates; `peak === 4`; `rateLimited` rose by exactly 2 |
| `core: admits exactly 16 …` | same, Core numbers (fan-out 20) |
| `edge: the counter returns to zero once every call has settled` | `inflightAct === 0` after `Promise.all` |
| `edge: the counter returns to zero when the activity handler throws` | every call **resolves**; each admitted result is a `NearAnchor` from `nearAnchorOnly`; counter back to 0 |
| `edge: a slot freed by a settled call is reusable` | one further call is admitted, not busy — distinguishes "counter is 0" from "counter is 0 but the service is wedged" |

## Review findings

### What was checked

The implement diff was read first, then the production code it claims to pin was read directly
rather than taken from the handoff: `handleMaybeAct` (`fret-service.ts:1128-1187`), `routeAct`
(`:2362`), the bucket construction (`:391-394`), `selfCoord` (`:452`), and `hashKey`
(`src/ring/hash.ts:18`). Every factual claim in the spec header and in the new `docs/fret.md`
bullet was verified against those sites: the synchronous run down to `inflightAct++`, busy-return
*before* the increment, decrement in `finally`, a throwing handler propagating out of `routeAct`
into the `NearAnchor` fallback, Core 32 / Edge 8 bucket capacities, Core 16 / Edge 4 cap. All
correct as written.

The determinism premise the whole spec rests on was audited separately, since the handoff asserted
it rather than showing it: `selfCoord` is cached from `start()` onward, and `hashKey` resolves
through multiformats' `sha256.encode`, which is synchronous under Node. That is what makes the
admitted calls advance in lockstep. See the tripwire below.

A site-claim grep across all ticket stages for the touched files found `plan/21-cleanup-tests` and
`backlog/debt-sweep-wiring-untested`; neither overlaps this work — the former is a shared-rig
refactor this spec's single-node rig can fold into later, the latter is a different block of
`profile.behavior.spec.ts`.

Gate: `yarn check` from root (typecheck → build → test, sequential). **820 passing, 0 failing**,
exit watchdog quiet. No pre-existing failures, so no `.pre-existing-error.md` was written.

### Minor — fixed in this pass

- **The comment claiming the private-access casts make a rename a compile error was false.** Both
  accessors go through `as unknown as`, which erases structural checking completely: a rename of
  `inflightAct` or `handleMaybeAct` would still compile, and would have surfaced as
  `expected undefined to equal 4` (or `handler.handleMaybeAct is not a function`) several
  assertions away from the cause. The claim was repeated in the handoff's own "known gaps"
  section as a mitigation, so it was load-bearing for how the private access was justified.
  Corrected the comment to say what actually happens, and added explicit shape guards in
  `inflight()` / `dispatch()` that throw a named error identifying the missing member.
- **`Rig.node` was exposed but never read by any case.** Dead surface on the rig interface;
  removed it along with the now-unused `Libp2p` type import. `node` is still closed over by
  `teardown`, which is the only thing that ever needed it.
- **`docs/fret.md` contradicted itself two lines apart.** The Core operating-profile bullet claimed
  "buffered backpressure with bounded queues", while the bullet this ticket *added* directly below
  it describes an immediate refusal. Grepping the service confirms there is no queue anywhere — the
  concurrency cap is the whole mechanism. Reworded the Core bullet to state bounded queueing as
  unimplemented intent rather than as fact, following the precedent already used in the same
  document for the unimplemented per-protocol stream caps.

### Conditional — recorded as a tripwire, not ticketed

- **`peak === limit` depends on the admitted calls advancing through `handleMaybeAct`'s awaits in
  lockstep.** The gate is already open by the time the first handler entry runs — `openGate()` is
  called immediately after the synchronous counter assertion, before any call has reached the
  handler — so `await rig.gate` inside the handler is a one-tick yield rather than a real block. A
  call entering several microtasks ahead of another would therefore exit before it arrived and
  `peak` would read low. It holds today because every admitted call walks an identical path and
  both of its awaits cost every call the same single tick. This is fine now and only becomes work
  if that path stops being uniform, or if the spec is ever run where the hash resolves off a
  macrotask (the browser WebCrypto path). Parked as a `NOTE:` at the `peak` assertion, naming the
  fix (an explicit "all handlers entered" barrier before `openGate`, not a sleep). Deliberately not
  applied now: a barrier that never resolves would hang past the mocha timeout with the `finally`
  unreached, which is a worse failure mode than the one it prevents, and the handoff was right to
  weight failure legibility highly here.

### Major — new ticket filed

- **`backlog/debt-rejection-diagnostics-conflated`.** The new doc bullet notes in passing that a
  bucket rejection and an inflight rejection both land in `diag.rejected.rateLimited`. Grepping
  that field showed the conflation is wider than the bullet says: **six** distinct refusals share
  it, across five protocols — four per-protocol rate limits, the inbound announce limit, and the
  concurrency cap, which is a different mechanism entirely. Every other refusal reason has its own
  counter. Filed at the representation rung rather than as a point fix: adding one ad-hoc
  `inflightBusy` field would leave the other five conflated and invite the same ticket again, so
  the ticket asks for a shape where a refusal is recorded with its cause and protocol instead of
  being hand-mapped onto a name. Two existing passages in `docs/fret.md` (the departure-notice
  section's "the only local signal is `diag.rejected.rateLimited`", and the concurrency-cap bullet)
  lean on this counter as if it were specific, and are named in the ticket.

### Checked, nothing found

- **Counter-leak paths.** Negative drift (a `finally` that decrements after a busy return),
  caching a refusal, and a leaked slot when the `catch` arm runs are each already caught by the
  existing cases — the zero-after-settle assertion would read `-2` on the first, and the
  throw-arm case asserts both resolution and a zero counter.
- **The handoff's own listed gaps, re-examined.** The direct-`handleMaybeAct` boundary, the loose
  `anchors`-is-an-array assertion, the deliberate single extra call in the slot-reuse case, and the
  implicit bucket-capacity coupling are all correctly reasoned and correctly left alone. The
  coupling one is genuinely documented in the spec header, which is the right home for it.
- **Teardown hygiene.** Verified as claimed: `finally` per case, gate opened first, tracked calls
  `allSettled` before the service and node stop. Confirmed empirically — the exit watchdog was
  quiet on both the targeted run and the full 820-test suite.
- **Other documentation.** No file besides `docs/fret.md` describes the concurrency cap, and the
  design document's own testing-strategy section deliberately does not maintain a per-spec index
  (that shape is the subject of an open arm in `plan/21-cleanup-tests`), so nothing else was stale.
