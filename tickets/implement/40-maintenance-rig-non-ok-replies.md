description: Our fake-peer test harness for background maintenance can only answer "yes" or stay silent, so we cannot test what happens when a peer answers "I am too busy" or sends back an unreadable reply — widen the harness and add the missing tests.
files: packages/fret/test/helpers/maintenance-rig.ts, packages/fret/test/helpers/backoff.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/request.ts, packages/fret/test/stabilize-concurrency.spec.ts, docs/fret.md, tickets/backlog/debt-maintenance-rig-non-ok-replies.md
difficulty: medium
---

## Why

`packages/fret/test/helpers/maintenance-rig.ts` is the shared harness for every pooled maintenance
path (the stabilization tick, both connection warm-up passes). Its per-peer behavior type is
exactly two values — `'answers' | 'hangs'` — and its reply builder hard-codes `{ok: true, ts}` for
a ping and an empty snapshot for a neighbors fetch. So **no** maintenance-path spec can express a
peer that replied *something other than yes*, and three arms of `probeNeighborLatency` are
consequently unreachable from any integration test:

- a ping answered `busy` — membership confirmed, contact-failure run cleared, **backoff recorded**,
  no relevance decay, no contact strike, and the snapshot fetch still runs;
- a ping answered `ok: false` — membership confirmed, run cleared, relevance **decayed**, no
  strike, no backoff, and the snapshot fetch still runs;
- a reply whose bytes will not decode — proof of life, relevance decayed only, no strike, no
  backoff, and the snapshot fetch still runs.

Verified by reading the suite, not inferred: `busy` does not appear in
`packages/fret/test/failure-recovery.spec.ts` at all, and its only occurrence in
`packages/fret/test/dead-state.spec.ts` is inside a prose comment.

The root cause is the harness, not any one spec — which is why this is one ticket about the
harness rather than three point tickets about three arms. Widening it retires the whole class
*the peer answered, but not well* at once.

## Design — settled, not left to the implementer

### 1. Widen `Behavior`

```ts
export type Behavior =
	| 'answers'      // ping {ok:true, ts}; neighbors -> empty snapshot   (unchanged default)
	| 'hangs'        // stream open settles only on abort                 (unchanged)
	| 'busy'         // {busy: true, retry_after_ms: 500}
	| 'not-ok'       // ping only: {ok: false, ts}
	| 'undecodable'  // a well-framed body that is not a JSON object
```

Rules that make the widening safe rather than merely wider:

- **`'answers'` stays the default** at both lookup sites (`protocolBehavior` then `behavior`), so
  every existing spec is byte-for-byte unchanged. This ticket adds capability; it changes no
  existing assertion.
- **`'busy'` and `'undecodable'` apply to either protocol.** That is deliberate: `busy` on the
  neighbors protocol is what makes `fetchAndMergeSnapshot`'s own busy arm reachable for the first
  time, and the per-(peer, protocol) map (`setProtocolBehavior`) already composes — a peer can
  answer its ping and go busy on the fetch.
- **`'not-ok'` is ping-only.** A neighbors reply has no `ok` field, so setting `'not-ok'` against
  the neighbors protocol must **reject loudly** — the same `Promise.reject(new Error(...))` shape
  the reply builder already uses for an unexpected protocol. A mis-set behavior must fail the run,
  never pass vacuously by silently degrading to something else.
- **`retry_after_ms` is a fixed 500, with no knob.** No caller reads the hint today (`RpcOutcome`'s
  `busy` variant exposes it; nothing consumes it), so a configurable value would be an untested
  parameter. Add a knob when a consumer exists.
- **`'undecodable'` is a valid frame carrying invalid content**, e.g.
  `lp.encode.single(new TextEncoder().encode('nope')).subarray()`. It must be a *complete* frame:
  a truncated one exercises `FrameTruncationError` (a different arm, already pinned by
  `test/rpc.stream-errors.spec.ts`) rather than `decodeJson` rejection. Both classify
  `decode-error`, but only the complete frame proves the peer answered *fully* and badly.

### 2. Where the `busy` shape is recognised (do not fight it)

`rpcRequest`'s `decodeReply` (`src/rpc/request.ts`) tests `isBusyShape` on the **parsed** body
*before* `decode` runs, so a reply validator never sees a busy body and the `busy` outcome reaches
both `sendPing` and `fetchNeighbors` unchanged. The rig therefore needs no per-sender special
casing: one busy body serves every protocol.

### 3. Where the new assertions live

A new spec, `packages/fret/test/maintenance-nonok-replies.spec.ts`, driven through `stabilizeOnce`
on the rig. It is **not** an addition to `failure-recovery.spec.ts`: that spec's own header claims
ownership of the *unreachable / timeout* arc across two real nodes with a fake clock, and it does
not use the rig at all. Nor is it an addition to `stabilize-concurrency.spec.ts`, which owns pool
shape (cap, ordering, disjointness, budgets) rather than per-arm scoring.

The existing `test/helpers/backoff.ts` (`backoffOf`, `setBackoffOf`) is how the new spec reads the
escalation factor without reaching into private state by hand.

### Expected behaviour the new spec must pin

Seed one near peer as a live `member`, snapshot its relevance and `contactFailures`, drive one
`stabilizeOnce`, then assert per arm:

- **ping `busy`** — `backoffOf(svc).factor(id) > 0`; relevance **unchanged**; `contactFailures`
  still 0 (and a pre-seeded run cleared to 0); `membership === 'member'`; `diag.pingsSent` and
  `diag.pingsFail` each +1; `rig.protocolsSeenBy(id)` contains the neighbors protocol **after**
  the ping — the peer answered, so the fetch still runs.
- **ping `not-ok`** — relevance strictly **decreased**; `contactFailures` 0; backoff factor 0;
  `membership === 'member'`; `pingsSent` +1, `pingsFail` +1; neighbors protocol still opened.
- **ping `undecodable`** — relevance strictly decreased; `contactFailures` 0; backoff factor 0;
  `membership === 'member'`; neighbors protocol still opened.
- **neighbors `busy` behind an `answers` ping** — the ping arm scores normally (relevance up,
  backoff 0 from the ping) and `fetchAndMergeSnapshot` takes its busy arm:
  `diag.snapshotsFetched` **not** incremented, no contact strike. Read `fetchAndMergeSnapshot`
  before writing this one and assert what it actually does — that arm is deliberately silent about
  scoring, and the assertion must pin today's behaviour, not a guess at it.

Every arm's headline is the same and worth stating in the spec header: **an answer that is not a
good answer is still an answer** — it confirms membership and clears the contact-failure run, and
it never books a contact strike.

## Edge cases & interactions

- **Contact-failure run clearing needs a pre-seeded run to be observable.** Seeding
  `contactFailures: 0` proves nothing about clearing. Seed a peer at `contactFailures: 2` (via the
  rig's `patch` argument) and assert the busy tick drives it to 0 — otherwise the "clears the run"
  half of the arm is asserted vacuously.
- **500 ms strike spacing** (`lastContactFailureAt`) governs whether a *failure* counts. These arms
  book no strike at all, so spacing must not be needed to make an assertion pass; if an assertion
  only holds because of spacing, the arm under test is booking a strike it should not.
- **The peer must not be marked `dead` by these arms.** Assert `state !== 'dead'` on every one —
  a strike leaking in is exactly the regression this spec exists to catch, and after three of them
  the peer silently leaves every ring view.
- **The rig never starts the service**, so `runSignal` is `undefined` and `stabilizeOnce` must be
  driven directly. Do not start the loop; a live loop races the assertions.
- **`stabilizeOnce` phase 2 runs too.** A seeded peer left `unknown` or `dead` also reaches
  `probeMembership`, which scores differently. Seed near peers as live `member` so the arm under
  test is unambiguously the near pass, and assert on `rig.protocolsSeenBy` to prove which pass did
  the contacting.
- **Pool overlap can reorder recordings.** `opened` is per-peer and append-ordered, so ping-before-
  fetch is safe to assert per peer; do not assert a global ordering across peers.
- **`teardown` must still restore the tick-budget static and `getConnections`.** If a new test
  mutates `STABILIZE_TICK_BUDGET_MS`, restore through the rig's existing hook rather than by hand,
  or a later spec in the same mocha process inherits it.
- **Both profiles.** The arms are profile-independent, but `maintenanceConcurrency` and the near
  budget are not. Prefer core for the scoring assertions and keep peer counts at or below the near
  budget (4) so no peer is truncated out of the tick and read as "scored nothing".
- **`'undecodable'` must not be silently upgraded.** `decodeJson` trims NUL/whitespace and rejects
  a non-object top level; a body of `'null'` or `'[]'` also rejects, but a body of `'{}'` **parses
  fine** and then fails the reply *parser* instead — also `decode-error`, but by a different route.
  Pick a body that fails at `decodeJson` and say so in a comment, so a future reader does not
  "simplify" it into the other path.

## TODO

- Widen `Behavior` in `packages/fret/test/helpers/maintenance-rig.ts` to the five values above;
  keep `'answers'` the default at both lookup sites.
- Rework `PeerRig.reply` into a per-(protocol, behavior) builder: `busy` and `undecodable` serve
  either protocol, `not-ok` serves ping only and rejects loudly on neighbors, unknown protocol
  keeps today's loud rejection.
- Update the rig's file header comment — it currently states the stub answers every ping
  `{ok: true}`, which this change makes false.
- Add `packages/fret/test/maintenance-nonok-replies.spec.ts` with the four arms and the assertions
  listed above, including the pre-seeded contact-failure run and the `state !== 'dead'` check.
- Read `fetchAndMergeSnapshot` before writing the neighbors-`busy` arm and pin what it actually
  does today; if it turns out to score nothing at all, assert that explicitly rather than skipping
  the case.
- Correct `docs/fret.md`: the *Failure detection and recovery* bullet (~line 79) says "That `busy`
  arm is not covered by any test today", blames the rig's two-valued stub, and points at
  `tickets/backlog/debt-maintenance-rig-non-ok-replies`. Replace all three claims with the new
  spec's path. Check the trailing sentence of that same bullet ("the `busy` arm is not (see
  above)") — it says the same thing twice and must not be left half-corrected.
- Delete the stale duplicate `tickets/backlog/debt-maintenance-rig-non-ok-replies.md` — it is the
  same slug and the same work as this ticket, and leaving it invites a re-file.
- Run `cd packages/fret && npx tsc --noEmit`, then `yarn test` in the foreground with no
  redirection.

## Related, not blocking

Two sibling tickets reference this same harness limitation and are unblocked by it, not by each
other — whoever picks either up should land the harness change once and then satisfy both:

- `debt-fetch-snapshot-failure-arms-untested` — the arms of the neighbor-snapshot *fetch*, one RPC
  later than the ping. The neighbors-`busy` arm above is the first of them; the rest stay that
  ticket's scope.
- `debt-backoff-map-test-surface` — extracting the probe-backoff bookkeeping so its *arithmetic* is
  unit-testable. Different file, different concern; this ticket only asserts that a busy ping
  records *some* backoff, never what factor it lands on.

Neither was in `tickets/backlog/` at the top level when this was written; check the `backlog/impl`
and `backlog/plan` sub-folders before concluding they are gone.
