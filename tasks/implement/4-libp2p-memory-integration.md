description: libp2p in-memory integration tests using @libp2p/memory transport
dependencies: @libp2p/memory (new devDep), @libp2p/plaintext (new devDep), FRET core service
----

End-to-end integration tests that exercise real FRET protocol flows over libp2p's
in-memory transport — no TCP, no real sockets. These tests validate neighbor
exchange, routing, stabilization convergence, and graceful leave against actual
libp2p stream semantics, filling the gap between the deterministic simulation
(which mocks transports) and the existing TCP-based integration tests.

### Architecture

All tests live in `packages/fret/test/libp2p-memory.integration.spec.ts`.

A shared helper `createMemNode(listenAddr)` wraps `createLibp2p` with:
- `memory()` transport from `@libp2p/memory`
- `plaintext()` connection encrypter from `@libp2p/plaintext` (no crypto overhead)
- `yamux()` stream muxer
- Listen address: `/memory/<unique-name>` per node

A shared `makeMesh(n, opts?)` helper creates n nodes, connects them in a line,
creates a `CoreFretService` per node with configurable `{profile, k, bootstraps}`,
starts all services, and returns `{nodes, services}` for test use. Cleanup via
`afterEach` that stops all services then all nodes.

### Key files

- `packages/fret/test/helpers/libp2p.ts` — add `createMemNode()` alongside existing
  `createMemoryNode()` (TCP-based); consider renaming existing to `createTcpNode()`
  for clarity, but not required
- `packages/fret/test/libp2p-memory.integration.spec.ts` — new test file
- `packages/fret/src/service/fret-service.ts` — SUT (FretService)
- `packages/fret/src/ring/hash.ts` — `hashPeerId` for ring coordinate checks
- `packages/fret/src/ring/distance.ts` — `xorDistance`, `clockwiseDistance` for
  invariant assertions
- `packages/fret/package.json` — add devDependencies

### Test cases

#### 1. Neighbor exchange (3-node)
- Spin up 3 nodes A, B, C connected in a line (A–B–C).
- Wait for 2-3 stabilization ticks (~2s).
- Assert each service's `listPeers()` includes the other two peers.
- Assert `getNeighbors(selfCoord, 'right', m)` and `getNeighbors(selfCoord, 'left', m)` are non-empty for each.

#### 2. Neighbor exchange (10-node)
- Spin up 10 nodes connected in a line.
- Wait for convergence (~4s).
- Assert every node knows at least min(n-1, m) peers.
- Assert S/P sets are non-empty for all nodes.

#### 3. routeAct — message reaches correct anchor
- Spin up 5 nodes, stabilize.
- Pick a random key, compute `hashKey(key)`.
- From a non-anchor node, call `routeAct(msg)`.
- Assert the response is `NearAnchorV1` with non-empty `anchors` and `cohort_hint`.

#### 4. routeAct — activity handler fires at anchor
- Spin up 5 nodes, stabilize.
- Register an `activityHandler` on all nodes that records invocations.
- Send `routeAct` with an `activity` payload from a non-anchor node.
- Assert exactly one node's handler fires and returns a commitCertificate.

#### 5. Stabilization convergence — ring invariant
- Spin up 6 nodes, connect in a line, stabilize for ~4s.
- Compute all nodes' ring coordinates via `hashPeerId`.
- Sort by coordinate (clockwise).
- For each node, assert its successors (via `getNeighbors(coord, 'right', m)`)
  match the expected clockwise neighbors from the sorted ring.
- Similarly for predecessors.

#### 6. Graceful leave — remaining peers update
- Spin up 5 nodes, stabilize.
- Stop service[2] (calls `sendLeaveToNeighbors` internally).
- Wait 1-2s for propagation.
- Assert remaining services' `listPeers()` no longer include the departed node.
- Assert remaining nodes still have correct S/P neighbor counts.

#### 7. Scale test — 10 nodes, full routing
- Spin up 10 nodes, stabilize.
- Issue 5 `routeAct` calls from different source nodes with different keys.
- Assert all return either `NearAnchorV1` or `commitCertificate`.
- Assert average hop count (from breadcrumbs) is bounded by `log2(10) + 2 ≈ 5.3`.

### Ring invariant helper

Utility function `assertRingInvariant(services, nodes)`:
- Compute all ring coordinates.
- Sort clockwise.
- For each node, verify successor/predecessor sets match expected neighbors.
- Call after stabilization in relevant tests.

### Timeouts and CI stability

- Mocha suite timeout: 30s (generous for CI).
- Individual stabilization waits: 2-4s depending on node count.
- Use `afterEach` hooks for cleanup to prevent leaked listeners/connections.

### TODO

- Add `@libp2p/memory` and `@libp2p/plaintext` as devDependencies
- Add `createMemNode()` helper to `test/helpers/libp2p.ts`
- Create `test/libp2p-memory.integration.spec.ts` with all 7 test cases
- Implement `assertRingInvariant` helper (inline or in helpers)
- Run build + full test suite to verify nothing breaks
