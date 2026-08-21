description: Background maintenance work was repeating three costs on every tick — re-hashing peer identifiers, re-hashing the node's own identifier, and trimming the routing table more often than needed. The change removing that waste has now been reviewed and validated.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/per-tick-hotpath.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, docs/fret.md
----

Review of `16-per-tick-hotpath` (implement commit `01e05c0`) and its three test tickets
(`b47cca4` / `559a327` / `c42ad0b`). Full diff under review: `git diff 884f7c6 HEAD`.

The review ran across three sessions (two crossed the token budget): session 1 read the source,
session 2 closed the findings, session 3 validated and wrote this up.

## What the change did

Three per-tick costs the stabilization loop used to pay every tick:

- **(a) Coordinate reuse.** `seedFromPeerStore` re-hashed every peerStore entry's ring coordinate
  on every tick. It now reads the coordinate already in the routing table and hashes only on a
  miss.
- **(b) Own-coordinate reuse.** Five sites re-hashed this node's own peer id instead of reading
  the cached `selfCoord()`. `mergeAnnounceSnapshot`'s locals were renamed `sender` / `senderCoord`
  in the same pass, because they held the *announcing* peer's identity while being named as if
  they held ours.
- **(c) Capacity enforced once per tick.** The seeds no longer trim for themselves; `stabilizeOnce`
  phase 1 owns the tick's single `enforceCapacity`, plus one explicit call in `start()` so the
  bound does not depend on a timer being armed.

## Review findings

**Checked:** the implement diff read cold before the handoff summary; all three changes against
the source; the call graph of every insert sequence that lost its own trim; the five `selfCoord()`
conversion sites individually; `docs/fret.md` sections *Stabilization and churn handling*,
*Relevance scoring and table management*, *Ring membership* and *Routing table persistence*
against the new reality; the implementer's four disclosed test gaps; `npx tsc --noEmit`; the full
suite.

**Correctness — nothing found.** Each of the three changes is sound:

- The coordinate reuse is safe because a ring coordinate is `SHA-256(peer id)` and nothing rotates
  it, so a stored coordinate cannot legitimately go stale.
- Four of the five `selfCoord()` conversions genuinely wanted *this node's* coordinate; the fifth
  site (`mergeAnnounceSnapshot`) wanted the sender's and correctly kept hashing it.
- Every insert sequence that lost its own trim is followed by a caller that trims — verified by
  reading the call graph, not by trusting the handoff.

**Behaviour change, accepted and recorded.** The unconditional re-hash used to silently *repair* a
wrong coordinate for any peer libp2p's peerStore also knew about. That incidental repair is gone.
The only way a wrong coordinate can enter the table is `importTable`, which trusts the persisted
snapshot's `coord` field — so the import-side check is now the only defence. Documented at the
site and recorded as an arm on `backlog/plan/2-routing-table-export-integrity` rather than filed as
a new ticket, since that ticket already owns the import boundary.

**Three findings, all minor, all fixed in this pass** (commit `59907fc`):

1. *Cache warming is an unstated side effect of the `selfCoord()` conversions.* `isNearNeighbor`
   and `getNetworkSizeEstimate` both read the cached coordinate nullably and degrade when it is
   unset. Routing five sites through `selfCoord()` populates the cache earlier, so both degrade in
   strictly fewer situations — an improvement, not a defect, and only conditional on a future call
   site hashing directly again. Parked as a tripwire `NOTE:` on `selfCoord()`.
2. *A throw earlier in `stabilizeOnce` skips the tick's one `enforceCapacity`.* Only
   `sweepBoundedMaps` and `nearProbeTargets` run ahead of it; both are local, neither can throw on
   an input a tick can present, the loop's own try/catch swallows anything that does, and the
   overshoot self-heals on the next tick. Conditional, so parked as a tripwire `NOTE:` at the
   enforcement site naming the fix (move it to the method's `finally`) should a deterministic throw
   ever be found.
3. *`coordOf` was open-coded twice.* The copy in `iterativeLookup`'s cohort-hint merge was
   byte-identical and now calls `this.coordOf(hint)`. The new reuse line in `seedFromPeerStore` is
   deliberately left open-coded — it hashes the `PeerId` object it already holds rather than
   re-parsing the id string, which is the point on that hot path.

**Docs — one gap found and fixed.** `docs/fret.md` did already state the once-per-tick rule under
*Stabilization and churn handling*, and nothing anywhere described `seedFromPeerStore` as
re-hashing per tick, so the implementer's claim was correct as far as it went. What was missing:
the docs described the tick's enforcement but not the reason it is now the *only* one, nor
`start()`'s explicit call. Added both to that bullet in this pass. Separately verified that the
*Routing table persistence* claim "a tampered self coordinate would heal on the next stabilization
tick's peer-store re-seed" is **still true** despite change (a): the self-upsert at the tail of
`seedFromPeerStore` passes a freshly-computed `selfCoord()` unconditionally and never takes the
reuse path.

**Test gaps — one closed, three left, with reasons.** Added
`an untruncated tick does probe unknown peers` to `test/per-tick-hotpath.spec.ts`. The
truncated-tick test asserts that no unknown peer was probed as its evidence that the tick really
was cut short, but that assertion would hold equally against a rig that never dials at all — it was
never shown non-vacuous. The new test is the same scenario with near peers that answer and a
generous budget, and asserts phase 2 *does* probe. Left deliberately:

- *No hash-call counting anywhere.* The two coordinate-reuse tests pin the per-peer property (a
  stored coordinate survives a cycle; a never-seen peer is hashed), and the aggregate performance
  claim follows from it. Counting calls directly would need module-level mocking of `hashPeerId`
  for a claim already implied — judged not worth the brittleness.
- *Both "trims" tests would pass against the pre-change code.* True, and by design: those two pin
  behaviour the change had to *preserve*. The discriminating test is the truncated-tick one, which
  drives `stabilizeOnce` with no seeds at all — pre-change there was no enforcement in
  `stabilizeOnce` for it to reach, so it fails against the old code.
- *Only the `core` profile is exercised.* All three changes are profile-independent (hashing and
  capacity enforcement take no profile input); the profile-split knobs on this path — pool
  concurrency and probe budgets — belong to the pooled-tick change and are already covered for both
  profiles by `test/stabilize-concurrency.spec.ts`.

**No new tickets filed.** The site-claim grep over the five open stages was run for
`fret-service.ts`; the only finding that could have become a ticket (the lost coordinate repair) is
an arm on an existing one. The two conditional findings are tripwires by the stage rules, not
tickets.

## Validation

From `packages/fret`, both foreground:

- `npx tsc --noEmit` — clean.
- `yarn test` — **1092 passing, 0 failing** (~5 min). This is the implementer's claimed 1091 plus
  the one test added above, so the claim is confirmed rather than inherited. All 7 tests in
  `per-tick-hotpath.spec.ts` pass, including the new one.

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written. There is no
lint step in this repo (`yarn check` is the gate, `yarn format` must not be run — see `AGENTS.md`),
so no lint was run and none was expected.

The static-override leak the ticket warned about (`per-tick-hotpath.spec.ts` overwrites
`FretService.STABILIZE_TICK_BUDGET_MS` in a `beforeEach`) did not materialise: no timing failures
appeared in any spec ordered after it, and the `afterEach` plus the rig's own `teardown` both
restore the original.
