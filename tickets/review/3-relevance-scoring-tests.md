description: Added the missing tests for how the routing table ranks peers and picks which one to drop when it is full, so a future change to either cannot silently break routing.
files: packages/fret/test/relevance.eviction.spec.ts, packages/fret/test/relevance.properties.spec.ts, packages/fret/test/helpers/serialized-table.ts, packages/fret/test/service.table-persistence.spec.ts, packages/fret/src/store/relevance.ts, packages/fret/src/service/fret-service.ts
difficulty: medium
----

Test-only ticket. No behavior changed — the only edits to `src/` are two `NOTE:` comments.
Everything asserted is behavior the code already had, measured by running the real functions
before writing the assertion.

## What landed

**`test/relevance.eviction.spec.ts`** (new, 9 tests) — service-level capacity enforcement and
victim selection. `docs/fret.md` calls successor/predecessor members "infinite relevance";
there is no infinite score in the code, it is a *protection set* built in
`FretService.enforceCapacity` (`fret-service.ts:456`) from the live members immediately around
self. These pin that, including where protection is refused.

**`test/relevance.properties.spec.ts`** (extended, +6 tests) — the scoring functions
themselves: sparsity band preference, bonus monotonicity, sustained-failure bounds, the
counter-overflow bound, success-outranks-failure, and `recordFailure` refreshing `lastAccess`.

**`test/helpers/serialized-table.ts`** (new) — `serializedPeer` / `tableOf`, lifted out of
`service.table-persistence.spec.ts` (which now imports them) because two specs build
`SerializedTable` fixtures. `serializedPeer` now takes either a full 32-byte coordinate or a
single byte; the byte form is what the persistence spec was already using.

**`src/store/relevance.ts`** — a `NOTE:` on `recordSuccess` recording that repeated success does
not raise relevance and that `accessCount` is fed only by `touch`, pointing at
`backlog/bug-frequency-credit-only-from-gossip`. No behavior change.

**`src/service/fret-service.ts`** — a `NOTE:` tripwire at `enforceCapacity` recording that
protection wins over the cap, so a capacity below the protected-set size leaves the table over
capacity.

## Validation

- `cd packages/fret && node node_modules/typescript/bin/tsc --noEmit` — clean.
  (`npx tsc --noEmit` fetches an unrelated TypeScript 6 and prints its help instead of
  compiling; use the local binary or `yarn build`.)
- `cd packages/fret && yarn test` — **680 passing, 0 failing**, ~4 min. No pre-existing
  failures surfaced, so `tickets/.pre-existing-error.md` was not written.

## Measured constants that were adjusted from the ticket

The ticket carried measured values from an earlier session. Re-measured against the current
code at a fixed clock (`FIXED_NOW`, so recency is exactly 1), `x = 0.5`, starting from a fresh
entry with `avgLatencyMs: null` — these came out **lower** than the ticket's numbers, and the
tests use the re-measured ones:

| Quantity | Ticket | Measured now | Used |
|---|---|---|---|
| `recordFailure` ×1 | 0.8795 | **0.6300** | 0.6300 |
| `recordFailure` ×30 | 0.7086 | **0.5861** | 0.5861 |
| `recordSuccess` vs `recordFailure` | 1.4220 / 0.9534 | **1.2600 / 0.6300** | both |
| `recordSuccess` repeated (flat) | 1.4220 | **1.2600** | not asserted (by design) |
| gossip-only vs 500 successful calls | 1.6968 / 1.4292 | **1.5276 / 1.2600** | not asserted (by design) |
| `sparsityBonus` after 50 obs at x=0.2 | 1.4230 | **1.4230** | 1.4230 |
| whole clamp table (5/20/30/50/100/150 obs) | as tabulated | identical | in a comment |
| `touch` at `MAX_SAFE_INTEGER` counters | 4.0850 | **4.0850** | bound only |

The ratios differ between the failure and the success rows, so this is not a single global
rescale — the earlier session's fixture entry differed (most likely a non-null `avgLatencyMs`
and/or non-zero counters; a `null` latency takes the neutral 0.5 health penalty and reproduces
0.6300 exactly). **The direction and every qualitative conclusion in the ticket held** — the
clamp table, monotone decay, boundedness, flat repeated success, and gossip outscoring
successful contact are all reproduced. Reviewer: if you re-measure, pin the clock and state the
fixture; a floating `Date.now()` moves every one of these.

Two structural facts also came out different from the ticket's prose:

- **Protected-set size.** Ticket said breadth `b` protects "self plus `b − 1` per side" (correct)
  but then estimated "m: 8 → up to 17 protected" and "`capacity < 2m + 1`". The real ceiling is
  `2·max(2,m) − 1` = **15** at m 8, so over-subscription needs `capacity < 2m − 1`. The test
  asserts the exact 15 and the `NOTE:` states `2m − 1`.
- **Ticket's headline layout gave all four near peers `relevance: 0.01`.** Its own edge-case rule
  says every fixture must use distinct relevances, so they are 0.01/0.02/0.03/0.04 here. Outcome
  is unchanged (all four are protected) but nothing now depends on `Array.prototype.sort` tie
  order.

## How to read / drive these tests

`enforceCapacity` and `stabilizeOnce` are private. The public lever is `importTable`, which runs
enforcement after importing. Two shapes, both in the spec:

- **Import and enforce in one call** — build a `SerializedTable` larger than `capacity`. Used for
  the headline case and the `foreign` / `unknown` cases.
- **Populate directly, then enforce with an empty import** — `importEntries` forces every record
  to `state: 'disconnected'`, so a `dead` peer has no snapshot representation. `place()` writes
  through `getStore()` and `enforce()` triggers with `tableOf([], 'enforce-trigger')`.

Peers are placed with `ringOffset(self, ±n)` from `test/helpers/ring.ts` — exact modulo 2^256,
so the ring order around self holds even when the arithmetic wraps. Near peers sit at ±1/±2 and
far peers at +1000…+6000, giving a fully determined clockwise order.

**Services are started and then immediately stopped** before each fixture is placed
(`seededService`). `start()` is the real path that seeds self into the store as `member` at
relevance 0, but it also arms the stabilization loop, whose first tick fires immediately and
would score fixture peers underneath the assertions. `stop()` bumps the run generation and
aborts the run signal, so nothing re-arms and an in-flight tick scores nothing. `enforceCapacity`
reads no run state. **This is the main judgement call in the spec** — if you would rather see
enforcement exercised inside a live service, that is a real alternative, at the cost of either
flakiness or a stub rig.

## Cases covered (each also asserts self survives)

- Neighbor protection beats score: `m: 3`, `capacity: 6`, 10 imported peers + self = 11 → 6.
  The four *lowest*-scoring entries in the table survive; far peers at 1.0–5.0 are evicted.
- Dead neighbor loses protection, and the window **shifts outward** rather than shrinking —
  `far-1` survives at relevance 1.0 while `far-2`…`far-5` are evicted.
- `foreign` and `unknown` adjacent peers get no protection; the window reaches past both.
- Self is never a victim, asserted alongside the fact that self is the single lowest-scoring
  entry in the table (`upsert` seeds relevance 0), so it is the first entry the loop considers.
- Protected set ≥ capacity: `m: 8`, `capacity: 4`, 20 live members → settles at 15, over cap.
- Import before `start()`: no self entry and no cached self coordinate; the near peers are still
  protected, which is what proves the `await selfCoord()` is load-bearing.
- Empty import, and a single-entry table at `capacity: 1`.

## Known gaps — please treat these as a floor

- **No test drives enforcement through the real maintenance path.** Every case reaches
  `enforceCapacity` via `importTable`. The other four call sites (`seedFromPeerStore`,
  `seedFromBootstraps`, the snapshot-merge paths, `stabilizeOnce`) are unexercised here.
  `plan/4-failure-recovery-tests` owns the service-level failure path; nobody currently owns
  "enforcement after a merge".
- **Tie order is deliberately untested.** Equal-relevance entries evict in `Array.prototype.sort`
  order, which is not a contract. Every fixture uses distinct relevances instead.
- **`avgLatencyMs: NaN` is deliberately untested** — a comment in the property spec says why
  (latency only ever originates from a local `Date.now()` difference, never from the wire).
- **The two flagged scoring behaviors are asserted in neither direction**, per the ticket:
  repeated success being flat, and `recordSuccess`/`recordFailure` never touching `accessCount`.
  They are recorded in the `NOTE:` at `recordSuccess` and owned by
  `backlog/bug-frequency-credit-only-from-gossip`. If you disagree with leaving them unpinned,
  that is a decision for that ticket, not a fix here.
- **The band-preference test asserts an exact 1.4230** (±1e-4), and the sustained-decay test
  exact endpoints. Intentional per the ticket — if the model is retuned these must be
  re-measured, not loosened — but it does mean a weight change breaks three tests loudly.
- **The `seededService` start→stop pattern is unusual** and is the thing most worth a second
  opinion (see above).
- Suite wall-clock is ~4 min; the new specs contribute ~300 ms.

## Tripwires parked

- `NOTE:` at `FretService.enforceCapacity` — protection wins over the cap, so `capacity < 2m − 1`
  leaves the table permanently over capacity. Only reachable by misconfiguration today
  (shipped m 8 / capacity 2048); if a profile ever ships a capacity that small, capacity stops
  being a bound.
- `NOTE:` at `recordSuccess` in `src/store/relevance.ts` — success count beyond the first does
  not raise relevance, and `accessCount` is fed only by `touch`. Not conditional and not a
  tripwire in the strict sense; it is a pointer to the backlog ticket that owns the question,
  placed at the site a future reader will meet it.

## Review findings

(To be filled by the review stage.)
