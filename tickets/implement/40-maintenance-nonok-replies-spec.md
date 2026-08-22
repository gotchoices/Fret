description: Our fake-peer test harness can now pretend a peer replied "I am too busy" or sent back an unreadable answer, but nothing yet checks that the code reacts correctly to those replies — write the missing tests.
files: packages/fret/test/maintenance-nonok-replies.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/test/helpers/backoff.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
---

## State — the harness half already landed

This is the continuation of `maintenance-rig-non-ok-replies`, which was cut by the runner's soft
token budget four runs running. The **harness widening is done and verified**; only the new spec
remains. Do not redo the rig work.

Landed on this branch, type-checked (`npx tsc --noEmit` clean) and regression-tested (all 110 tests
across the seven rig-dependent specs pass — `dead-state`, `per-tick-hotpath`, `preconnect-concurrency`,
`rpc.stream-errors`, `scoring-never-creates`, `stabilize-budget-invariants`, `stabilize-concurrency`):

- `packages/fret/test/helpers/maintenance-rig.ts` — `Behavior` widened from `'answers' | 'hangs'` to
  five values: `'answers'`, `'hangs'`, `'busy'`, `'not-ok'`, `'undecodable'`. Each documented on the
  type. `'answers'` is still the default at both lookup sites, so every existing spec is unchanged.
  `PeerRig.reply` is now a per-(protocol, behavior) builder taking `behavior` threaded down from
  `open`; `busy` and `undecodable` serve either protocol, `not-ok` is ping-only and rejects loudly on
  the neighbors protocol, and an unknown protocol keeps its original loud rejection. The file header
  gained a paragraph on the widened behavior set.
- `docs/fret.md` (the *Failure detection and recovery* bullet, ~line 79) — both stale claims
  replaced. It no longer says the arm is untested, no longer blames the two-valued stub, and no
  longer points at the deleted backlog ticket.
- `tickets/backlog/debt-maintenance-rig-non-ok-replies.md` — deleted (stale duplicate slug).

**`docs/fret.md` now forward-references `test/maintenance-nonok-replies.spec.ts` by path, twice.**
That file does not exist yet. Landing this ticket is what makes the doc true again, so the spec is
not optional cleanup — if the spec's path or name changes, the doc must change with it.

## What is left: the spec

Add `packages/fret/test/maintenance-nonok-replies.spec.ts`, driven through `stabilizeOnce` on the
rig. Its headline, worth stating in the spec header: **an answer that is not a good answer is still
an answer** — it confirms membership and clears the contact-failure run, and it never books a
contact strike.

Deliberately a *new* spec rather than an addition to an existing one. `failure-recovery.spec.ts`
owns the unreachable / timeout arc across two real nodes with a fake clock and does not use the rig
at all; `stabilize-concurrency.spec.ts` owns pool shape (cap, ordering, disjointness, budgets)
rather than per-arm scoring.

Read the probe backoff through `test/helpers/backoff.ts` (`backoffOf(svc)`) rather than reaching
into private state by hand; that is the only helper the spec needs from it.

### The four arms

Seed one near peer as a live `member`, snapshot its relevance and `contactFailures`, drive one
`stabilizeOnce`, then assert:

- **ping `busy`** — `backoffOf(svc).factor(id) > 0`; relevance **unchanged**; `contactFailures` 0
  (and a pre-seeded run cleared to 0); `membership === 'member'`; `diag.pingsSent` and
  `diag.pingsFail` each +1; `rig.protocolsSeenBy(id)` contains the neighbors protocol **after** the
  ping — the peer answered, so the fetch still runs.
- **ping `not-ok`** — relevance strictly **decreased**; `contactFailures` 0; backoff factor 0;
  `membership === 'member'`; `pingsSent` +1, `pingsFail` +1; neighbors protocol still opened.
- **ping `undecodable`** — relevance strictly decreased; `contactFailures` 0; backoff factor 0;
  `membership === 'member'`; neighbors protocol still opened.
- **neighbors `busy` behind an `answers` ping** — the ping arm scores normally (relevance up,
  backoff 0 from the ping) and `fetchAndMergeSnapshot` takes its busy arm: `diag.snapshotsFetched`
  **not** incremented, no contact strike. **Read `fetchAndMergeSnapshot` before writing this one**
  and assert what it actually does — that arm is deliberately silent about scoring, so pin today's
  behaviour rather than a guess at it. If it turns out to score nothing at all, assert that
  explicitly rather than skipping the case.

Every arm also asserts `state !== 'dead'`. A strike leaking in is exactly the regression this spec
exists to catch, and after three of them the peer silently leaves every ring view.

### Edge cases & interactions

- **Contact-failure run clearing needs a pre-seeded run to be observable.** Seeding
  `contactFailures: 0` proves nothing about clearing. Seed a peer at `contactFailures: 2` (via
  `seedPeers`' `patch` argument, which already forwards to `store.update`) and assert the busy tick
  drives it to 0 — otherwise the "clears the run" half of the arm is asserted vacuously.
- **500 ms strike spacing** (`lastContactFailureAt`) governs whether a *failure* counts. These arms
  book no strike at all, so spacing must not be needed to make an assertion pass; if an assertion
  only holds because of spacing, the arm under test is booking a strike it should not.
- **The rig never starts the service**, so `runSignal` is `undefined` and `stabilizeOnce` must be
  driven directly. Do not start the loop; a live loop races the assertions.
- **`stabilizeOnce` phase 2 runs too.** A seeded peer left `unknown` or `dead` also reaches
  `probeMembership`, which scores differently. Seed near peers as live `member` so the arm under
  test is unambiguously the near pass, and assert on `rig.protocolsSeenBy` to prove which pass did
  the contacting.
- **Pool overlap can reorder recordings.** `opened` is per-peer and append-ordered, so
  ping-before-fetch is safe to assert per peer; do not assert a global ordering across peers.
- **`teardown` must still restore the tick-budget static and `getConnections`.** If a test mutates
  `STABILIZE_TICK_BUDGET_MS`, restore through the rig's existing `setTickBudget` hook rather than by
  hand, or a later spec in the same mocha process inherits it.
- **Both profiles.** The arms are profile-independent but `maintenanceConcurrency` and the near
  budget are not. Prefer core for the scoring assertions and keep peer counts at or below the near
  budget (4) so no peer is truncated out of the tick and misread as "scored nothing".

### Service call sites (from `grep -n`, commit c3468b7 — grep the symbol rather than trusting a number)

- `probeNeighborLatency` — `src/service/fret-service.ts:2428`. Its outcome arms call
  `noteAnsweredOnProtocol` at **2440** and **2451** (the two answered-but-not-well arms this spec
  exists to reach) and `noteRpcFailure` at **2457** (inline `// decay only`), **2463**, **2470**.
- `fetchAndMergeSnapshot` — **2725**, with `noteRpcFailure` at **2750** ("takes the counting-only arm
  of `noteRpcFailure` rather than a strike") and **2755**. Read 2700–2780 for the fourth arm.
- `noteAnsweredOnProtocol` — 820; `noteRpcFailure` — 858; `stabilizeOnce` — 2321;
  `nearProbeTargets` — 2383; `probeAndFetch` — 2400.

## TODO

- Write `packages/fret/test/maintenance-nonok-replies.spec.ts` with the four arms and the
  assertions above, including the pre-seeded contact-failure run and the `state !== 'dead'` check.
- Read `fetchAndMergeSnapshot` before writing the neighbors-`busy` arm; pin what it does today.
- Re-check that `docs/fret.md`'s two references to the spec path match the file you land.
- Run `cd packages/fret && npx tsc --noEmit`, then `yarn test` in the foreground with no redirection.

## Related, not blocking

Two sibling tickets reference the same harness, which is now widened for both — whoever picks
either up inherits the capability and needs no rig change:

- `debt-fetch-snapshot-failure-arms-untested` — the arms of the neighbor-snapshot *fetch*, one RPC
  later than the ping. The neighbors-`busy` arm above is the first of them; the rest stay that
  ticket's scope.
- `debt-backoff-map-test-surface` — extracting the probe-backoff bookkeeping so its *arithmetic* is
  unit-testable. This ticket only asserts that a busy ping records *some* backoff, never what factor
  it lands on.

<!-- resume-note -->
## Resume note (run of 2026-08-22, second run — budget-cut before any code was written)

**No source file was created or edited this run either.** `packages/fret/test/maintenance-nonok-replies.spec.ts`
still does not exist and `docs/fret.md` still forward-references it. The whole TODO above stands.

This is the sixth consecutive run cut by the soft token budget, and the pattern is now the problem:
each run spends its budget re-reading the same three files before writing a line. **The next run
should write the spec first and read nothing but `fetchAndMergeSnapshot`.** Everything else it
needs is transcribed below — treat it as given, do not re-derive it.

### Given: the exact rig API (read from `test/helpers/maintenance-rig.ts` this run)

```ts
const r = await buildMaintenanceRig('core')          // also accepts a 2nd arg: Partial<FretConfig>
r.svc, r.store, r.rig, r.node
r.ping(), r.neighbors()                              // protocol strings
r.concurrency()                                      // Core 6 / Edge 2
r.setTickBudget(ms)                                  // restored by teardown()
await r.seedPeers(count, 'member', { contactFailures: 2 })   // patch -> store.update
r.rig.setProtocolBehavior(id, r.ping(), 'busy')      // per-(peer, protocol); beats r.rig.behavior
r.rig.protocolsSeenBy(id)                            // string[], append-ordered
await r.teardown()
```

`Behavior = 'answers' | 'hangs' | 'busy' | 'not-ok' | 'undecodable'`. `'not-ok'` **rejects loudly**
against the neighbors protocol — ping only. `'busy'` and `'undecodable'` serve either protocol.
The rig never starts the service, so drive `(svc as any).stabilizeOnce()` directly.

### Given: the backoff helper

`test/helpers/backoff.ts` exports `backoffOf(svc)` (the reader this spec wants) and
`setBackoffOf(svc, pb)` (**not** needed — these arms assert only factor > 0 vs factor 0, never a
window duration, so no clock control is required).

### New this run: arm 4's answer is already written down, in a spec the ticket did not know about

`packages/fret/test/fetch-snapshot-failure-arms.spec.ts` **exists on this branch** — the sibling
ticket `debt-fetch-snapshot-failure-arms-untested` has evidently landed. It owns the fetch arms
directly (`skipped`, `decode-error`, `ok`, `foreign-protocol`, `unreachable`, mid-stream stall)
against its own hand-rolled connection stub rather than the rig.

Its comment at line 132 states the answer arm 4 was told to go read `fetchAndMergeSnapshot` for:
**`decode-error` and `busy` are both silent arms** — bookkeeping-identical to `skipped`, with
`snapshotsFetched` not incremented and nothing scored. So arm 4 should assert exactly that:
the entry is byte-for-byte unchanged by the fetch (relevance, `contactFailures`, membership,
state), and `diag.snapshotsFetched` did not move — while the *ping* half of the same tick scored
normally. Still open `fetchAndMergeSnapshot` to confirm before asserting, but expect to be pinning
silence, not scoring.

Two consequences for scope:

- Arm 4 is a **rig-driven, whole-tick** case — ping scores, fetch stays silent, both observed
  through one `stabilizeOnce`. That is genuinely not what the sibling spec covers (it calls
  `fetchAndMergeSnapshot` directly, one arm at a time), so it is not duplicate coverage. Keep it.
- If arm 4 turns out to be awkward to distinguish from the sibling spec's `decode-error` case,
  the cheapest honest outcome is to keep arms 1–3 (the ping arms, which nothing else covers) and
  say so in the handoff. Do **not** drop arms 1–3 to make room for arm 4.

### Do this, in this order

- Grep `fetchAndMergeSnapshot` in `src/service/fret-service.ts`, read that method only.
- Write `packages/fret/test/maintenance-nonok-replies.spec.ts` — four arms, assertions as
  specified above under *The four arms*. Do not re-read the rig or the backoff helper.
- `cd packages/fret && npx tsc --noEmit`, then `yarn test` foreground, no redirection.
- Re-check `docs/fret.md`'s two references to the spec path match the file landed.
