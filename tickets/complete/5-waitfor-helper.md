description: A shared test helper now waits for the actual condition instead of sleeping a fixed number of seconds. Review found the integration tests' wait conditions were counting each node's own entry, so they were already satisfied before any work had happened and waited on nothing; the conditions now count only remote peers, and the tests exercise real convergence again.
files: packages/fret/test/helpers/wait-for.ts, packages/fret/test/libp2p-memory.integration.spec.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/membership-identify.spec.ts
----
Shared `waitFor(predicate, timeoutMs = 12000, stepMs = 25, label?)` in
`packages/fret/test/helpers/wait-for.ts` replaces fixed sleeps and two private duplicates. It
polls and **throws** on timeout, so a chain of waits fails at the wait that stalled rather than
as an opaque mocha timeout several assertions later.

`libp2p-memory.integration.spec.ts` gates each test on real convergence. `ring-membership.spec.ts`
and `membership-identify.spec.ts` deleted their private copies and import the shared one.

## Review findings

### Major — fixed in this pass

**The integration-test convergence gates were tautologies.** `allHaveNeighbors` asserted
`getNeighbors(selfCoord, direction, m).length > 0` for every node. A ring walk anchored at a
node's own coordinate returns that node first on *both* sides (`fret-service.ts:1847`, and
`docs/fret.md` states it under network size estimation), and self is seeded `member` at
`start()` — so that condition is true before a single stabilization tick and could never
return false. `allHaveMinPeers(services, 2)` had the same shape: a node's store holds self plus
its bootstrap seed immediately, so `listPeers().length >= 2` was also true at t≈0.

Consequence, measured: the whole file ran in **4s**, with tests 2–5 and 7 finishing in
70–190ms — i.e. the pre-existing fixed sleeps (4–6s each) were not replaced by a wait for
convergence, they were replaced by no wait at all. `successor/predecessor sets match ring order
**after stabilization**` completed in 78ms, before the first 1.5s passive tick. The same
tautology was present in the assertions those gates were derived from, so the assertions could
not catch it either.

Fixed at the root rather than per site: three self-excluding helpers (`remotePeers`,
`remoteNeighbors`, `allKnowRemotes`) now back every gate *and* every S/P assertion in the file,
so a condition and the assertion it guards cannot disagree, and a future gate written against
these helpers cannot re-acquire the bug. The rule is also stated in the `waitFor` doc comment,
which is where the next author writing a predicate will read it. Suite now runs in **12s** with
each gate resolving after a genuine stabilization tick (1.5–1.6s), still well under the ~35s of
sleeps it replaced.

**Strengthening the gates surfaced a second thing worth writing down.** With `allKnowRemotes`
requiring two remote peers, the two 10-node tests failed. Traced with a throwaway 30s
convergence trace (since deleted): every leaf holds 9 remote entries but classifies only **1**
of them `member`, and that never changes. FRET's wire format carries no multiaddrs, so a peer a
leaf learned only through gossip has no peerStore address; the classification probe skips it as
undialable and it stays `unknown` — hence outside every ring view — indefinitely. A star mesh
stays a star. This is documented design (`docs/fret.md`, *Dialability*: address-hint
propagation is not implemented), not a defect, so no ticket was filed; the 10-node gates now ask
for what the ring can actually reach (one live-member neighbour each way, bootstrap knows ≥8,
at least one snapshot exchanged) with a `NOTE:` at the site recording why and what would change
it. One straggler node also needed ~15s to receive its first snapshot, so the 10-node budgets
went 10000 → 12000ms.

### Minor — fixed in this pass

- Leave test restated "every survivor still has neighbours" three times (once in the wait
  predicate, twice as assertion loops). Collapsed to one `survivorsHaveNeighbors()` closure used
  by both, and dropped `expect(getDiagnostics()).to.have.property('pingsSent')`, which asserted
  an object shape rather than behaviour.
- Test 1's post-wait assertion loop restated its own gate verbatim; both now read the same
  remote-peer count.

### Considered and declined

- **Moving `label` to `waitFor`'s second parameter** (options bag for `timeoutMs` / `stepMs`).
  17 of 25 call sites omit the label precisely because it sits behind two numbers nobody wants
  to restate, so their timeout message is the bare `waitFor timed out after 12000ms`. The
  refactor was started and reverted: it breaks all 25 call sites and 17 of them need a label
  invented, which is more churn than the remaining benefit justifies once the stack trace
  already names the file and line. Recorded as a `NOTE:` in `wait-for.ts` with the exact change
  to make if the bare message ever stops being enough.

### Tripwires recorded, not ticketed

- Timeout-budget headroom in `ring-membership.spec.ts`: the worst chain is three waits at the
  12000ms default (36000ms) inside a `this.timeout(40000)` describe — 4s of margin. The
  originating ticket cited a 30000ms mocha budget; the actual value is 40000
  (`ring-membership.spec.ts:436`), so there is more headroom than claimed. Only the error
  message degrades if it is ever exceeded (the test fails either way), so this is conditional,
  not a defect. Noted in `wait-for.ts`.
- `stepMs` default of 25ms remains unmeasured against CI timing sensitivity, as the originating
  ticket said. Nothing observed to suggest it matters; left alone.

### Checked, nothing found

- **Helper correctness.** Deadline arithmetic, the final post-loop `predicate()` re-check (needed
  — the predicate can flip during the last sleep), timer cleanup (every `setTimeout` promise is
  awaited, so the mocha exit watchdog stays quiet), and predicate typing (`() => boolean` makes
  an accidental `async` predicate a type error rather than an always-truthy `Promise`).
- **De-duplication.** No private `waitFor` remains: `grep -rn "function waitFor\|const waitFor"
  packages/fret/test` hits only the shared helper.
- **Throw-on-timeout as a behaviour change.** The two deleted private copies returned silently.
  Every one of the 17 inherited call sites wants its condition to hold, and none relies on
  "wait then check anyway", so none needs a `catch`. Confirmed by reading each site, not by the
  suite passing.
- **Index alignment** in the new `services[i]` / `coords[i]` / `selfIds[i]` helpers, including
  `coordsByIdx`, which `ringPositions` fills for every node.
- **Docs.** `docs/fret.md` was re-read against the change. It is test-helper-level work with no
  design surface, and the one behaviour the review leaned on (self appearing first in its own
  ring walk; gossip-learned peers being undialable) is already stated there accurately. No edit
  needed.

### Out of scope, unchanged

Fixed sleeps remain in `churn.leave.spec.ts`, `fret.mesh.spec.ts`, `iterative-lookup.spec.ts`,
`maybeact-dedup-phases.spec.ts`, `network.isolation.spec.ts`, `payload-bounds-ttl.spec.ts`,
`peer-discovery.spec.ts`, `proactive-announce.spec.ts`, `route.maybeact.integration.spec.ts`,
`profile.behavior.spec.ts`, plus three in `ring-membership.spec.ts` itself (a 400ms
discovery-emission wait, a deliberately-real 2×600ms spaced-failure test that measures
time-based backoff spacing and is not a predicate-wait candidate, and a 2000ms single-node
startup wait). The originating ticket named only the three files above. A future sweep should
apply the self-exclusion rule above to any gate it writes.

## Validation

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — **544 passing**, 0 failing, ~4 min. No pre-existing failures.
- `libp2p-memory.integration.spec.ts` alone: 7 passing in 12s (was 4s with inert gates, ~35s
  with the original sleeps).
