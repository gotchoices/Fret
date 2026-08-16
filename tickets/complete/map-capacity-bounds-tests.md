----
description: Tests now pin the size limits of three internal bookkeeping tables, and the review of those tests turned up a real defect in how FRET announces peers to libp2p — roughly half of a large peer table is never announced at all.
files: packages/fret/test/ring-membership.spec.ts, packages/fret/test/profile.behavior.spec.ts, packages/fret/test/peer-discovery.spec.ts, packages/fret/src/service/peer-discovery.ts, packages/fret/src/service/libp2p-fret-service.ts, docs/fret.md
----

## What shipped in this chain

`map-capacity-bounds` (design) → `map-capacity-bounds-service` (production change) →
`map-capacity-bounds-tests` (tests) → this review.

The production change converted three unbounded internal maps into capacity-bounded ones with a
periodic cleanup: the per-peer probe backoff map (Core 2048 / Edge min(capacity, 512)), the
departure-announce debounce map (Core 512 / Edge 128, 2 s lifetime), and the libp2p discovery
re-emission debounce map (`maxTracked`, Core 4096 / Edge 1024). The rationale lives in `docs/fret.md`
under *Security and abuse considerations → Current state*.

The test pass added: three specs in `ring-membership.spec.ts` covering backoff-escalation retention
(that an escalation survives an expired backoff window, resets once retention lapses, and that the
retention constant exceeds the longest window); a seven-spec `Bounded internal map capacities` block
in `profile.behavior.spec.ts` asserting each map's capacity per profile plus explicit-override
precedence; and a capacity/re-emission spec in `peer-discovery.spec.ts`.

## Review findings

### Gate status

- **Full suite run, current working tree: 578 passing, 1 failing.** `npx tsc --noEmit` clean.
- The two `replay-hardening.spec.ts` dedup-cache failures the handoff flagged as pre-existing are
  **gone** — the runner's triage pass fixed them in commit `e7cb340` between the implement pass and
  this review. Nothing left to carry.
- **New, unrelated failure: `churn.leave.spec.ts` → "fan-out notifies peers beyond immediate S/P"
  timed out at 20 s inside the full suite, but passes standalone in 4.66 s.** Timing-fragile under
  suite load, not broken; this ticket changed no production code and does not touch that file.
  Written up in `tickets/.pre-existing-error.md` for the triage pass. Not skipped or loosened.
- Touched specs re-verified after this review's edits: 117 passing across `peer-discovery`,
  `ring-membership`, `profile.behavior`, `expiring-map`.

### Major — one filed

**`FretPeerDiscovery.scan` permanently starves the tail of the ring once the live-member population
exceeds `maxTracked`.** → `tickets/fix/bug-discovery-scan-starves-ring-tail`.

The handoff flagged this as a narrow, hypothetical starvation mode and asked for a code comment
("fine now, only matters if X"). It is neither narrow nor hypothetical, so it was escalated rather
than parked:

- `scan` restarts at ring-order position 0 every tick and breaks at `batchSize`. Once the population
  exceeds `emitted`'s capacity, the evict/re-emit churn stabilises without ever advancing past
  roughly `maxTracked + batchSize` entries. Everything beyond that is emitted **never**.
- Ring position is a stable hash of the peer id, so the starved set is fixed for the node's lifetime
   — a permanent coordinate-determined bias, not a delay.
- Shipped Edge defaults reach it: `maxTracked` 1024 against a default routing-table capacity of
  2048. Simulating the loop at those settings reaches 1040 of 2048 members and stalls. Including the
  600 s debounce lifetime changes nothing; capacity binds at ~256 s.
- Provenance: the implement pass *observed* the starvation in real code (its new spec failed
  deterministically at `maxTracked: 3` and passes at 4). The scaling to 2048 is simulation of the
  same loop, cross-validated against that observation. Ticket records both, and `repro: verified`.

Root cause is one site with one fix — a resumable scan cursor — which retires the class for every
`(population, maxTracked, batchSize)` combination rather than the one instance. The ticket asks for
the regression guard to be a property over that parameter space, since a single tuned case is what
let this through.

**Accepted-tradeoff check.** The site carried prose justifying the cap binding early ("costs one
extra emission of that peer, which is idempotent in libp2p's peerStore"). That is a decision record,
so it was weighed before re-filing — and re-filed because the stated premise is measurably false in
exactly the regime the sizing creates. The consequence is not a duplicate emission; it is zero
emissions for half the ring. Those comments have been corrected in place (see below) rather than
left contradicting the ticket.

### Minor — fixed in this pass

- `test/peer-discovery.spec.ts`: `maxTracked: 4` against 5 members was an unexplained magic number
  that a future maintainer would "tidy". Added a comment stating that 3 starves this exact test, why,
  and which ticket removes the constraint.
- `test/ring-membership.spec.ts`: two older specs still typed `backoffMap` as a plain `Map` after the
  `ExpiringMap` conversion. Corrected — the annotations were lying about the type under test.
- `test/ring-membership.spec.ts`: the retention-inequality spec was titled "comfortably exceeds" but
  asserts only `>`. Retitled to state what it actually pins (the strict inequality *is* the whole
  invariant; the shipped ~9× margin is a sizing choice), and added type guards so a mistyped constant
  name reading `undefined` fails loudly instead of making the comparison vacuous.
- `src/service/peer-discovery.ts` and `src/service/libp2p-fret-service.ts`: both comments asserting a
  premature eviction is harmless now state the measured consequence and point at the fix ticket. The
  existing `scan` NOTE claiming a large table merely "drains slowly" was corrected too — it drains
  only while the population fits in `emitted`.
- `docs/fret.md`: the discovery paragraph asserted the Edge cap binding early "is intended". Replaced
  with the measured defect and a pointer to the fix ticket.

### Tripwires — none recorded

The one candidate the handoff nominated (the `scan` starvation) failed the tripwire test: it is not
"fine now, becomes a problem if X" but wrong today at shipped Edge defaults, so it became a ticket.
No other conditional concern surfaced.

### Coverage gaps — one filed, one accepted

- **Filed:** nothing asserts the periodic maintenance tick actually calls the map cleanup. The
  cleanup logic and the size caps are each covered; the wiring between them is not, so it could be
  disconnected silently. → `tickets/backlog/debt-sweep-wiring-untested`. Intended to be written in
  this pass; deferred on a budget warning rather than committed unverified.
- **Accepted:** the handoff noted that nothing exercises the cleanup racing live RPC traffic under
  concurrent load. Agreed and left alone — the surrounding suite is unit-level throughout, and a
  load-level harness is a different kind of test, not a hole in this one.
- The capacity specs assert capacity *values* only, not eviction behavior at those capacities. That
  is correct scoping, not a gap: eviction order, refresh semantics and expiry boundaries are pinned
  generically in `test/expiring-map.spec.ts` (24 specs, including a property test that the map never
  exceeds its capacity under arbitrary interleavings). Duplicating them per call site would test the
  same code three more times.

### Checked and clean

- The two retention specs are not redundant under different names, as the handoff asked to confirm —
  one tests the map's own lifetime, the other the escalation factor surviving an expired *window*
  inside that lifetime. The distinguishing comments read clearly.
- The fake-clock swap in the retention spec replaces only the map, leaving `recordBackoff`, the RPC
  layer and the wall-clock-derived window untouched. Correct, and its comment says so.
- Documented capacities match the code on every path checked (`docs/fret.md` against the three
  constructors and the profile merge).
- No resource leaks introduced: the three `Libp2pFretService` capacity specs construct without
  starting, so no discovery timer is armed; the service-based specs are covered by existing
  `afterEach` teardown. The suite's exit watchdog passed.
