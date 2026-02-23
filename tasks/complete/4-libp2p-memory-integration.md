description: libp2p in-memory integration tests using @libp2p/memory transport
dependencies: @libp2p/memory, @libp2p/plaintext (devDeps), FRET core service
----

### Summary

End-to-end integration tests exercising real FRET protocol flows over
libp2p's in-memory transport (no TCP, no sockets). Also fixed a yamux
stream-close workaround in `readAllBounded` and migrated existing tests
(churn.leave, iterative-lookup) from TCP to memory transport for reliability.

### Changes

**New file: `packages/fret/test/libp2p-memory.integration.spec.ts`** (7 tests)
- 3-node neighbor exchange: verifies peer discovery and snapshot fetches
- 10-node convergence: verifies S/P set population for all nodes
- routeAct returns NearAnchor with anchors and cohort hints
- routeAct with activity triggers handler at anchor node
- Ring invariant: successor/predecessor sets match sorted ring order
- Graceful leave: remaining peers route and stabilize after departure
- 10-node scale routing: multiple messages with bounded hop count

**Modified: `packages/fret/test/helpers/libp2p.ts`**
- Added `createMemNode()` using `@libp2p/memory` transport + `plaintext()` encrypter

**Modified: `packages/fret/src/rpc/protocols.ts`**
- `readAllBounded`: Added idle timeout (100ms after first data chunk) to work
  around yamux not propagating remote-close EOF to the dialer's async iterator.

**Modified: `packages/fret/test/churn.leave.spec.ts`**
- Switched from TCP to memory transport with star/full-mesh topology

**Modified: `packages/fret/test/iterative-lookup.spec.ts`**
- Switched to memory transport with star topology

**Modified: `packages/fret/package.json`**
- Added `@libp2p/memory` and `@libp2p/plaintext` as devDependencies

### Review notes

- Code is clean: no unused imports, type-check passes
- `readAllBounded` idle-timeout workaround is well-documented and scoped
- Tests cover neighbor exchange, convergence, routing, ring invariants, leave, and scale
- All 74 tests passing, 0 failures
- "NoValidAddressesError" warnings during leave tests are expected (dialing stopped peers)
- Docs in `docs/fret.md` are current with the implementation
