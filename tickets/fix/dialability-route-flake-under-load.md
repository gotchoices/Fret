----
description: `dialability.spec.ts:222` asserts that a forwarded maybeAct RPC over two real libp2p nodes completed, but the forward is bounded by a 5s stream read deadline with no retry, so a CPU-starved machine turns a healthy route into a recorded failure and the spec fails intermittently in a full-suite run while passing in isolation.
files: packages/fret/test/dialability.spec.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/protocols.ts, packages/fret/test/helpers/libp2p.ts
difficulty: medium
----

## Failing test

`packages/fret/test/dialability.spec.ts:222`, in
`dialability guard on outbound RPC › routeAct forwards to the reachable candidate when nearer
ones are undialable`.

```
1) dialability guard on outbound RPC
     routeAct forwards to the reachable candidate when nearer ones are undialable:
    forwarded to the reachable hop
    + expected - actual
    at Context.<anonymous> (test\dialability.spec.ts:222:100)
```

Reproduces only in a full-suite run (`yarn test` from `packages/fret/`) on a loaded machine.
`mocha "test/dialability.spec.ts"` passes in isolation every time.

## Root-cause hypothesis

The spec drives a *real* forward over two in-memory libp2p nodes and then asserts on its
side effect:

```ts
expect(svcA.getStore().getById(idB)?.successCount ?? 0, 'forwarded to the reachable hop').to.be.greaterThan(0)
```

`successCount` is incremented only on the success arm of `FretService.routeAct`
(`fret-service.ts` ~1722-1745): `await sendMaybeAct(...)` → `applySuccess(next, ...)`. Every
other outcome — a throw or a `Busy` reply — falls through to the `NearAnchor` return, which
still satisfies the *preceding* assertion at line 220 (`'anchors' in res`). That is exactly the
observed signature: line 220 passed, line 222 failed. The two assertions above it also passed,
so the selector did pick `idB` and no dial was attempted (the connection was reused) — the RPC
itself is what did not complete.

The bound on that RPC is `readAllBounded`'s overall read deadline (5s default, uniform across
the four RPCs — see *Stream management* in `docs/fret.md`) and there is no retry. So the spec's
real assertion is "the host scheduler delivered an in-process request/response inside 5s",
which a machine oversubscribed by other test processes can miss. This is the same class as the
two failures already retired in this pass (`dedup-cache.spec.ts` TTL margins, the N=100
simulation budget): a test asserting on wall-clock timing with a margin the environment can
close.

Nothing here indicates a product defect — the guard, the selector, and the success accounting
all behave correctly. The defect is that the spec has no deterministic way to observe "the
forward was made and answered".

## Suspect files

- `packages/fret/test/dialability.spec.ts` — the spec and its `countDials` helper.
- `packages/fret/src/service/fret-service.ts` ~1697-1750 — `routeAct`'s forward arm; the
  success/failure fork that the assertion reads through.
- `packages/fret/src/rpc/protocols.ts` — `readAllBounded` and the 5s read deadline.
- `packages/fret/test/helpers/libp2p.ts` — `createMemNode`, the in-memory node factory that
  would host any injected transport seam.

## Design constraints

- **No weakening.** The assertion must keep proving that the forward *reached B and was
  answered*. Dropping to "a NearAnchor came back", widening to "any of several outcomes", or
  deleting the assertion re-creates exactly what `tickets/plan/11-networked-test-assertions.md`
  exists to remove.
- **No blanket timeout inflation.** Raising the mocha timeout does not help: the failure is the
  5s *stream* deadline inside the RPC, not the test's own budget. Raising the stream deadline
  would change production behavior on every RPC to make one spec quieter.
- Prefer a seam that removes the wall clock from the assertion rather than one that buys more
  of it. Two shapes worth weighing:
  1. Observe the *forward attempt* deterministically (e.g. assert `diag.maybeActForwarded`
     incremented **and** that B's inbound handler ran) so a starved delivery fails as a
     transport error the spec can report, rather than as a silent counter that stayed 0.
  2. Give the RPC seam an injectable transport for tests, so the spec exercises
     `routeAct`'s selection + accounting without a real stream at all — and keep one real-node
     spec as the integration check.
- Whatever is chosen must keep the three sibling assertions intact: no dial for addressless
  candidates, no negotiate-failure strike for a skipped hop, and membership unchanged.
- Any injectable seam added to `FretService` is public API surface — mirror the treatment
  `DedupCache`'s `Clock` parameter got (defaulted, documented at the seam, invisible to
  production callers).

## Cross-cutting obligations

None identified: no determinism edition bump, no byte-format vector, no golden fixture, no
migration. The change is confined to test scaffolding plus (option 2 only) a defaulted
constructor parameter.

## Related observation (not this ticket's failure)

**The mocha process intermittently never exits after the suite has passed.** Observed three
times in this pass: once under artificial load (24 CPU hogs on a 24-core box, `438 passing
(6m)`, then alive ~90 min until killed) and twice on an idle machine (`438 passing (4m)`, then
alive 30+ min). One earlier idle run exited cleanly with code 0 at ~5m, so it is intermittent
rather than universal — and *not* load-specific, as first suspected.

Every test passes before the hang, so this is a leaked handle (a libp2p node or timer whose
teardown was skipped or raced), not a test failure. It matters beyond tidiness: a CI job that
never exits reads as a hang, not a pass. Recorded here rather than dropped; split it into its
own ticket when picked up. Likely first move is `--exit`-less runs with mocha's leak reporting
(or `why-is-node-running`) to name the handle, then auditing the `finally`-block teardown in
the real-node specs — several construct a `FretService` they never `stop()`.
