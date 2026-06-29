description: An automated test now covers the code that decides whether a connected peer belongs to this network or a co-resident one, using its libp2p "identify" handshake — a path the old in-memory tests could never reach.
prereq:
files:
  - packages/fret/test/membership-identify.spec.ts (new — the integration spec)
  - packages/fret/test/helpers/libp2p.ts (new createIdentifyNode factory: TCP + identify + identifyPush)
  - packages/fret/package.json (added devDependency @libp2p/identify@4.0.10)
  - packages/fret/src/service/fret-service.ts (system under test — peer:identify/peer:update listeners ~339-378; classifyByProtocols ~291; classifyFromPeerStore ~298; seedFromPeerStore ~804)
difficulty: medium
----

# Review: integration test for identify-driven membership classification

## What this covers (plain language)

FRET labels every peer it knows as `member` (serves this network), `foreign` (serves
only some other network sharing the transport), or `unknown` (not yet decided). There are
two ways it figures this out:

1. **Probe** — send a namespaced ping; a reply means `member`, an "unsupported protocol"
   error means `foreign`. Already tested with in-memory nodes in `ring-membership.spec.ts`.
2. **Identify** — libp2p's `identify` handshake tells each peer what protocols the other
   supports. FRET reads that list (on the `peer:identify` / `peer:update` events and in
   `classifyFromPeerStore`) and labels accordingly, including re-admitting a peer
   `foreign → member` when it later starts serving this network.

The in-memory test nodes run no `identify` service, so path #2 had **zero** automated
coverage. This ticket adds it with real TCP nodes that run `identify`.

## What was implemented

- **`createIdentifyNode()`** in `test/helpers/libp2p.ts` — a TCP libp2p node with the
  `identify` and `identifyPush` services enabled (sibling to the existing `createMemNode`,
  which has neither). This is what makes the peerStore protocol list populate and the
  `peer:identify` / `peer:update` events fire.
- **`test/membership-identify.spec.ts`** — two tests covering all three required assertions:
  - **member + foreign in one test**: A (net-a) sees same-network peer C labeled `member`
    and foreign-network peer B (net-b) labeled `foreign`, purely from the identify exchange.
    Self is asserted `member`.
  - **re-admission**: a peer C joins *without* serving net-a (labeled `foreign` from its
    identify protocols), then registers a net-a protocol handler. `identifyPush` propagates
    the change to A as a `peer:update`, which re-admits C to `member`.
- **`@libp2p/identify@4.0.10`** added as a devDependency (see "Dependency note" below).

## How the test isolates the identify path (important for the reviewer)

The ticket asked for classification "via the peerStore/identify path (**no outbound
probe**)". Since the probe path would *also* land the same labels, the test neutralizes the
observer's probe so identify is the only possible cause:

- `disableProbing(svc)` stubs the private `stabilizeOnce` to a no-op. That method is the
  sole home of every probe-based classification (`probeNeighborsLatency`,
  `classifyUnknownPeers`, `reprobeForeignPeers` — the only callers of `applySuccess` /
  `markForeign` off an RPC). `seedFromPeerStore` still runs each tick, but it *is* the
  identify path (reads the identify-populated peerStore) and sends no probe.
- Each test additionally asserts `svcA.getDiagnostics().pingsSent === 0` as a public-API
  witness that no ping probe was sent.

For re-admission specifically, isolation is airtight even beyond the stub:
`seedFromPeerStore`'s opportunistic classify only re-checks `unknown` peers, never
`foreign` ones — so the `peer:update` event is the *only* thing that can flip a `foreign`
peer to `member` once probing is off.

## Validation performed

- `cd packages/fret && npx tsc --noEmit` → clean
- `cd packages/fret && yarn build` → clean
- `cd packages/fret && yarn test` → **256 passing** (includes the 2 new tests)
- new spec alone: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/membership-identify.spec.ts" --timeout 60000` → 2 passing (~2s)

## Honest gaps / things for the reviewer to weigh

- **Private-method reach-in.** `disableProbing` casts to `{ stabilizeOnce }` and overrides
  it. If `stabilizeOnce` is ever renamed, the override silently stops disabling the probe.
  Failure mode is *soft*: the tests would still PASS (probe and identify agree on the
  labels) but quietly lose their "no probe" isolation, and the `pingsSent === 0` assertion
  would then start *failing* and flag it. A reviewer may prefer a real test seam on the
  service instead of the cast — judgment call; I chose not to add production surface area
  for a test-only concern.
- **Which identify entry point fires in test 1 is not pinned.** The member/foreign test
  passes if *either* the `peer:identify` event handler *or* the `seedFromPeerStore` poll
  (`classifyFromPeerStore`) classifies first — both are "the identify path" and both call
  `classifyByProtocols`. Only the re-admission test pins a specific event (`peer:update`).
  If desired, a variant that connects *before* `start()` (so the peerStore is pre-populated
  and the listeners never fire) would isolate the `classifyFromPeerStore` poll path on its
  own. Not added.
- **The `empty protocols → stay unknown` branch of `classifyByProtocols` is not
  integration-tested.** A connected peer always advertises at least its own identify
  protocols, so an identify-populated list is never empty in practice; that branch is only
  reachable with a synthetic empty list. Left to reasoning/unit level.
- **Timing.** The re-admission test depends on the `identifyPush` debounce (~1s in the
  installed version) plus a round-trip; the `waitFor` budget is 10s and it landed in ~2s
  locally. On a heavily loaded CI box it is the most likely of the two to be slow. No
  flakiness observed across runs.

## Dependency note (please sanity-check)

`@libp2p/identify` was pinned to **4.0.10**, not the latest 4.1.8, on purpose:

- 4.1.x depends on `@libp2p/interface@^3.2.4`. The project is on `@libp2p/interface@3.1.0`,
  so 4.1.x installs a *second* copy of `@libp2p/interface` (and, after a `yarn dedupe`,
  cascading second copies of `@multiformats/multiaddr`, `interface-internal`, etc.). Those
  duplicate copies are nominally-distinct types to TypeScript, so the libp2p service
  factories (`identify()`, even `tcp()`/`noise()`) stop type-checking against
  `createLibp2p` — the classic `Uint8Array<ArrayBufferLike>` vs `Uint8Array<ArrayBuffer>`
  duplicate-package error.
- 4.0.10 depends on `@libp2p/interface@^3.1.0` (and its other deps match the project's
  existing ranges), so it dedupes into the single existing `@libp2p/interface@3.1.0` copy.
  Result: `yarn.lock` gained only `@libp2p/identify@4.0.10` and `it-drain` — no transitive
  version churn (verified: 30 insertions, 0 deletions).
- If the project later bumps `@libp2p/interface` to ≥3.2.4 wholesale (and aligns the rest of
  the tree, including the `@multiformats/dns` → interface edge), `@libp2p/identify` can move
  to 4.1.x. Until then, **keep the pin** — a careless `^` here re-breaks the type-check.

## Suggested review focus

- Is stubbing a private method acceptable here, or should a test seam be added to
  `FretService`?
- Confirm the dependency pin rationale and that `yarn.lock` stays minimal.
- Confidence in the re-admission timing under CI load (consider whether the 10s `waitFor`
  budget is generous enough, or trim/raise it).
