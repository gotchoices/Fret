description: Add tests proving that when this node asks a peer for its neighbour list and the request fails, each of the different ways it can fail is handled the way the code intends — so a future change that breaks one of those reactions gets caught instead of shipping silently.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.snapshot-merge-cap.spec.ts, packages/fret/test/dead-state.spec.ts, packages/fret/test/rpc.stream-errors.spec.ts, packages/fret/test/helpers/maintenance-rig.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
----

<!-- resume-note -->
Second run in a row that hit the session's soft token budget during discovery, before any test
code was written or any file edited — still no partial implementation exists. This time discovery
got much further; the next agent should go straight to writing tests using the pointers below,
not re-open the search.

**Confirmed facts (read once, trust them):**

1. `fetchAndMergeSnapshot` is a private method on `FretService` at `fret-service.ts:2637-2681`
   (`packages/fret/src/service/fret-service.ts`), a `switch (out.kind)` over
   `RpcOutcome<NeighborSnapshotV1>` (`packages/fret/src/rpc/outcome.ts`) with arms `skipped`,
   `cancelled`, `busy`/`decode-error` (shared log line, same "score nothing" handling),
   `foreign-protocol`/`unreachable`/`timeout` (all route through `noteRpcFailure`), `ok`. Public
   call path reaches it via `probeAndFetch` at `fret-service.ts:2324-2336`, from `stabilizeOnce`'s
   phase-1 pool. `RpcOutcome` variant doc-comments in `outcome.ts` state exactly what each proves
   about the peer — read those before writing assertions, they're the spec.

2. **`ok`-arm scaffolding lives in `packages/fret/test/rpc.snapshot-merge-cap.spec.ts`**, NOT
   `rpc.handler-fuzz.spec.ts` (that guess, from an earlier run, was wrong — confirmed by grep, no
   match at all). The reusable pieces, all inside the `'RPC snapshot merge caps'` →
   `'snapshot merge caps'` describe block:
   - `replyStream(body)` (~line 171): a stub `Stream` serving exactly one framed JSON reply —
     the raw building block for driving any `fetchNeighbors` outcome, `ok` or otherwise.
   - `fetchMerged(node, svc, body)` (~line 205): overrides `node.getConnections` to return one
     stub open connection whose `newStream` resolves to `replyStream(body)`, restores the real
     `getConnections` in a `finally`, and calls `(svc as any).fetchAndMergeSnapshot(FROM, undefined)`
     directly. This is the shape to copy for the new arms — just vary what the stream produces.
   - `countUpserts(svc)` (~line 154): wraps `store.upsert` to record ids in call order — useful for
     asserting a failure arm upserts nothing.
   This file is a strong candidate to extend (add a new `describe` block alongside `'snapshot merge
   caps'`), or start a sibling `fetch-snapshot-failure-arms.spec.ts` that imports/copies just
   `replyStream` + the connection-override pattern. Either is fine per the original ticket text
   below ("Prefer one test file... over scattering").

3. **The `cancelled` arm may already be directly covered — verify before writing a new test.**
   `packages/fret/test/dead-state.spec.ts`, describe block `'cancellation is not evidence about a
   peer'`, test `'merges nothing and scores nothing when a snapshot fetch is cancelled'`
   (~line 1035-1046), calls `(svc as any).fetchAndMergeSnapshot(id, (svc as any).runSignal)`
   **directly** with an aborted run signal, and asserts `snapshotsFetched` unchanged, store size
   unchanged, and `expectUnscored(id)` (no contact strike, no relevance decay, no negotiate
   failure, no backoff — see `expectUnscored` ~line 920). This reads as exactly the direct
   `fetchAndMergeSnapshot`-cancelled-arm test the ticket body below asks for, contradicting the
   ticket's claim that cancellation is only covered "indirectly". **Read that test first.** If it
   already satisfies the ticket's `cancelled` requirement, skip re-adding it and note that in the
   TODO checklist as "already covered, see dead-state.spec.ts:1035" rather than duplicating it.

4. **No existing test drives `skipped`, `decode-error`, `foreign-protocol`, `unreachable`, or
   `timeout` through `fetchAndMergeSnapshot` directly** (confirmed by reading
   `rpc.snapshot-merge-cap.spec.ts`, `dead-state.spec.ts`, and `rpc.stream-errors.spec.ts` in full —
   the closest relatives drive `routeAct` / `probeNeighborLatency` / `sendPing` /
   `fetchNeighbors`-the-sender instead of the service's `fetchAndMergeSnapshot` wrapper). These five
   are the real remaining work.

5. **`packages/fret/test/helpers/maintenance-rig.ts`'s `PeerRig` is NOT the right tool for the
   five failure arms.** Its `Behavior` type is only `'answers' | 'hangs'`, and `reply()` hard-codes
   `{ok: true}` for ping / an empty-but-valid snapshot for neighbors — it cannot produce a
   malformed body, an unsupported-protocol failure, or a hard dial rejection. The original ticket
   text already says to reuse the `rpc.stream-errors.spec.ts`-style stubbing instead of extending
   the rig — confirmed correct, do that. For reference, `rpc.stream-errors.spec.ts`'s own
   `makeStubStream` / `ReadStep` machinery (~line 120-178) and its `'what the service records'`
   describe block (~line 610-802, esp. the `getConnections` override in `beforeEach` ~line 617-637)
   is a second good template for the per-peer stub-connection pattern, if `replyStream` from
   `rpc.snapshot-merge-cap.spec.ts` proves too thin for a given arm (e.g. `unreachable` needs a
   connection whose `newStream` *rejects*, which neither existing helper does out of the box —
   write a small local variant).

6. **Concrete approach per arm**, building on point 5:
   - `skipped`: don't stub a connection at all — leave `getConnections` returning `[]` for that
     peer id (or don't override it) so `fetchNeighbors`'s `dial: 'never'` yields `skipped` with
     zero stream activity.
   - `decode-error`: stub a connection/stream (à la `replyStream`) that returns bytes failing to
     decode as `NeighborSnapshotV1` — e.g. framed non-JSON bytes, or JSON missing required fields
     (the parser in `makeSnapshotParser` rejects it). `rpc.stream-errors.spec.ts`'s `halfThenEof` /
     truncated-frame helpers are one way to get there; a simpler malformed-but-complete JSON body
     is another and may be easier to reason about for this arm specifically.
   - `foreign-protocol`: real two-node setup (two `createMemNode()`s, dial connected) where the
     second node's `FretService` never calls `registerRpcHandlers()` for `/fret/1.0.0/neighbors`
     (or is simply never `start()`ed) — protocol negotiation fails and `fetchNeighbors` returns
     `foreign-protocol`. This mirrors how the `ok`-arm test in `rpc.snapshot-merge-cap.spec.ts`
     already does a real two-node run for other purposes elsewhere in the suite — but note that
     file's own `ok` coverage is actually the *stub*-connection path (point 2 above), not a real
     two-node run; a genuine two-node negotiation-failure setup will need to be written fresh, most
     likely by starting one real node's `FretService` (so its `fetchAndMergeSnapshot` runs for
     real) against a second real node whose service is constructed but not started.
   - `unreachable`: stub a connection whose `newStream` rejects (dial/stream-open failure), or omit
     a connection and instead make `node.dialProtocol` reject if `fetchNeighbors`'s dial mode ever
     reaches it — check `fetchNeighbors`'s exact dial mode (`'never'`, confirmed at
     `fret-service.ts:2643-2649`) before choosing; since it's dial-never, `unreachable` here most
     likely means an existing connection whose `newStream` throws, not a dial failure — trace
     `openRpcStream`'s `unreachable` production path for a connection-exists-but-stream-open-fails
     case and mirror it.
   - `timeout`: needs a stub stream that hangs (never resolves/rejects) combined with a short
     `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` so the wait is bounded in test time. `maintenance-rig.ts`'s
     `hangsUntilAbort` (line 35) is reusable as a bare function even without adopting the rest of
     `PeerRig` — it resolves only when the passed signal aborts, matching libp2p's `newStream`
     contract. `FretService.MAINTENANCE_SNAPSHOT_TIMEOUT_MS` is a static; check whether it's
     overridable the same way `maintenance-rig.ts` overrides `STABILIZE_TICK_BUDGET_MS`
     (`(FretService as any).STABILIZE_TICK_BUDGET_MS = ms`, restored in teardown) — if so, do the
     same for the snapshot timeout static in a `beforeEach`/`afterEach` pair, so the test doesn't
     wait out the real 1000ms default.

Everything below this note is the original ticket body, unchanged, and still accurate scope.
Proceed straight to writing tests using points 1-6 above rather than re-discovering them.

## Where this is

`packages/fret/src/service/fret-service.ts`, `fetchAndMergeSnapshot` (~line 2637) — a `switch (out.kind)`
over `RpcOutcome<NeighborSnapshotV1>` with 8 arms (`skipped`, `cancelled`, `busy`, `decode-error`,
`foreign-protocol`, `unreachable`, `timeout`, `ok`). `RpcOutcome` is defined in `src/rpc/outcome.ts`.

## What's already covered vs not

- **`ok`** — covered thoroughly by a real two-node fetch-path test (see resume-note above for which
  file — verify before assuming `rpc.handler-fuzz.spec.ts`), which drives a real reply through this
  method over a real transport and checks exactly which peers get stored.
- **`cancelled` / "nothing attempted"** — covered *indirectly* today, via the broader rule asserted in
  `packages/fret/test/dead-state.spec.ts` ("our own cancellation never counts against a peer"). Not
  asserted directly against `fetchAndMergeSnapshot`'s own bookkeeping.
- **`skipped`, `busy`, `decode-error`, `foreign-protocol`, `unreachable`, `timeout`** — not covered at all.

## Scope of this ticket: 6 of the 7 non-success arms

Write one test per arm for: `skipped`, `cancelled`, `decode-error`, `foreign-protocol`, `unreachable`,
`timeout`. Each test should drive `fetchAndMergeSnapshot` (or the public path that reaches it — see
existing call site at `fret-service.ts:2335` inside `probeAndFetch`) against a rigged outcome of that
kind, then assert:

- **`skipped`** (no connection attempted): no connection stub / undialable peer → `announced` returns
  empty, no `noteRpcFailure` bookkeeping fires (no `contactFailures` increment, no relevance decay).
  Can be driven directly — no rig change needed, just omit the stubbed connection.
- **`cancelled`** (our own abort): pass an already-aborted `AbortSignal` → same "score nothing" assertion
  as `skipped`, distinctly from `dead-state.spec.ts`'s broader/indirect coverage. This closes the "not
  directly tested against this method" gap noted above.
- **`decode-error`** (peer answered with something unreadable): stub a stream that replies with bytes
  that fail to decode as `NeighborSnapshotV1` JSON (pattern already used in
  `packages/fret/test/rpc.stream-errors.spec.ts` for other RPCs — reuse that stubbing approach rather
  than extending `maintenance-rig.ts`, since the rig's behavior abstraction doesn't need to grow for
  this). Assert: peer's membership signal raised toward `member` / contact-failure run cleared (this
  arm is proof-of-life — the peer answered on our namespaced protocol), relevance decayed, but **no**
  contact-failure strike recorded. This is the arm docs/fret.md calls out by name as the one most worth
  pinning ("Evidence strength" / "Our own cancellation is not evidence" sections).
- **`foreign-protocol`** (peer belongs to a different network): drive over a real two-node setup (like
  the existing `ok`-arm test does) where the second node never registers this network's
  `/fret/1.0.0/neighbors` handler — protocol negotiation fails. Assert `noteRpcFailure` routes this
  through `applyMembershipSignal(id, 'negotiate-failure')`, i.e. one negotiate-failure strike, not a
  contact-failure strike (see `applyMembershipSignal`, `fret-service.ts:936`).
  - Existing test may need repeats (3x) to observe the `foreign` demotion threshold, or assert the
    single-call increment of `negotiateFailures` directly rather than driving to full demotion — either
    is fine, pick whichever is less test code.
- **`unreachable`**: stub a peer with no dialable address / a dial that rejects. Assert one contact
  failure strike via `noteRpcFailure` (`applyContactFailure` path), no relevance credit.
- **`timeout`**: use `maintenance-rig.ts`'s existing `'hangs'` behavior (`hangsUntilAbort`, already
  present at `maintenance-rig.ts:35`) with a short timeout so the tick's own deadline fires. Assert same
  contact-failure strike as `unreachable` — both are "could not reach it at all" evidence per
  docs/fret.md's evidence-strength table.

Prefer one test file (either extend the file identified above next to the existing `ok`-arm test, or a
new `fetch-snapshot-failure-arms.spec.ts` alongside it) over scattering across files — the existing
fetch-path test already builds most of the scaffolding (stub reply, stubbed connection), so reuse it.

## Out of scope: the `busy` arm

The `busy` arm ("the peer said it was too busy") is **not** in scope for this ticket. Driving it needs
`maintenance-rig.ts` to answer a maintenance-protocol RPC with a non-`ok` reply shape; today the rig's
`Behavior` type is exactly `'answers' | 'hangs'` and its reply builder hard-codes `{ok: true}`
(`maintenance-rig.ts:26,127`) — there is no way to make a rigged peer answer `busy` on any maintenance
RPC today, ping included (docs/fret.md already documents the ping-side gap as untested for the same
reason). See `tickets/backlog/debt-maintenance-rig-non-ok-replies.md` for the harness-side fix; once
that lands, add the 7th test here as a small follow-up. Leaving it out now is consistent with the
original ticket's own stated tradeoff (bookkeeping-only, cheap to read instead of test) and with the
precedent already accepted for the ping-side `busy` arm.

## Expected outcome

Each of `skipped`, `cancelled`, `decode-error`, `foreign-protocol`, `unreachable`, `timeout` has a test
pinning both what bookkeeping it does and what it deliberately does not (no contact strike for
`decode-error`; no strike at all for `skipped`/`cancelled`; negotiate- not contact-strike for
`foreign-protocol`). `yarn test` (from `packages/fret/`) green.

## Edge cases & interactions

- **`decode-error` vs `foreign-protocol` vs `unreachable`/`timeout` must land on visibly different
  counters** — asserting only "no exception thrown" for all three would pass even if a future edit
  collapsed them onto the same bookkeeping path (exactly the kind of drift `docs/fret.md`'s "Evidence
  strength" table exists to prevent). Assert the specific field each is documented to touch:
  `contactFailures` (unreachable/timeout only), `negotiateFailures` (foreign-protocol only), relevance
  decay (decode-error, and unreachable/timeout), membership signal (decode-error only, via
  `noteAnsweredOnProtocol`).
- **`cancelled` test must not accidentally exercise `skipped`'s path** (e.g. by also having no stubbed
  connection) — keep the two tests' setups minimal and distinct so a regression in one doesn't
  silently pass because the other's assertion is what's really firing.
- **Timeout test must not flake on real wall-clock timing** — use the rig's configurable timeout/short
  deadline rather than depending on `MAINTENANCE_SNAPSHOT_TIMEOUT_MS`'s real 1000ms value directly if
  the existing test infra supports overriding it (check how other maintenance-rig specs already do
  this before inventing a new mechanism).

## TODO

- Confirm which existing spec file holds the `ok`-arm fetch-path test (see resume-note — not
  `rpc.handler-fuzz.spec.ts`; `rpc.snapshot-merge-cap.spec.ts` is the leading candidate) and reuse its
  scaffolding
- Add `skipped` arm test
- Add `cancelled` arm test (direct against `fetchAndMergeSnapshot`, distinct from `dead-state.spec.ts`'s indirect coverage)
- Add `decode-error` arm test
- Add `foreign-protocol` arm test
- Add `unreachable` arm test
- Add `timeout` arm test
- Run `yarn test` from `packages/fret/` and confirm green
- Leave `busy` arm out of scope; confirm `tickets/backlog/debt-maintenance-rig-non-ok-replies.md` still describes it

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
