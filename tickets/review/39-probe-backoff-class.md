description: Review a new small class that tracks how long to wait before retrying a peer that failed to answer. It is a standalone piece with its own tests; nothing else in the service uses it yet.
files: packages/fret/src/service/probe-backoff.ts (new, 175 lines), packages/fret/test/probe-backoff.spec.ts (new, 15 cases), packages/fret/src/utils/expiring-map.ts (backing map, unchanged), packages/fret/src/service/fret-service.ts (unchanged — still holds its own copy of this logic)
difficulty: medium
---
`ProbeBackoff` extracts the per-peer probe backoff bookkeeping out of `FretService` into a class
with an injectable clock, following the `SizeObserver` pattern. **Purely additive: no existing file
was modified.** `git status` shows exactly two new files. `FretService` still owns its `backoffMap`
and its four private methods (`recordBackoff`, `clearBackoff`, `getBackoffPenalty`,
`pruneBackoffMap`) — rewiring is the sibling ticket `probe-backoff-rewire`.

## What was built

`ProbeBackoff` wraps an `ExpiringMap<{until, factor}>`. Public surface as specified by the plan:
`record` / `clear` / `clearAll` (writers), `isBackedOff` / `penalty` / `factor` (the three readers),
`sweep` / `prune` (the two orthogonal reapers), plus `size`, `capacity`, `baseMs`, `maxFactor`,
`retainMs` and the three `DEFAULT_*` statics. No accessor returns the raw entry and there is no
`set`, so the escalation rule lives in exactly one place.

One clock (`opts.now`, default `Date.now`) drives **both** the window stamp and the `ExpiringMap`
retention TTL. In `FretService` those are split today, which is why `test/ring-membership.spec.ts`
swaps the whole map in and `test/failure-recovery.spec.ts` hand-writes an expired `until`. Unifying
them is what lets the new spec run on a stepped fake clock with no sleeps and no libp2p node.

The three constants' doc comments were copied from `fret-service.ts:246-268` essentially unedited —
only the symbol names were re-pointed (`BACKOFF_BASE_MS` → `DEFAULT_BASE_MS`, `getBackoffPenalty` →
`penalty`, and the pinning-spec reference now names `test/probe-backoff.spec.ts`). The originals are
untouched; `probe-backoff-rewire` deletes them when it deletes the statics.

## Validation actually run

- `npx tsc --noEmit` from `packages/fret` — clean.
- `test/probe-backoff.spec.ts` alone — **15 passing, 0 failing.**
- **The full suite was NOT run.** A `BUDGET_WARNING` fired partway through this ticket. The
  justification for skipping it is that the change is additive-only — nothing imports
  `probe-backoff.ts`, no existing file was modified, and `git status` confirms it — so no existing
  spec can observe this ticket's work. That is a reasoned skip, not a verified green: **please run
  `yarn test` as the first thing in review.** If it is red, check `tickets/.pre-existing-known.md`
  before attributing it here.

## Use cases to exercise in review

The spec's floor, in the order a reviewer would want to attack it:

- **The escalation ladder.** 1, 2, 4, 8, 16, 32, capped, staying capped across further failures.
  Each step closes its own window first (`advance(baseMs * factor + 1)`) so the next `record`
  escalates rather than restarting.
- **Closed window vs forgotten entry.** The state pair that both read as `isBackedOff === false`
  and `penalty === 0`, distinguishable only by `factor`. Confusing them is the original defect
  retention exists to prevent. Covered in both directions: a closed window still escalates on the
  next failure (1 → 2), a retention-expired one restarts at 1.
- **Retention is measured from the last failure.** Two near-full retention windows back to back
  with a `record` between them; the escalation must survive ~2× `retainMs` of total elapsed time.
  This is the case that fails if `record` ever becomes a read-modify-write that skips `set`.
- **`penalty` / `isBackedOff` agreement.** Sampled at four instants per escalation step (fresh
  failure, mid-window, just-closed, retention-expired) across six steps. This is the equivalence
  that lets `probe-backoff-rewire` write the gate either way.
- **`prune` vs `sweep` orthogonality.** Each must refuse the other's job: `sweep` leaves a live
  entry for a departed peer, `prune` leaves an expired entry for a peer still present.
- **Capacity.** `capacity + 1` distinct ids, `size <= capacity` asserted after every insert.
  Deliberately no assertion on *which* id was evicted.
- **The retention inequality over the shipped defaults**, read off the statics with a
  `to.be.a('number')` guard on each so a rename cannot make the comparison vacuous.

## Known gaps — treat the tests as a floor

- **The `retainMs > baseMs * maxFactor` invariant is unenforced at runtime, by design** (matching
  `test/stabilize-budget-invariants.spec.ts`'s treatment of tick budgets — specs construct with
  deliberately small windows). It is pinned only over the *defaults*. A caller passing a
  misconfigured `retainMs` explicitly gets silent escalation resets. Recorded as a `NOTE:` in the
  constructor. Worth a second opinion on whether the sibling rewire ticket should assert it at the
  one production construction site, where the values are known-good constants.
- **`capacity` is not validated here** — it is forwarded to `ExpiringMap`, which clamps to `>= 1`
  and clamps non-finite (including `Infinity`) to 1. `this.capacity` therefore reports the
  *normalized* value, which the spec pins only for a well-formed input (8). A caller passing 0 or
  `Infinity` gets 1 with no complaint. Inherited behavior, not introduced, but undocumented on
  `ProbeBackoff` itself.
- **Clock monotonicity is not defended against** and deliberately not asserted, per the plan — a
  backwards `now` makes `until` look far in the future. `Date.now` is the only production clock.
  `ExpiringMap` carries its own `NOTE:` about a backwards step picking a wrong eviction victim.
- **No test drives `sweep`'s return value** — `ProbeBackoff.sweep()` returns `void` while
  `ExpiringMap.sweep()` returns a dropped count. That is the interface the plan specified; flagging
  it because a reviewer may want the count for diagnostics before the rewire lands.
- **The equivalence between this class and `FretService`'s live copy is argued, not tested.** No
  test compares `ProbeBackoff.penalty` against `FretService.getBackoffPenalty` on the same inputs,
  because the ticket forbids touching the service. If the reviewer wants that pinned before the
  rewire, it belongs in `probe-backoff-rewire`, where both exist at once.
- Comment fidelity is worth a skim: the plan said copy the three doc comments **unedited**, and the
  symbol renames above are a deliberate deviation (leaving them pointing at deleted-in-a-sibling
  private statics would have been worse). Confirm that call.
