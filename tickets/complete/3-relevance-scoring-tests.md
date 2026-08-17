----
description: Added the missing tests for how the routing table ranks peers and picks which one to drop when it is full, so a future change to either cannot silently break routing.
files: packages/fret/test/relevance.eviction.spec.ts, packages/fret/test/relevance.properties.spec.ts, packages/fret/test/helpers/serialized-table.ts, packages/fret/test/service.table-persistence.spec.ts, packages/fret/src/store/relevance.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
----

Test-only ticket. No behavior changed — the only edits to `src/` are two `NOTE:` comments.
Everything asserted is behavior the code already had, measured by running the real functions
before writing the assertion.

## What landed

**`test/relevance.eviction.spec.ts`** (new, 10 tests) — service-level capacity enforcement and
victim selection. `docs/fret.md` called successor/predecessor members "infinite relevance";
there is no infinite score in the code, it is a *protection set* built in
`FretService.enforceCapacity` (`fret-service.ts:456`) from the live members immediately around
self. These pin that, including where protection is refused.

**`test/relevance.properties.spec.ts`** (extended, +6 tests) — the scoring functions
themselves: sparsity band preference, bonus monotonicity, sustained-failure bounds, the
counter-overflow bound, success-outranks-failure, and `recordFailure` refreshing `lastAccess`.

**`test/helpers/serialized-table.ts`** (new) — `serializedPeer` / `tableOf`, lifted out of
`service.table-persistence.spec.ts` (which now imports them) because two specs build
`SerializedTable` fixtures. `serializedPeer` takes either a full 32-byte coordinate or a
single byte; the byte form is what the persistence spec was already using.

**`src/store/relevance.ts`** — a `NOTE:` on `recordSuccess` recording that repeated success does
not raise relevance and that `accessCount` is fed only by `touch`, pointing at
`backlog/bug-frequency-credit-only-from-gossip`. No behavior change.

**`src/service/fret-service.ts`** — a `NOTE:` tripwire at `enforceCapacity` recording that
protection wins over the cap, so a capacity below the protected-set size leaves the table over
capacity.

**`docs/fret.md`** — added in review; see findings below.

## Measured constants

Every constant in the specs was re-measured independently during review, against the current
code at a fixed clock (recency exactly 1), `x = 0.5`, from a fresh entry with
`avgLatencyMs: null`. All confirmed: the whole clamp table (1.8000 / 1.8000 / 1.6698 / 1.4230 /
1.2642 / 1.2355 at 5 / 20 / 30 / 50 / 100 / 150 observations), `recordSuccess` 1.2600 vs
`recordFailure` 0.6300, 0.6300 → 0.5861 across 30 failures, and 4.0850 for `touch` at
`MAX_SAFE_INTEGER` counters.

The implement stage had already re-measured these downward from the values the plan ticket
carried (e.g. 0.6300 rather than 0.8795) and explained why: a `null` `avgLatencyMs` takes the
neutral 0.5 health penalty, which reproduces 0.6300 exactly. That explanation checks out
arithmetically — base = (0.4·1 + 0 + 0.4·0.25)·0.7 = 0.35, × the clamped bonus 1.8 = 0.63.
Anyone re-measuring must pin the clock **and** say whether the sparsity model is fresh per call
or shared; the two give different numbers (see finding R2).

## Structural facts worth carrying forward

- **Protected-set size is `2·max(2, m) − 1`**, not `2m + 1`: both ring walks start *on* self, so
  self consumes one slot per side. 15 at m 8. Over-subscription therefore needs
  `capacity < 2m − 1`.
- **Every fixture uses distinct relevances.** Equal-relevance entries evict in
  `Array.prototype.sort` order, which is not a contract.

## How to read / drive these tests

`enforceCapacity` and `stabilizeOnce` are private. The public lever is `importTable`, which runs
enforcement after importing. Two shapes, both in the spec:

- **Import and enforce in one call** — build a `SerializedTable` larger than `capacity`.
- **Populate directly, then enforce with an empty import** — `importEntries` forces every record
  to `state: 'disconnected'`, so a `dead` peer has no snapshot representation. `place()` writes
  through `getStore()` and `enforce()` triggers with `tableOf([], 'enforce-trigger')`.

Peers are placed with `ringOffset(self, ±n)` from `test/helpers/ring.ts` — exact modulo 2^256,
so ring order around self holds even when the arithmetic wraps.

**Services are started and then immediately stopped** before each fixture is placed
(`seededService`). `start()` is the real path that seeds self into the store as `member` at
relevance 0, but it also arms the stabilization loop, whose first tick would score fixture peers
underneath the assertions. `stop()` bumps the run generation and aborts the run signal;
`enforceCapacity` reads no run state.

## Review findings

**Diff read first, with fresh eyes, before the handoff summary.** Each fixture's expected
survivor set was re-derived by hand from `protectedIdsAround` + the eviction loop before the
suite was run, and every measured constant was re-measured with a throwaway script (deleted).

### Fixed in this pass (minor)

- **R1 — `docs/fret.md` still described the mechanism that does not exist.** Three places said
  S/P members carry "infinite relevance"; the implement stage recorded the truth only in a test
  header and a source `NOTE:`, leaving the design document — the file AGENTS.md says to maintain
  — stating a fiction the new tests disprove. Rewritten to name the protection set, its
  `2·max(2, m) − 1` size and the off-by-one that causes it, the protection-beats-capacity
  consequence, the fact that eviction compares *stored* scores taken under different sparsity
  model states, and a pointer to the new spec.
- **R2 — the `recordSuccess` `NOTE:` quoted a number that needs a fixture it did not state.**
  "a peer we merely heard about 500 times scores 1.5276" holds only with a *fresh* sparsity model
  per call; measured 1.5275 that way, and 1.0449 vs 0.8619 on one shared model — which is what
  the running service actually has. Ordering is unchanged either way. Corrected the digit and
  stated both fixtures.
- **R3 — the headline eviction test could not distinguish relevance order from ring order.**
  `standardLayout` gives the far peers relevance 1.0 … 6.0 in ascending ring order, and
  `store.list()` returns ring order, so an implementation that evicted in `list()` order without
  sorting would have passed every case in the file. Added
  `picks victims by relevance, not by ring position or insertion order`: same layout with far
  relevances descending in ring distance, so the survivor is the ring-*nearest* far peer.
- **R4 — added a comment at the headline case** noting the protected window is one live member
  per side short of the configured `m`, so a reader does not take the fixture as evidence the
  code matches the doc's S(p) ∪ P(p) claim.

### Routed to an existing ticket (major)

- **R5 — self-anchored ring walks are off by one against `m`, and disagree with each other.**
  `neighborsRight(selfCoord, m)` returns self plus only `m − 1` other peers (the walk lands on
  self's own tree key), which is why nine call sites follow it with
  `.filter(id => id !== selfStr)`. So capacity protection covers `m − 1` neighbors per side and
  the m-th successor/predecessor is evictable despite `docs/fret.md` calling all of S(p) ∪ P(p)
  retained; the maintenance walks (leave targets, `isNearNeighbor`, warm-up lists) have the same
  shortfall. `windowGaps` in `src/estimate/size-estimator.ts` is the one site that compensates,
  asking each side for `m + 1` — local evidence that this is a class, not an instance.
  Verified statically (read the walk implementations); pinned as *current* behavior by the spec.
  Per *Architecture first*, filed as an **arm on `plan/23-fret-service-decomposition` item (a)**,
  which already owns the shared two-sided-walk helper — the fix is to state once in that
  helper's signature whether `count` means "results including self" or "peers besides self", not
  to add `+ 1` at nine call sites. That ticket also carries a re-measured
  `fret-service.ts` size: **2980 lines** (`wc -l`).

### Checked and deliberately not filed

- **Enforcement is only ever reached through `importTable` in these tests** (the handoff says so
  honestly). The other call sites — `seedFromPeerStore`, `seedFromBootstraps`, the snapshot-merge
  paths, `stabilizeOnce` — are one-line calls to a now well-pinned method, and
  `plan/16-per-tick-hotpath-waste` already owns the question of how often those sites fire. A
  ticket for "assert the merge path also calls it" would test a call site, not a behavior.
- **`avgLatencyMs: NaN` untested** — agreed and correctly reasoned in the spec comment: latency
  only ever originates from a local `Date.now()` difference, never from the wire.
- **Tie order untested** — correct; not a contract, and every fixture avoids depending on it.
- **The two flagged scoring behaviors (flat repeated success, `accessCount` fed only by `touch`)
  left unpinned in both directions** — correct for a test-only ticket;
  `backlog/bug-frequency-credit-only-from-gossip` owns whether the ranking is right.
- **The `seededService` start→stop pattern**, which the handoff flagged as its main judgement
  call, is sound: fixtures are placed *after* `stop()`, `enforceCapacity` reads no run state, and
  the suite's exit watchdog (which fails a run on any handle still open 10 s after the last test)
  stayed silent. No change.
- **Exact-value assertions (1.4230, the failure endpoints)** are intentional per the plan ticket —
  a retune must re-measure, not loosen. Left as-is.

### Tripwires

No new ones. The two the implement stage parked were reviewed and left in place: the
`enforceCapacity` protection-beats-cap `NOTE:` (now also stated in `docs/fret.md`, since it is
architectural), and the `recordSuccess` `NOTE:` (a pointer to the backlog ticket at the site a
reader will meet it, which is the right home even though it is not conditional).

### Validation

- `cd packages/fret && node node_modules/typescript/bin/tsc --noEmit` — clean.
  (`npx tsc --noEmit` fetches an unrelated TypeScript 6 and prints its help instead of compiling;
  use the local binary or `yarn build`.)
- `cd packages/fret && yarn test` — **681 passing, 0 failing**, ~4 min, run after the review edits.
  No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
- No lint step exists in this repo (`yarn format` / `format:check` are off-limits per AGENTS.md —
  no prettier config, so they rewrite every file against the house tab style). `yarn check`
  (typecheck + build + test) is the gate and its test and typecheck arms both ran here.
