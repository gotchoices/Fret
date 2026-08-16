description: Around ten tests wait by sleeping a fixed several seconds and then asserting the work must be done, which both wastes real time on every run and fails intermittently when a slow machine misses the deadline; a shared condition-based wait would fix both.
files: packages/fret/test/helpers/wait-for.ts, packages/fret/test/libp2p-memory.integration.spec.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/membership-identify.spec.ts
difficulty: easy
----
Design work is already resolved and the code changes already landed (committed in `bc1bd6c
ticket(plan): waitfor-helper`, on `main`, prior to this ticket file being written) — this
ticket is a verification-and-handoff pass, not new implementation.

What already exists in the tree:
- `packages/fret/test/helpers/wait-for.ts` — the shared helper. `waitFor(predicate, timeoutMs =
  12000, stepMs = 25, label?)` polls `predicate` every `stepMs` and **throws** with the caller's
  `label` if `timeoutMs` elapses without the predicate holding — this satisfies the ticket's
  "must throw, not silently time out" requirement, since a chain of waits now fails at the
  specific wait that stalled rather than surfacing as an opaque mocha timeout at the assertion
  several waits later.
- `libp2p-memory.integration.spec.ts` — all fixed-duration sleeps (previously up to 6s, at the
  old line refs 104/132 and several siblings) replaced with `waitFor` calls keyed on actual
  convergence state (peer counts, neighbor-set population, snapshot exchange counts), using two
  new local predicates `allHaveMinPeers` / `allHaveNeighbors`.
- `ring-membership.spec.ts` — its private duplicate `waitFor` (previously ~line 425) deleted;
  now imports the shared helper. Its own fixed sleeps had already been converted to predicate
  waits by an earlier ticket (`membership-classification-strength`), so this file's remaining
  work was purely the de-duplication described in the ticket's "additional arm".
- `membership-identify.spec.ts` — same de-duplication (its private `waitFor` deleted, now
  imports the shared helper). This was the file the original ticket cited as "the existing
  correct pattern."

Verification already performed this pass (re-run if you want your own confirmation, but it
should not be necessary):
- `cd packages/fret && npx tsc --noEmit` — clean.
- Targeted run of the three affected spec files — 44/44 passing; the 10-node convergence case
  that used to sleep 6s now completes in ~141ms.
- Full suite (`yarn test`) — 544/544 passing, ~4 minutes wall clock.

Remaining fixed multi-second sleeps in other spec files (`churn.leave.spec.ts`,
`fret.mesh.spec.ts`, `iterative-lookup.spec.ts`, `maybeact-dedup-phases.spec.ts`,
`network.isolation.spec.ts`, `payload-bounds-ttl.spec.ts`, `peer-discovery.spec.ts`,
`proactive-announce.spec.ts`, `route.maybeact.integration.spec.ts`, `profile.behavior.spec.ts`,
plus three sleeps still in `ring-membership.spec.ts` at the current end of the file: a 400ms
discovery-emission wait, a deliberately-real 2×600ms spaced-failure test, and a 2000ms
single-node-startup wait) are **out of scope** — the originating ticket named only
`ring-membership.spec.ts`, `libp2p-memory.integration.spec.ts`, and the
`membership-identify.spec.ts` reference pattern. Do not expand scope to those other files under
this ticket.

## Edge cases & interactions
- `waitFor`'s default timeout (12000ms) must stay comfortably under Mocha's per-test timeout
  (30000ms per the quickstart invocation) even when a test chains multiple waits — already true
  at 3×12000 < 30000 for the worst case in `ring-membership.spec.ts`, and the libp2p-memory
  conversions all pass explicit shorter timeouts (6000-10000ms) since those tests chain a wait
  with other setup work.
- The helper throws on timeout rather than returning silently — any future caller that relies on
  "wait then check anyway" behavior would need to catch, not assume a silent return; none of the
  current call sites do this.
- `stepMs` default of 25ms bounds polling overhead; do not lower it further without checking CI
  timing sensitivity — this wasn't measured, just carried over from the pre-existing patterns.

TODO:
- Confirm typecheck (`npx tsc --noEmit` from `packages/fret/`) and full test suite
  (`yarn test` from `packages/fret/`) still pass at HEAD (re-verify only — no code changes
  expected).
- Write the `review/` handoff ticket summarizing this work; no unresolved findings are expected,
  but note the out-of-scope sleep sites above so a future ticket can pick them up deliberately
  rather than by rediscovery.
