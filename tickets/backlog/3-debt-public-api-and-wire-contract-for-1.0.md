description: Publishing 1.0 is a promise not to break things, but nobody has written down which parts of this library the promise covers — the exported helpers, the diagnostics, or the message formats other nodes speak. Decide and state it before the version number makes the decision by default.
files:
  - packages/fret/src/index.ts (the whole exported surface — ~39 exports across five groups)
  - packages/fret/test/package-exports.spec.ts (pins that the surface is reachable, not what it promises)
  - packages/fret/src/service/fret-service.ts (`getDiagnostics` — reachable, deliberately not on the `FretService` interface)
  - packages/fret/src/service/libp2p-fret-service.ts (the facade, tied to `FretService` structurally)
  - packages/fret/src/rpc/validate.ts (the `v` field is accepted unchecked on every message — the de-facto version policy)
  - README.md, docs/fret.md (*Wire formats*)
difficulty: medium
tradeoffs: This produces a document and possibly a few `@public` / `@internal` markers rather than working code, and a maintainer under release pressure will be tempted to ship 1.0 and sort it out when someone complains. The counter-argument is that the cost is entirely front-loaded: once 1.0 is published, every export is presumed stable whether or not that was intended, and narrowing the surface afterwards is itself the breaking change.
----

# What does 1.0 actually promise?

Version 1.0.0 says "this is stable" to a consumer resolving from npm. Right now the library has
not said what "this" refers to. Three separate surfaces are in question and they do not have to get
the same answer.

## Surface 1 — the exported module API

`src/index.ts` exports around 39 names in five loose groups:

1. **Core service and config** — `createFret`, `FretService`, `FretConfig`, `Libp2pFretService`,
   `fretService`, `FretPeerDiscovery`, the wire-message interfaces.
2. **Ring primitives** — `hashKey`, `hashPeerId`, `minDistance`, `clockwiseDistance`, `lexLess`.
3. **Internals exposed for reuse** — `DigitreeStore` and its entry types, `assembleCohort`,
   `estimateSizeAndConfidence`, `shouldIncludePayload`, `computeNearRadius`, `DedupCache`.
4. **The RPC seam** — `openRpcStream` / `releaseRpcStream`, `sendFramed` / `readFramed`,
   `rpcRequest`, `registerRpcHandler` / `registerJsonHandler`, `RpcOutcome`.
5. **Wire-shape parsers** — the `parse*` family, `Parser`, `SnapshotCaps`.

Groups 1 and 4 have clear reasons to be public and are documented as such — group 4 exists
precisely because a downstream consumer hand-copied the connection selection and the copies drifted
(one omitted `runOnLimitedConnection`, so a relay-only peer silently never answered). Group 3 is
less obvious: `DigitreeStore` is FRET's internal routing table, exported so the design simulator and
the standalone helpers can reach it. That is a good reason to *export* it and a poor reason to
*freeze* it — its write seam and index invariants are still being tuned, most recently to change
`byId` from holding a tree key to holding the entry object.

The question to settle: which of these five groups is covered by the semver promise, and which is
exported-but-unstable? `package-exports.spec.ts` already asserts the surface is reachable; it says
nothing about what is promised. A `@public` / `@internal` marker per group, plus a short README
paragraph, is probably the whole job.

## Surface 2 — diagnostics

`getDiagnostics()` is reachable on the concrete class and on the libp2p facade, but is deliberately
**not** on the public `FretService` interface — the facade types its return as
`ReturnType<CoreFretService['getDiagnostics']>` precisely because there is no interface member to
tie it to. So the shape is public in practice and private by declaration.

That is a fine state to be in, but it should be a decision rather than an accident, because
`11-feat-diagnostics-counters` will add fields to it. Either it is supported API and adding or
renaming counters is a versioned change, or it is explicitly a debugging aid whose shape may move
at any time — and that sentence belongs next to the method.

There is already a `NOTE:` at the method recording a related tripwire (it returns the live object
rather than a copy, so a caller diffing an uncopied handle would silently compare a thing to
itself). Whatever is decided here should sit beside it.

## Surface 3 — the wire protocol

This is the surface a version number cannot protect, because the other end of the connection is a
different build. Two things are already true and should be *stated* rather than left to be
rediscovered:

- The protocol id is namespaced per network *and* carries a version:
  `/optimystic/${networkName}/fret/1.0.0/{...}`. Two nodes with different network names cannot
  negotiate at all — that is the isolation mechanism, and it is load-bearing for the membership
  labelling.
- Every message carries `v: 1`, and **every parser deliberately ignores it**. `docs/fret.md`
  records the reasoning: nothing negotiates versions today, and a hard reject on an unexpected `v`
  would make a future v2 rollout fail closed at exactly the peers that have not upgraded yet.

That is a coherent policy — *ignore the version, evolve additively, let unknown fields pass* — but
it is currently a comment in a design document rather than a stated compatibility rule, and it has
a real consequence a consumer needs to know: **new wire fields must be optional and additive, and a
breaking change means a new protocol id, not a new `v`.** Several queued tickets add fields to
existing messages (address hints, signed size observations, signatures), so this rule is about to
be exercised repeatedly.

Worth confirming while here: the `sig` field already reserved on `NeighborSnapshotV1` is carried
through untouched rather than dropped, so a future signing rollout finds it already arriving. That
is the additive pattern working as intended, and it is the model the other three should follow.

## Not in scope

Deciding *whether* to implement message signing before 1.0 is a separate call (see the post-1.0
band). This ticket only needs to state what the current, unsigned protocol promises.

## TODO

- [ ] Classify each export group as supported API vs exported-but-unstable; mark them at the source
- [ ] Decide whether `getDiagnostics` is supported API, and record it at the method beside the
      existing `NOTE:`
- [ ] Write the wire compatibility rule down where a consumer will find it: `v` is ignored, new
      fields are optional and additive, a breaking change takes a new protocol id
- [ ] Short README section pointing at all three answers
- [ ] Check `package-exports.spec.ts` still matches whatever the surface ends up being
