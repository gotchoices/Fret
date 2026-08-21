description: Added a test proving the periodic cleanup timer for two small internal tracking tables is actually wired up. Review found the original test could not have failed if that wiring broke, and rewrote it so it can.
files: packages/fret/test/profile.behavior.spec.ts (test `stabilizeOnce sweeps expired entries from backoffMap and departureDebounce`), packages/fret/src/service/fret-service.ts (code under test: `stabilizeOnce`, `sweepBoundedMaps`, `pruneBackoffMap` — unmodified), packages/fret/src/utils/expiring-map.ts (read-only; its lazy-expiry reads are what made the original test vacuous)
----

## What shipped

One test in `packages/fret/test/profile.behavior.spec.ts`, inside the existing
`Bounded internal map capacities` block, proving that the stabilization tick actually calls
`sweepBoundedMaps()` — the periodic tidy-up for the two capacity-bounded bookkeeping maps
(`backoffMap`, retained 5 min; `departureDebounce`, 2 s). No production code changed at any
point in this ticket.

The test swaps both maps for `ExpiringMap`s built on an injected fake clock, seeds expired and
surviving entries, calls `stabilizeOnce()` directly, and asserts on the maps afterwards.

## Review findings

**Checked**: the implement-stage diff (`git diff 2cf6c19 02d2576`) read before the handoff
summary; `ExpiringMap`'s full API and expiry semantics; `sweepBoundedMaps` / `pruneBackoffMap` /
`stabilizeOnce` at the sites under test; the two constants the test reads; `docs/fret.md`'s
statements about both maps; the spec's own `createService` rig.

**Major — none filed as tickets.** The one substantive defect was in the new test itself, so it
was fixed in this pass rather than filed; see below. No production defect was found, and no
architectural class-retiring change is warranted by a single test-authoring slip.

**Minor — fixed inline (one finding, two arms):**

*The test could not have failed if the wiring it claims to prove had broken.* Both arms:

- **Assertions went through `has()`, which expires lazily.** `ExpiringMap`'s `get` / `has` /
  `keys` all filter (and `get`/`has` delete) expired entries on read, so
  `expect(map.has(expiredId)).to.equal(false)` holds whether or not `sweepBoundedMaps()` ever
  ran. `size` is the only view that counts *retained* entries, and therefore the only one that
  can distinguish a swept map from an unswept one. The assertions now read `size`.
- **The "expired" backoff entry was never expired.** The clock stepped by
  `Math.min(BACKOFF_RETAIN_MS, DEPARTURE_DEBOUNCE_MS) + 1` = 2001 ms, against a backoff lifetime
  of 300 000 ms. That entry disappeared because `pruneBackoffMap` — which runs inside the same
  `sweepBoundedMaps` call — drops entries for peers absent from the routing store, and the id
  used was not a store member. So the backoff arm exercised the prune, not the sweep. The step
  is now `Math.max(...) + 1`, and the backoff entry uses the service's own id (always a store
  member), so the prune cannot explain its removal.

The rewrite also adds the survivor case the backoff arm previously lacked — the original had a
live `backoffMap` entry only under self's id, which the expired-entry arm now occupies, so a
second `stabilizeOnce()` with a freshly written live entry covers "the sweep does not clear
unconditionally" for that map. The `departureDebounce` arm keeps its survivor inline (it has no
prune to work around).

**Verified by mutation, not by inspection.** With `backoffMap.sweep()` /
`departureDebounce.sweep()` commented out of `sweepBoundedMaps` and `pruneBackoffMap` left in
place, the rewritten test fails (`expected 1 to equal +0`); the original test passed under the
same mutant. `src/service/fret-service.ts` was restored byte-identical afterwards
(`git diff --stat` clean).

**Tripwires — none recorded.** No conditional concern surfaced: the test is self-contained, the
two constants are read from the class rather than duplicated, and nothing here degrades with
scale.

**Accepted tradeoffs — none encountered.** No `NOTE:` at any site this ticket touches marks a
previously declined finding.

**Docs.** `docs/fret.md` describes both maps and the per-tick sweep under *Security and abuse
considerations*; that description is accurate and unchanged by this ticket, which adds no
behavior. No doc edit was warranted.

**Source hygiene.** Test-only change, ~40 lines, inside the block that already owns these maps'
coverage. Comments state *why* each choice is load-bearing (why `size` and not `has`, why
`max` and not `min`, why self's id) rather than restating the code.

**Pre-existing failures — resolved elsewhere, nothing to report.** The implement handoff filed
`tickets/.pre-existing-error.md` for `getDiagnostics().rejected.*` arithmetic failures across
several specs. Those were triaged and fixed by the `rejection-counter-split-test-callsites`
and `maybeact-undecodable-body-contract` tickets that landed after; the spec now runs
34 passing / 0 failing and `tsc --noEmit` is clean. That triage file is left in place — it is
the runner's, not this ticket's, to clear.

## Validation

- `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js
  "test/profile.behavior.spec.ts" --timeout 30000` — 34 passing, 0 failing.
- `cd packages/fret && npx tsc --noEmit` — exit 0, no errors.
- Mutation check described above.
- **Not run: the full suite.** This session hit its token budget partway through the review, so
  validation was scoped to the one spec file this ticket touches plus a whole-package
  type-check. The change is test-only and confined to a single `it` block, so the blast radius
  of that gap is that spec alone; there is no lint step in this repo (`yarn check` is the gate,
  and its typecheck arm was run).
