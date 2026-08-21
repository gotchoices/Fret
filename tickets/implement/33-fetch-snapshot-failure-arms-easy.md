description: Add tests proving that when this node asks a peer for its neighbour list and the peer either doesn't answer at all or answers with garbage, the code's bookkeeping reaction stays exactly what it is today — so a future change that silently starts scoring these cases gets caught.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/fetch-snapshot-failure-arms.spec.ts (new), packages/fret/test/rpc.snapshot-merge-cap.spec.ts, packages/fret/test/dead-state.spec.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
----

This is a narrowed continuation of a ticket (`fetch-snapshot-failure-arms-tests`) that hit the
session token budget twice in a row during discovery and once more before any test code got
written. Discovery is now done — this ticket is scoped to the two arms that need **no new test
machinery**, reusing what already exists in `rpc.snapshot-merge-cap.spec.ts`. A sibling ticket
(`fetch-snapshot-failure-arms-hard`, prereq on this one, same target file) covers the three arms
that need new stubbing (rejecting connections, hanging streams, real two-node negotiation
failure) — don't do that work here, leave it to that ticket.

## Where this is

`packages/fret/src/service/fret-service.ts`, `fetchAndMergeSnapshot` (private method, confirmed at
lines 2637–2681 this run) — a `switch (out.kind)` over `RpcOutcome<NeighborSnapshotV1>`
(`src/rpc/outcome.ts`). Exact current code for the arms this ticket covers (read directly, no need
to re-open the file for this part):

```ts
switch (out.kind) {
    case 'skipped':      // no connection — nothing attempted, count nothing
    case 'cancelled':    // our own cancellation — not evidence about the peer
        return announced;
    case 'busy':
    case 'decode-error':
        // Answered badly / refused: alive. Today's empty-snapshot path scored nothing — preserved.
        log.error('fetchNeighbors %s from %s', out.kind, id);
        return announced;
    case 'foreign-protocol':
    case 'unreachable':
    case 'timeout':
        await this.noteRpcFailure(id, out);
        return announced;
    case 'ok':
        break;
}
```

**Critical correction to the original ticket's assumptions — read this before writing the
decode-error test.** The original ticket text (still describing the overall feature below) claims
the `decode-error` arm should be asserted as: "peer's membership signal raised toward `member` /
contact-failure run cleared ..., relevance decayed, but no contact-failure strike recorded." That
is **wrong for this method**, confirmed by reading the code above this run: `busy` and
`decode-error` fall into the *same* switch arm as each other, and that arm calls **only**
`log.error` — it never calls `noteRpcFailure`, never touches membership, never decays relevance.
The comment directly above it says why: *"Today's empty-snapshot path scored nothing — preserved."*
This is a deliberate compatibility decision, not a bug. (The evidence-strength promotion the
original ticket describes may be real for *other* call sites like `probeNeighborLatency` — it is
simply not what this method does.)

So the correct test for `decode-error` pins the **opposite** of what the original ticket assumed:
that this method's bookkeeping reaction to `decode-error` is **identical to `skipped`/`cancelled`**
— nothing moves — reached via a genuinely different `RpcOutcome` kind (a real stream was opened
and a real, unusable reply was read, rather than nothing being attempted at all). The two
observable differences from `skipped`: (1) a connection/stream really was exercised (the stub records
that its stream's async iterator was pulled), and (2) `log.error` was called — everything else
(`contactFailures`, `negotiateFailures`, relevance, membership label, `snapshotsFetched`) must be
provably unchanged. If you want an even cheaper single source of truth: assert the peer's full
routing-table entry (`store.getById(id)`) is deep-equal before and after the call, plus
`snapshotsFetched` unchanged (it only increments on `ok`) and `announced` returns `[]`.

## Reusable scaffolding (already exists, don't rebuild)

`packages/fret/test/rpc.snapshot-merge-cap.spec.ts`, inside `describe('RPC snapshot merge caps')` →
`describe('snapshot merge caps')` (read the whole block — it's ~450 lines and every helper below is
copy-adaptable):

- `replyStream(body)` (~line 171): builds a stub `Stream` that serves exactly one framed JSON
  reply from `body` via `json(body)` (from `test/helpers/rpc-fuzz.ts`), then ends. `send`/`close`/
  `abort` are no-ops that satisfy the `Stream` type; only the async iterator matters for a
  fetch (`fetchNeighbors` never writes a body and never half-closes).
- `fetchMerged(node, svc, body)` (~line 205): overrides `node.getConnections` to return one stub
  connection (`{status: 'open', newStream: async () => replyStream(body)}`), restores the real
  `getConnections` in a `finally`, and calls `(svc as any).fetchAndMergeSnapshot(FROM, undefined)`
  directly. `FROM = peerIdStr(60)` in that file — pick a **different** seed for your own `FROM` in
  the new file to avoid any accidental id collision if both files ever share a store (they don't,
  each test gets its own `beforeEach`-created node/service, so this is just hygiene).
- `countUpserts(svc)` (~line 154): wraps `store.upsert` to record every id upserted, in call order.
- Both node and service are created fresh per test: `node = await createMemNode(); await
  node.start(); svc = new CoreFretService(node, { profile, networkName: NETWORK })` — **service is
  deliberately never `start()`ed** (no stabilization loop, no registered handlers, so nothing else
  touches the store during the test).
- `peerIdStr(n)` (from `test/helpers/rpc-fuzz.ts`) produces a distinct, parseable peer-id string
  from a small integer seed — reuse it for your own test peer ids.

Create a new file `packages/fret/test/fetch-snapshot-failure-arms.spec.ts` (not the merge-cap file
— that file already owns a different subject). Import the same helpers (`createMemNode`, `stopAll`
from `./helpers/libp2p.js`; `NETWORK`, `peerIdStr`, `json`, `sleep` from `./helpers/rpc-fuzz.js`;
`FretService as CoreFretService` from `../src/service/fret-service.js`). You do not need
`registerNeighbors` or `makeSnapshotParser` directly for this ticket's two arms — `fetchMerged`-style
driving goes through the service's own `fetchAndMergeSnapshot`, which builds its own parser
internally.

## Arm 1: `skipped`

No connection stubbed at all — just don't override `getConnections`. On an unstarted, never-dialed
node, `node.getConnections(peerId)` returns `[]` for any id, so `fetchNeighbors`'s `dial: 'never'`
mode yields `skipped` with zero stream activity.

- Pre-seed a routing-table entry for the target peer first (`svc.getStore().upsert(id, coord)` —
  use a real 32-byte `Uint8Array` coordinate, e.g. `new Uint8Array(32).fill(7)`, or hash a real
  peer id via `hashPeerId` like the merge-cap spec's re-hash test does) so there is something
  concrete to assert stayed untouched. Capture the entry (or the fields you care about:
  `contactFailures`, `negotiateFailures`, `relevance`, `membership`, `state`) before the call.
- Call `(svc as any).fetchAndMergeSnapshot(id, undefined)` directly.
- Assert: return value is `[]`; the pre-seeded entry's fields are unchanged; `svc.getDiagnostics
  ().snapshotsFetched` (or whatever the diagnostics getter is named — grep `diag.snapshotsFetched`
  in `fret-service.ts` for the exact accessor) did not increment.

## Arm 2: `decode-error`

Use a `fetchMerged`-style connection override (copy the pattern, don't import the private helper
across files) with a stub stream that serves a body the snapshot parser will reject outright — not
merely truncate. `makeSnapshotParser` (`src/rpc/validate.ts`) rejects (returns `undefined`) when
`from` is not a parseable peer id, or when `timestamp` is not finite — either is a one-line way to
force a genuine parser rejection (which surfaces as `RpcOutcome` kind `decode-error` via
`parseOrThrow`/`ReplyRejectedError` inside `rpcRequest` — see `docs/fret.md`'s *Wire-shape parsers*
section, "every reply parser is wired into its sender"). A body like:

```ts
{ v: 1, from: 'not-a-peer-id', timestamp: Date.now(), successors: [], predecessors: [], sig: '' }
```

should do it (mirrors patterns already used in `rpc.snapshot-merge-cap.spec.ts`, e.g. its
`'not-a-peer-id'` sample-entry case, just applied to the snapshot's own `from` field this time
instead of a sample entry's `id`).

- Pre-seed the target peer's routing-table entry the same way as Arm 1, capture its fields.
- Drive `fetchAndMergeSnapshot` through the stub connection (copy `fetchMerged`'s override-then-
  restore pattern).
- Assert (per the correction above): return value `[]`; the pre-seeded entry's fields
  (`contactFailures`, `negotiateFailures`, `relevance`, `membership`, `state`) are **all**
  unchanged — identical to Arm 1's assertion, proving this arm is bookkeeping-equivalent to
  `skipped` despite reaching a different `RpcOutcome` kind; `snapshotsFetched` unchanged.
- Optional but cheap: assert the stub stream's async iterator was actually pulled (e.g. a counter
  incremented inside `next()`), so the test can't accidentally pass because the connection override
  silently didn't engage (i.e. because it degraded to `skipped` instead of genuinely reaching
  `decode-error`).

## Arm 3 (verify-only, no new test needed if confirmed): `cancelled`

A prior discovery pass (still trusted, not re-verified this run) found
`packages/fret/test/dead-state.spec.ts`, describe block `'cancellation is not evidence about a
peer'`, test `'merges nothing and scores nothing when a snapshot fetch is cancelled'` (~line
1035–1046), which calls `(svc as any).fetchAndMergeSnapshot(id, (svc as any).runSignal)` **directly**
with an aborted run signal, and asserts `snapshotsFetched` unchanged, store size unchanged, and
`expectUnscored(id)` (no contact strike, no relevance decay, no negotiate failure, no backoff — see
`expectUnscored` ~line 920).

- Read that test once to confirm it really does directly exercise `fetchAndMergeSnapshot` with a
  pre-aborted signal (not some other method).
- If confirmed: do **not** duplicate it. Just note in your handoff "cancelled arm already covered
  directly, see `dead-state.spec.ts:1035`" — this satisfies the original ticket's requirement for
  a *direct* (not merely indirect) cancelled-arm test.
- If it turns out to be testing something else (e.g. a different method, or only the broader
  indirect rule): add a minimal direct test here instead, following the same pattern as Arms 1–2
  but passing an already-aborted `AbortSignal` (`AbortSignal.abort()` or a fresh
  `AbortController().abort()`) as `fetchAndMergeSnapshot`'s second argument, with no connection
  stub needed (an aborted signal is checked before dialing, per `rpcRequest`'s cancellation-first
  rule in `docs/fret.md`'s *Stream management* section).

## Expected outcome

New file `fetch-snapshot-failure-arms.spec.ts` with tests for `skipped` and `decode-error`, plus a
confirmed-or-added `cancelled` direct test. `yarn test` (from `packages/fret/`) green. Leave
`foreign-protocol`, `unreachable`, `timeout`, and `busy` to the sibling
`fetch-snapshot-failure-arms-hard` ticket (busy stays fully out of scope per the original ticket's
tradeoff, tracked in `tickets/backlog/debt-maintenance-rig-non-ok-replies.md`).

## TODO

- Create `packages/fret/test/fetch-snapshot-failure-arms.spec.ts`
- Add `skipped` arm test
- Add `decode-error` arm test (assert bookkeeping-identical to `skipped` — see correction above)
- Read `dead-state.spec.ts:~1035` and confirm/add direct `cancelled` arm test
- Run `yarn test` from `packages/fret/` and confirm green

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
