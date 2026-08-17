----
description: The routing table's peer-quality scoring and its choice of which peer to drop when the table is full are barely tested, so a regression in ranking or eviction could silently corrupt routing without any test noticing.
files: packages/fret/src/store/relevance.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/relevance.properties.spec.ts, packages/fret/test/relevance.eviction.spec.ts, packages/fret/test/service.table-persistence.spec.ts
difficulty: medium
----

Relevance scoring drives two things: which peer routing prefers, and which peer gets dropped
when the routing table hits its capacity. Today only fragments of it are tested. This ticket
adds the missing coverage. It partially addresses review findings T1 (failure-driven score
decay) and T5 (fill-to-capacity victim selection).

**This ticket is test-only.** Every assertion below describes behavior the code already has.
Two behaviors that look wrong were measured and are deliberately *not* asserted in either
direction — they are carried to `backlog/bug-frequency-credit-only-from-gossip` instead. Do
not "fix" scoring here.

### What already exists

`packages/fret/test/relevance.properties.spec.ts` covers, with `fast-check`:

- `sparsityBonus` stays inside `[sMin, sMax]`, before and after observations.
- `observeDistance` raises at least one centre's occupancy.
- `normalizedLogDistance` lands in `[0,1]`; self-distance is 0.
- `healthScore` is non-increasing in measured latency; unmeasured (`null`) sits between 0 ms
  and 1000 ms.
- `touch` / `recordSuccess` / `recordFailure` increment their counter by exactly 1 and produce
  non-negative relevance; `recordFailure` scores at or below `touch`; latency-blending rules.

Nothing covers: which ring-distance bands the sparsity bonus actually favors, bounds under
sustained decay, or eviction victim selection at any level.

### How scoring actually works (measured, not inferred)

All numbers below were produced by running the real functions from
`packages/fret/src/store/relevance.ts` under `node --import ./register.mjs`, at a fixed clock
so recency is pinned at 1. Use them as the expected values; if the implementation is later
retuned they will move together and the tests should be re-measured, not loosened.

**Relevance is a stored snapshot, not a live computation.** `PeerEntry.relevance` is written
by whichever scoring call last touched that peer and is never recomputed on read. Two
consequences the tests must respect:

- A peer's stored score does not decay while it sits idle — the recency term only bites the
  *next* time something scores it.
- The sparsity bonus is read from a single service-wide `SparsityModel` whose occupancy moves
  on every scoring call, so two peers scored at different moments were multiplied by different
  bonuses. Eviction therefore compares scores taken under different model states.

**The sparsity bonus is clamped at `sMax` for the first ~25 observations of a band.** Measured
on a fresh `createSparsityModel()`, observing `x = 0.2` repeatedly and then querying:

| observations at x=0.2 | `sparsityBonus(m, 0.2)` | `sparsityBonus(m, 0.8)` |
|---|---|---|
| 5   | 1.8000 (clamped) | 1.8000 |
| 20  | 1.8000 (clamped) | 1.8000 |
| 30  | 1.6698 | 1.8000 |
| 50  | 1.4230 | 1.8000 |
| 100 | 1.2642 | 1.8000 |
| 150 | 1.2355 | 1.8000 |

A test that observes only a handful of times proves nothing — both bands read 1.8000. Use
**50 observations**, which gives a 1.4230-vs-1.8000 margin well clear of float noise.

**`recordFailure` down-ranks and stays bounded.** 30 consecutive failures at a fixed clock:
relevance falls 0.8795 → 0.7086 monotonically and never approaches 0 or goes negative. The
floor is structural: `base` is a sum of non-negative terms and `bonus ≥ sMin = 0.7`.

**No overflow is reachable.** With `accessCount` and `successCount` at
`Number.MAX_SAFE_INTEGER` and `avgLatencyMs: 0`, `touch` returns 4.0850 — finite and small,
because the frequency term is `log1p(n)/5` and the health term is a ratio in `[0,1]`.

**`recordFailure` refreshes `lastAccess` to `now`.** Failing to reach a peer counts as recent
access for the recency term. The 0.7 decay factor still makes the net effect a down-rank, but
the recency clock is reset — pin this, it is surprising.

**Two behaviors that look wrong — do NOT assert a direction on either.** Measured at a fixed
clock, same model state, same ring position:

- `recordSuccess` repeated 10× produces a *flat* 1.4220 every time; a peer with 1 recorded
  success and a peer with 500 score identically (1.4292 each). `successCount` only feeds the
  success/failure *ratio*, which saturates after the first success.
- `recordSuccess` and `recordFailure` never touch `accessCount` — only `touch` does. A peer
  merely named in 500 inbound snapshots scores 1.6968, above a peer we successfully called 500
  times (1.4292).

So "consistent successful access up-ranks a peer" — the wording of the original plan ticket —
is **not** what the code does. Assert only the uncontroversial part (a success outranks a
failure from the same starting entry) and leave a `NOTE:` at `recordSuccess` pointing at
`backlog/bug-frequency-credit-only-from-gossip`, which owns the question of whether that is
right.

### Where "infinite relevance for neighbors" actually lives

`docs/fret.md` describes successor/predecessor members as carrying infinite relevance. There
is no infinite score in the code. It is implemented as a **protection set** in
`FretService.enforceCapacity` (`fret-service.ts:456`):

```ts
const protectedIds = this.store.protectedIdsAround(self, Math.max(2, this.cfg.m), isLiveMember);
const entries = this.store.list();
entries.sort((a, b) => a.relevance - b.relevance);
for (const e of entries) {
  if (this.store.size() <= cap) break;
  if (protectedIds.has(e.id)) continue;
  this.store.remove(e.id);
}
```

`protectedIdsAround` unions `neighborsRight(self, breadth, isLiveMember)` and
`neighborsLeft(self, breadth, isLiveMember)`. Both walks start *on* self, so self occupies one
slot per side; a `breadth` of `b` therefore protects self plus `b − 1` live members clockwise
and `b − 1` counter-clockwise. `isLiveMember` is `membership === 'member' && state !== 'dead'`,
so `foreign`, `unknown`, and `dead` peers are never protected — and because the filtered walk
*skips and keeps advancing*, a dead neighbor does not shrink the protected set, it shifts the
window one peer further out.

### Driving `enforceCapacity` from a test

`enforceCapacity` and `stabilizeOnce` are both private. The public lever is
`FretService.importTable`, which calls `enforceCapacity` after importing
(`fret-service.ts:2950`). Two shapes:

- **Populate and enforce in one step** — build a `SerializedTable` larger than `capacity` and
  `await svc.importTable(table)`. This is also the doc-promised behavior in
  *Routing table persistence*, so it is the natural primary path.
- **Enforce over state the import cannot express** — `importEntries` forces every imported
  entry to `state: 'disconnected'`, so a `dead` peer cannot be imported. For those cases write
  the state directly via `svc.getStore()` and then trigger enforcement with an *empty* import:
  `await svc.importTable({ v: 1, peerId: 'x', timestamp: 0, entries: [] })`. Add a comment at
  that call saying why it is empty, so it does not read as dead code.

Synthetic peer ids are fine — `importEntries` stores the id as a string and neither
`enforceCapacity` nor `protectedIdsAround` parses it. Place peers deterministically by writing
their 32-byte coordinates relative to `await hashPeerId(node.peerId)`; reuse the
`serializedPeer` / `tableOf` helpers already in
`packages/fret/test/service.table-persistence.spec.ts` rather than writing new ones (lift them
into a shared helper if that is cleaner than importing across spec files).

A concrete, fully determined layout for the headline case:

- `new FretService(node, { networkName, m: 3, capacity: 6 })` → protection breadth 3 → self +
  2 live members each side = 5 protected.
- Import 10 `membership: 'member'` entries: 4 placed immediately around self (2 clockwise, 2
  counter) with `relevance: 0.01`, and 6 placed far from self with **distinct** relevances
  1.0 … 6.0.
- Store size after import is 11 (the 10 imported plus self, seeded at `start()`); cap is 6, so
  5 entries are evicted.
- Expected survivors: the 5 protected (self + the 4 near peers, despite being the
  lowest-scoring entries in the table) plus exactly one far peer — the one with relevance 6.0.

### Edge cases & interactions

Cover each of these; a case named here is a test written up front.

- **Neighbor protection beats score.** The 4 near peers at relevance 0.01 survive while far
  peers at relevance 1.0–5.0 are evicted. This is the T5 finding.
- **Dead neighbor loses protection.** Mark one near peer `dead` via `getStore().setState(...)`
  and re-run enforcement: it becomes a victim. Assert *both* halves — the dead peer is gone,
  **and** the protected window shifted outward, so the next live peer clockwise is now
  protected. Do not assert the window shrank; it does not.
- **`foreign` and `unknown` near peers are not protected.** Same layout, membership changed;
  they are evicted at low relevance even though they sit adjacent to self.
- **Self is never a victim.** Self is seeded `member`, is never `dead`, and occupies a slot in
  both walks. Assert it survives every case above, including the over-subscribed one below.
- **Protected set ≥ capacity leaves the table over capacity.** With `m: 8` (up to 17 protected)
  and `capacity: 4` and ~20 live members around self, the loop finds nothing evictable and
  `store.size()` stays above the cap. This is current behavior and only reachable through
  misconfiguration (`capacity < 2m + 1`); pin it and add a `NOTE:` at `enforceCapacity`
  recording it as a tripwire — if a profile ever ships with a capacity that small, capacity
  stops being a bound.
- **Ties are arbitrary.** Equal-relevance entries evict in `Array.prototype.sort` order, which
  is not a documented contract. Every fixture must use distinct relevances; do not write a test
  whose outcome depends on tie order.
- **Enforcement before `start()`.** `enforceCapacity` `await`s `selfCoord()` rather than
  reading the cache, so import-then-enforce works before the self coordinate has been hashed.
  Cover one import on a service that has not been started; the near peers must still be
  protected, which is what proves the await is load-bearing.
- **Empty and single-entry tables.** `importTable` with no entries and with one entry, at a
  capacity of 1, must not throw and must not evict self.
- **Sparsity bonus below the clamp.** Any band-preference assertion must observe ≥ 30 times
  (use 50). State in a comment why — a reader who trims it to 5 observations gets a test that
  passes vacuously with both bands at 1.8000.
- **Bonus monotonicity holds only for repeated observation of the *same* band.** Observing at
  `x` never raises `sparsityBonus(x)` when every observation is at that same `x` (measured
  monotone across 30→150). Over an arbitrary mixed sequence it is not monotone — occupancy is
  an EMA toward the kernel value, so a centre can fall as well as rise. Write the property with
  a fixed `x`, not an arbitrary sequence.
- **`avgLatencyMs: NaN` is deliberately untested.** It would poison `healthScore` and hence
  relevance, but latency only ever originates from a local `Date.now()` difference and never
  from the wire, so it is unreachable. Say so in a comment rather than adding a guard.

### Expected test outputs

- `packages/fret/test/relevance.properties.spec.ts` — extended with the sparsity band
  preference, the sustained-decay bounds, and the overflow bound.
- `packages/fret/test/relevance.eviction.spec.ts` — new; the service-level capacity and victim
  selection cases.

### Relationship to other tickets

- `plan/6-test-coverage-gaps` also names "importing a table larger than capacity evicts the
  lowest-relevance entries". That assertion is **this** ticket's; ticket 6 keeps the
  export/import round-trip fidelity half. A note has been added to ticket 6.
- `plan/4-failure-recovery-tests` declares `prereq: relevance-scoring-tests` and covers the
  *service-level* failure path (backoff, dead-marking, recovery). Keep failure coverage here at
  the scoring seam; do not drive `stabilizeOnce` from this ticket.
- `backlog/bug-frequency-credit-only-from-gossip` owns the two flagged behaviors above.
- `backlog/debt-scoring-resurrects-removed-peers` touches the same three scoring helpers on
  `FretService`; it is about create-on-miss, not about the score, and nothing here should
  change to accommodate it.

### References

- `docs/fret.md` — "Relevance scoring and table management", "Relevance score calculation
  (bucketless sparsity model)".
- `review.html:417` (property coverage strengths), findings T1 / T5.

## TODO

### Phase 1 — scoring unit and property tests

- Extend `test/relevance.properties.spec.ts` with a sparsity band-preference test: fresh model,
  50 × `observeDistance(m, 0.2)`, assert `sparsityBonus(m, 0.2)` ≈ 1.4230 and is strictly less
  than `sparsityBonus(m, 0.8)` (= `sMax` = 1.8). Comment why 50 and not 5.
- Add a `fast-check` property: for a fixed `x`, `sparsityBonus(model, x)` is non-increasing
  across repeated `observeDistance(model, x)` calls. Note in a comment that this is *not* a
  property over arbitrary observation sequences.
- Add sustained-decay bounds: 30 consecutive `recordFailure` at a fixed clock stay in
  `(0, initial]`, are monotonically non-increasing, and end near 0.7086.
- Add the overflow bound: `touch` on an entry with `MAX_SAFE_INTEGER` counters returns a finite
  value (measured 4.0850) — assert `Number.isFinite` plus a generous upper bound, not the exact
  constant.
- Add a directional test: from one starting entry and equivalent fresh models,
  `recordSuccess(...).relevance > recordFailure(...).relevance` (measured 1.4220 vs 0.9534).
- Add a test pinning that `recordFailure` advances `lastAccess` to `now`.
- Add a `NOTE:` at `recordSuccess` in `src/store/relevance.ts` recording that success count
  beyond the first does not raise relevance and that `accessCount` is only fed by `touch`,
  pointing at `backlog/bug-frequency-credit-only-from-gossip`. Do not change behavior.

### Phase 2 — capacity and victim selection

- Add `test/relevance.eviction.spec.ts` with the `m: 3` / `capacity: 6` layout above; assert
  the exact survivor set.
- Add the dead-neighbor case, asserting both the eviction and the outward window shift.
- Add the `foreign` and `unknown` near-peer cases.
- Add the self-never-evicted assertion to every case.
- Add the over-subscribed case (`m: 8`, `capacity: 4`) and the `NOTE:` tripwire at
  `enforceCapacity`.
- Add the before-`start()` import case and the empty / single-entry cases.
- Add a one-line note to `test/service.table-persistence.spec.ts`'s header comment pointing at
  the new spec for the capacity arm, so the two files do not grow duplicate coverage.

### Phase 3 — validate

- `cd packages/fret && npx tsc --noEmit`
- `cd packages/fret && yarn test` (foreground, no redirection; add
  `| tee tickets/.logs/relevance-scoring-tests.test.log` only if output needs grepping)
- Hand off to `review/` naming any measured constant that had to be adjusted from the values
  above, and why.
