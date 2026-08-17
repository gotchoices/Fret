description: The limit on how many requests the service handles at once is now checked by sending real requests and watching the counter rise and fall, instead of poking the counter directly — including when a request fails partway.
files: packages/fret/test/inflight-concurrency.spec.ts (new), packages/fret/test/profile.behavior.spec.ts, packages/fret/src/service/fret-service.ts (handleMaybeAct ~1128-1187, unchanged), docs/fret.md
difficulty: medium

## What landed

No production code changed. This is a test-quality ticket: the inbound `maybeAct` concurrency
cap (Core 16 / Edge 4) was previously "pinned" by two cases that **assigned** the private
counter (`(svc as any).inflightAct = 4`) and then fired one request. That proved only that the
comparison reads the field — it could not observe the increment/decrement pairing, which is the
whole point of a counter. Its healthy-arm assertion (`retry_after_ms !== 500`) also passed for
the wrong reason: on a non-busy reply that field is `undefined`.

Three deliverables:

- **New `packages/fret/test/inflight-concurrency.spec.ts`** (5 cases, ~32 ms wall clock) that
  drives real calls through `handleMaybeAct` into a gated activity handler.
- **`profile.behavior.spec.ts`**: the two counter-writing cases in the `Concurrent act limits`
  block deleted, replaced by a pointer comment naming the new spec and why the old version
  proved nothing (same shape as the existing `Phase 5: Preconnect budget` comment). The three
  bucket-exhaustion cases in that block are untouched — they test the token bucket.
- **`docs/fret.md`**, *Operating profiles*: the cap was described only as "Smaller/Higher inbound
  RPC concurrency" with no numbers. Now states Core 16 / Edge 4, the fixed 500 ms inflight
  sentinel, that a refused message returns before the increment, the decrement-on-error-path
  invariant, and that the cap sits behind the token bucket so both rejections share
  `diag.rejected.rateLimited`.

## How the new spec works (and why it is deterministic)

One `createMemNode()` + one `FretService` per case, no network, no `setTimeout` anywhere.

1. **A single-node service is in-cluster for every key.** After `start()` the store holds only
   self, seeded `member`, so the key's cohort is `[self]`, `neighborDistance` returns 0, and
   `routeAct` awaits the installed activity handler. A handler that blocks on a promise gate is
   the lever that holds the counter up.
2. **Every guard from the token-bucket take down to `inflightAct++` is synchronous.** So calling
   `handleMaybeAct` N times in a plain `for` loop *without awaiting* leaves the counter at
   exactly the cap when the loop returns, with the surplus already resolved busy.
3. **Fan-out sizes stay inside the token bucket** (Core 32 / Edge 8), which is taken *before* the
   inflight check and increments the same `diag.rejected.rateLimited` counter. Edge fans out 6
   (cap 4), Core fans out 20 (cap 16). This is load-bearing for the diagnostic assertion, not a
   convenience — a comment in the file says so.

## Cases to exercise when reviewing

| Case | What it pins |
|---|---|
| `edge: admits exactly 4 concurrent calls and refuses the surplus` | counter equals cap immediately post-fan-out; 2 busy replies with `retry_after_ms === 500`; 4 commit certificates; `peak === 4`; `rateLimited` rose by exactly 2 |
| `core: admits exactly 16 …` | same, Core numbers (fan-out 20) |
| `edge: the counter returns to zero once every call has settled` | `inflightAct === 0` after `Promise.all` |
| `edge: the counter returns to zero when the activity handler throws` | every call **resolves** (throw never escapes `handleMaybeAct`); each admitted result is a `NearAnchor` (`anchors` array, no `commitCertificate`) from `nearAnchorOnly`; counter back to 0 |
| `edge: a slot freed by a settled call is reusable` | one further call after settle is admitted, not busy — distinguishes "counter is 0" from "counter is 0 but the service is wedged" |

`peak` is asserted with **equality**, not `<=`, matching the idiom in
`stabilize-concurrency.spec.ts` / `preconnect-concurrency.spec.ts`: it proves the calls actually
overlapped rather than merely that none exceeded the bound. It doubles as the guard on the
single-node in-cluster premise — if a lone node ever stopped acting for its own keys, every case
would otherwise go green-but-vacuous with zero handler entries.

## Validation run

- `cd packages/fret && npx tsc --noEmit` — clean.
- New spec alone — 5 passing, 32 ms, no open handles.
- `cd packages/fret && yarn test` (foreground, no redirection) — **820 passing, 0 failing**, exit
  watchdog quiet. No pre-existing failures encountered, so no `.pre-existing-error.md` written.

## Known gaps / things worth an adversarial look

- **`(svc as any)` avoided but the private counter is still read.** Access goes through two
  narrow structural casts (`svc as unknown as { inflightAct: number }` /
  `{ handleMaybeAct(...) }`) so a rename fails to compile in the spec rather than silently
  passing. That is still reaching into private state — deliberate, since the counter has no
  public surface, and reading it is what this ticket is about. If the reviewer would rather see a
  diagnostic counter exposed, that is a production change and belongs in its own ticket.
- **Direct `handleMaybeAct` calls, not real streams.** Stated as a decision in a comment at the
  top of the spec: the counter and its guard live entirely inside that method, the inbound
  stream/handler layer is already pinned by `rpc.handler-fuzz.spec.ts` and
  `rpc.stream-errors.spec.ts`, and a two-node variant would add dial latency and flake without
  observing anything new. Worth confirming you agree with the boundary.
- **The error arm asserts `anchors` is an array, not that it is non-empty.** On a single-node
  store `nearAnchorOnly` returns self as the sole anchor today, but that is incidental to what
  the case is testing (release-on-throw), so the assertion was left loose deliberately.
- **No second full wave in the slot-reuse case.** The Edge bucket (8 tokens, 4/s refill) cannot
  fund two waves of 6, and draining it would make bucket-busy and inflight-busy replies
  indistinguishable. A comment warns a future reader not to "strengthen" this into a flaky test.
- **The `edge: counter returns to zero once settled` case partially overlaps case 1.** Kept
  separate per the plan so each invariant has its own named failure, at the cost of one extra
  fan-out.
- **Bucket-capacity coupling is implicit.** The fan-out sizes (6 / 20) are hard-coded against
  today's bucket capacities (8 / 32). If a future profile change lowers a bucket below its
  fan-out, these cases go ambiguous rather than failing loudly. Documented in the spec header,
  not enforced — flagging it rather than papering over it.
- **`getDiagnostics()` returns the live object**, so the spec snapshots the `rateLimited`
  *number* before the fan-out rather than the object. Easy to break by "tidying" into
  `const before = svc.getDiagnostics()`.
- **Test-hygiene claim to verify:** teardown lives in a `finally` per case and always opens the
  gate first, then `Promise.allSettled`s the tracked in-flight calls before stopping the service
  and node — so a failed assertion reports its own message instead of hanging the suite or
  tripping the exit watchdog with live stabilization timers. `plan/21-cleanup-tests` is
  separately introducing a shared mesh setup/teardown helper; this spec's rig is single-node and
  self-contained, so it should be trivial to fold in or leave alone.

## Review findings

(to be filled by the review stage)
