description: p2p-fret now depends on the same libp2p 3.3 package versions optimystic uses, so the two repos can be developed side by side again; the release itself is left for the maintainer to cut.
files:
  - packages/fret/package.json (dependencies, peerDependencies, devDependencies — version field deliberately untouched)
  - yarn.lock
  - packages/fret/src/rpc/protocols.ts (`openRpcStream`: `streamOpts` typed `DialProtocolOptions`)
  - packages/fret/test/helpers/relay.ts (pin NOTE rewritten)
  - packages/fret/test/ring.properties.spec.ts (fixed-vector hashing test)
  - .release-notes.pending.md (new, repo root)
----
# p2p-fret on the libp2p 3.3 dependency line — review handoff

## Why

Optimystic moved to libp2p 3.3.11. p2p-fret 1.0.0 still declared the 3.1-era ranges (`uint8arraylist` 2, `it-length-prefixed` 10, `multiformats` 13, `@libp2p/interface` 3.1). Because of that, Yarn refused to portal-link a FRET checkout into optimystic (YN0071 range conflicts), two copies of `@libp2p/interface` produced "`PeerId` is not assignable to `PeerId`" errors, and optimystic had to add a type assertion around FRET's exported `readFramed`. This ticket unblocks optimystic's `fret-checkout-cannot-be-linked-on-the-libp2p-3-3-line`.

## What changed

**`packages/fret/package.json`.** Every range in the ticket's table, plus the releases libp2p 3.3.11 itself depends on:

- peer: `libp2p` ^3.3.11, `@libp2p/interface` ^3.3.0, `@libp2p/peer-id` ^6.0.15
- deps: `uint8arraylist` ^3.0.2, `it-length-prefixed` ^11.0.1, `multiformats` ^14.0.5, `@libp2p/utils` ^7.4.1, `@libp2p/logger` ^6.2.13, `@libp2p/peer-record` ^9.0.16, `@multiformats/multiaddr` ^13.0.3 (stays on 13)
- **beyond the ticket's table:** `uint8arrays` ^5.1.0 → ^6.1.1 and `uint8-varint` ^2.0.4 → ^3.0.0. The whole 3.3 stack uses these majors, and leaving FRET on the old ones risks the same YN0071 portal-link conflict the ticket is fixing. FRET uses only `toString`/`fromString` and `decode`, which keep the same API.
- dev: `@libp2p/circuit-relay-v2` ^4.2.13, `@libp2p/identify` ^4.1.14, `@libp2p/crypto` ^5.1.23, `@libp2p/tcp` ^11.0.28, `@libp2p/memory` ^2.0.28, `@libp2p/plaintext` ^3.0.28.
- **The two exact pins became caret ranges.** The circuit-relay pin (4.1.3, from `bug-inbound-rpc-refused-on-relay-connections`) existed only so its `@libp2p/*` dependencies deduped against libp2p 3.1.3. The commit that pinned identify (4.0.10, from `debt-membership-identify-integration-test`) gives no reason, and the same dedupe need is the evident one. The stale NOTE in `test/helpers/relay.ts` is rewritten as a tripwire: if a future libp2p bump leaves two `@libp2p/interface` versions, bump the relay alongside it.

**`yarn.lock`.** Regenerated, then `yarn dedupe '@libp2p/*' '@multiformats/*' '@chainsafe/*'` (run by an earlier, interrupted attempt) collapsed the stale 3.1-era lock entries. `yarn why @libp2p/interface` now shows a single version, 3.3.0, across 18 dependents. The old majors still in the tree (`uint8arraylist` 2.4.8, `uint8arrays` 5.1.0, `multiformats` 13.4.2, `uint8-varint` 2.0.4, `protons-runtime` 5.6.0) arrive only through `@chainsafe/libp2p-noise` 17 and `@chainsafe/libp2p-yamux` 8. Both are dev-only, and the ticket said to expect this.

**`src/rpc/protocols.ts` — the only source change.** `openRpcStream` builds one options object and passes it to both `connection.newStream` and `node.dialProtocol`. Under interface 3.3 the two take different `onProgress` event types, and only `DialProtocolOptions` accepts both, so the object is now typed `DialProtocolOptions` instead of `NewStreamOptions`. Its contents (`runOnLimitedConnection`, `negotiateFully: false`, `signal`) are unchanged, and the doc comment above it was updated to match.

**No other code changes were needed.** The `Uint8ArrayList`, `lp.encode.single` / `lp.decode`, `byteStream` and error-name sites all type-check and pass unchanged. The frame-truncation tests and the tests that assert on error text did not need edits, which means the error names `isFrameTruncationError` relies on survived `it-length-prefixed` 11.

## Validation done

- `yarn check` from the root: typecheck, build, and 1304 passing tests with 0 failing. The run exits cleanly, so the mocha exit watchdog is green (log: `tickets/.logs/libp2p-3-3-dependency-line.check.log`).
- **Exported typing (edge case 1).** The built `dist/src/rpc/protocols.d.ts` imports `Uint8ArrayList` from `uint8arraylist`, which resolves to 3.0.2. `@libp2p/interface` 3.3.0 depends on `uint8arraylist` ^3.0.2, so both sides share one list type. Inside the package, `src/rpc/maybe-act.ts:35` passes libp2p 3.3's `Stream` straight to `readFramed` with no cast, and that compiles.
- **Ring digests are unchanged under `multiformats` 14.** Checked by hand: `sha256.encode`, the call `ring/hash.ts` makes, matches `node:crypto` SHA-256 on several inputs.

## Test added

- `test/ring.properties.spec.ts`: "derives ring coordinates as plain SHA-256, byte-identical across releases". It checks fixed vectors: the NIST `abc` digest through `hashKey`, and a fixed peer id through `hashPeerId`.
  - **What it guards:** that `r(key) = SHA-256(keyBytes)` and `r(peer) = SHA-256(multihash bytes)` (docs/fret.md, *Identifier space and hashing*).
  - **Why it exists:** the ticket assumed such a test already existed. None did. Every other spec computes coordinates through these same functions, so a dependency that changed the digest would pass the whole suite while splitting the ring between FRET versions.
  - **Reviewer's call:** the hash code has no branching, so this test is borderline under the test bar. It is kept because it is the only thing that catches the risk this ticket names.

## Known gaps / for the reviewer

- **The version was not bumped, on purpose — this departs from the ticket's TODO.** `yarn release` runs `bumpp --recursive`. That command chooses the version, writes it to both the root and package `package.json`, commits and tags `v<version>`, and the v1.0.0 release commit touched exactly those two fields. If the version were hand-set to 1.1.0 now, bumpp would offer 1.1.1 / 1.2.0 / 2.0.0 next, and 1.1.0 would never be published. The version is therefore picked at release time.
  - **Recommendation:** **minor (1.1.0)**. The release notes open with a `## Breaking` entry naming the new peer floor, which meets the ticket's condition for a minor. Choose **major (2.0.0)** if you would rather signal the floor change through semver.
- **The maintainer must cut the release.** `yarn release` asks for an interactive preflight confirmation (type `release`), so no agent can run it. `.release-notes.pending.md` at the repo root is ready, and `yarn release` consumes it.
- **Optimystic follow-ups are out of scope here:** restore the `p2p-fret` portal entry, remove the `readFrame` cast in `db-p2p`'s `stream-util.ts`, and bump the `p2p-fret` ranges in `db-p2p` and `substrate-simulator`. All of these wait on the published release.
- **The portal link itself was not tested from optimystic.** The claim that YN0071 is gone rests on the ranges now matching what db-p2p resolves (`it-length-prefixed` ^11.0.1, `uint8arraylist` ^3.0.2). Nobody ran a link from the optimystic checkout.
- **noise 17 and yamux 8 still pull `uint8arraylist` 2.** That is fine for FRET because they are dev-only. A consumer whose own transport stack mixes list majors is unaffected by this change, since both majors mark lists with the same `Symbol.for(...)` at run time.
