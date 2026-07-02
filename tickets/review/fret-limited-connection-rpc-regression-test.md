description: Review the new unit test that guards FRET's ability to run wire RPCs over relay-only (circuit-relay) connections — the code path that previously shipped with zero test coverage.
prereq:
files:
  - packages/fret/src/rpc/protocols.ts (isLimitedConnection now exported; no logic change)
  - packages/fret/test/rpc.protocols.spec.ts (new unit spec — the deliverable)
difficulty: easy
----

# Review: regression test for FRET RPCs over limited (circuit-relay) connections

## What was asked

Close a coverage gap. `openRpcStream` / `isLimitedConnection` in
`src/rpc/protocols.ts` are what let FRET's four wire RPCs open a libp2p stream
over a circuit-relay ("limited") connection with `runOnLimitedConnection: true`.
That code shipped in `p2p-fret 0.5.1` with no automated coverage, so a regression
(dropping `runOnLimitedConnection`, or libp2p changing how it stamps limited
connections) would go unnoticed. This ticket was **test-only** plus the one
`export` needed to unit-test the predicate.

## What changed

- `src/rpc/protocols.ts`: `isLimitedConnection` changed from module-private to
  `export function` — **no logic change**. It's a pure predicate; exporting keeps
  the test honest (direct assertions vs. transitive-only exercise).
- `test/rpc.protocols.spec.ts` (new): 10 tests, Mocha + Chai, hand-rolled stub
  `Libp2p`/`Connection` (no real transport). Stub connections carry
  `{ status, limits?, remoteAddr, newStream }`; `newStream` and `dialProtocol` are
  recording spies. Cast to the libp2p shape at the boundary only — no `any`.

## How to validate

```
cd packages/fret
npx tsc --noEmit
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.protocols.spec.ts" --timeout 30000
```

Both were green at handoff: `tsc` clean, **10 passing**.

## Coverage delivered

`openRpcStream` (6 tests):
- **Limited-only** connection → `newStream` called on it with
  `runOnLimitedConnection` truthy. This is the headline regression guard.
- **Direct + limited both open** (limited listed first) → the *direct*
  connection's `newStream` is called, limited's is not.
- **Closed connection ignored** → open-limited alongside a `status: 'closed'`
  direct opens on the limited one.
- **No-`newStream` connection ignored** → open-limited alongside a direct with no
  `newStream` opens on the limited one.
- **No connection + `requireExisting`** → returns `undefined`, `dialProtocol` not
  called.
- **No connection, no `requireExisting`** → falls through to `dialProtocol` with
  `runOnLimitedConnection` truthy.

`isLimitedConnection` (4 tests): `limits != null` → true; `/p2p-circuit` in
`remoteAddr` → true; plain non-circuit addr → false; absent `remoteAddr` (+ no
limits) → false with no throw.

## Reviewer notes / known gaps (test floor, not ceiling)

- **Assertions target `runOnLimitedConnection` specifically**, not deep-equality on
  the full opts object. Deliberate per the ticket — a new unrelated stream option
  should not turn these red. Tradeoff: the spec does **not** pin
  `negotiateFully: false`. If you consider that key load-bearing, add a dedicated
  assertion; it's intentionally left loose here.
- **Tie-break under multiple-limited is not over-specified.** Only the realistic
  single-limited case is pinned (`open[0]` chosen). A ring with several limited
  connections and no direct one is not asserted.
- **Stub, not real relay.** These tests prove the *selection + opts* logic, not
  that a real circuit-relay transport actually accepts the stream. End-to-end relay
  behavior remains uncovered on the Fret side — the ticket explicitly deferred the
  heavier optimystic-side integration option (a 4th node reachable only over the
  relay). If the concern is "does libp2p still honor `runOnLimitedConnection` at
  runtime," that lives in an integration/E2E test, not this unit.
- `getConnections` stub ignores its `pid` arg and returns the configured array
  regardless. Fine for these tests (single peer), but a reviewer extending this to
  multi-peer scenarios must add pid-aware routing to the stub.

## Review findings

_(none yet — reviewer fills this in)_
