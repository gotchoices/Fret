description: p2p-fret now depends on the same libp2p 3.3 package versions optimystic uses, so the two repos can be developed side by side again; the release itself is left for the maintainer to cut.
files:
  - packages/fret/package.json (dependencies, peerDependencies, devDependencies; version field deliberately untouched)
  - yarn.lock
  - packages/fret/src/rpc/protocols.ts (`openRpcStream`: `streamOpts` typed `DialProtocolOptions`)
  - packages/fret/test/helpers/relay.ts (pin NOTE rewritten)
  - packages/fret/test/ring.properties.spec.ts (fixed-vector hashing test)
  - .release-notes.pending.md (repo root)
  - .gitignore
----
# p2p-fret on the libp2p 3.3 dependency line

## Why

Optimystic moved to libp2p 3.3.11. p2p-fret 1.0.0 still declared the 3.1-era ranges (`uint8arraylist` 2, `it-length-prefixed` 10, `multiformats` 13, `@libp2p/interface` 3.1). Because of that, Yarn refused to portal-link a FRET checkout into optimystic (YN0071 range conflicts). Two copies of `@libp2p/interface` caused "`PeerId` is not assignable to `PeerId`" errors, and optimystic needed a type assertion around FRET's exported `readFramed`. This work unblocks optimystic's `fret-checkout-cannot-be-linked-on-the-libp2p-3-3-line`.

## What landed

- **`packages/fret/package.json`:**
  - Peer dependencies: `libp2p` ^3.3.11, `@libp2p/interface` ^3.3.0, `@libp2p/peer-id` ^6.0.15.
  - Runtime dependencies: `uint8arraylist` ^3.0.2, `it-length-prefixed` ^11.0.1, `multiformats` ^14.0.5, `uint8arrays` ^6.1.1, `uint8-varint` ^3.0.0, `@libp2p/utils` ^7.4.1, `@libp2p/logger` ^6.2.13, `@libp2p/peer-record` ^9.0.16. `@multiformats/multiaddr` stays on 13. `main-event` ^1.0.1 was added during review (see findings).
  - Dev dependencies moved to match.
  - The two exact pins (circuit-relay-v2 4.1.3, identify 4.0.10) are now caret ranges. Both existed only so their dependencies deduped against libp2p 3.1.3.
- **`yarn.lock`:** regenerated and deduped. `yarn why @libp2p/interface` shows a single 3.3.0. The older majors still in the tree come only through the dev-only `@chainsafe/libp2p-noise` 17 and `@chainsafe/libp2p-yamux` 8.
- **`src/rpc/protocols.ts`:** the only source change. `openRpcStream` passes one options object to both `newStream` and `dialProtocol`, so the object is now typed `DialProtocolOptions`. Under interface 3.3, only that type's `onProgress` accepts both opens' progress events.
- **Version not bumped, on purpose.** `yarn release` (bumpp) picks the version, commits it and tags it. A hand-set version would get skipped at release time. **The maintainer cuts the release.** The recommendation is minor (1.1.0), since the notes open with a `## Breaking` entry for the new peer floor. Choose major (2.0.0) to signal the floor change through semver instead. `.release-notes.pending.md` is ready.
- **Optimystic follow-ups, out of scope here:** restore the `p2p-fret` portal entry, drop the `readFrame` cast in db-p2p's `stream-util.ts`, and bump the `p2p-fret` ranges in db-p2p and substrate-simulator. All of these wait on the published release.

## Review findings

Reviewed the three `ticket(implement): libp2p-3-3-dependency-line` commits: the salvaged partial, the final one, and the original ticket.

- **Correctness of the one source change. Checked, no defect.** `DialProtocolOptions extends NewStreamOptions` in interface 3.3, so `connection.newStream` still accepts the object. Typing the object `NewStreamOptions` instead reproduces the TS2345 `onProgress` error at the `dialProtocol` call. That confirms the new comment's claim is accurate, not just plausible. The object's contents are unchanged.
- **Dependency hygiene. One minor defect, fixed.** `src/service/peer-discovery.ts` imports `TypedEventEmitter` from `main-event` at run time, but `main-event` was never declared. It resolved only because libp2p hoists it, so a strict package manager (pnpm, Yarn PnP, or a hoisting boundary) would fail at import. This predates the ticket (it has been there since the peer-discovery module landed), but it is exactly the class of problem this ticket exists to fix. Declared `main-event` ^1.0.1, the version the whole 3.3 stack resolves. The lockfile and release notes are updated. Every other external `src/` import is declared. Checked by listing the bare-specifier imports under `src/` against `dependencies` and `peerDependencies`.
- **Dedupe. Checked, no defect.** `yarn why` shows a single `@libp2p/interface` (3.3.0), a single `@libp2p/crypto` (5.1.23) and a single `main-event` (1.0.1). `multiformats` 14.0.5 is used by every `@libp2p/*` package. `uint8arraylist` 2 comes only via noise and yamux, which are dev-only, as the ticket expected.
- **Ring-hash stability, and the added test.** Recomputed the peer-id vector independently: node:crypto SHA-256 over `peerIdFromString(...).toMultihash().bytes` matches `ed44b6e0…e281`. The `abc` vector is the published NIST one. The test is kept. The hash code has no branching, but the test pins a named part of the spec (docs/fret.md, *Identifier space and hashing*), and nothing else would see a digest drift that splits the ring between FRET versions.
- **Docs. Checked, nothing stale.** `docs/fret.md` and the `protocols.ts` / test comments still say "the dialer's `NewStreamOptions`". That stays accurate: `runOnLimitedConnection` is a `NewStreamOptions` field, and `DialProtocolOptions` extends it. No doc names the old version numbers or pins. The rewritten tripwire `NOTE:` in `test/helpers/relay.ts` is accurate. `tickets/.garden-report.md` still describes the old exact pin, but it is a dated garden snapshot, not living documentation, so it was left alone.
- **Release-notes file is tracked. Considered and left alone.** The runner commits `.release-notes.pending.md` even though AGENTS.md describes it as untracked, and `gh-release` deletes it, which leaves a tracked deletion behind. History shows this is the established cycle here (added by 3065149 and 62fe1f3, deleted by later commits), so it is not a defect of this ticket. If it should change, gitignore the file the way `../quereus` does; that is the maintainer's call.
- **`.gitignore`. Minor unrelated defect, fixed.** Commit 889207d appended `tickets/.in-progress` onto a file with no trailing newline, which fused two lines into `packages/fret/test/simulation/output/tickets/.in-progress`. As a result the simulation output directory was not ignored. Split it back into two lines and confirmed both patterns match with `git check-ignore -v`.
- **Error paths and regressions.** The `it-length-prefixed` 11 error names that `isFrameTruncationError` depends on are covered by the stream-error and protocol specs, which pass unchanged. The mocha exit watchdog is green. No new tests were added for these paths, because the existing specs already exercise them.
- **Tests and build.** `yarn check` (typecheck + build + full test suite) was run from the root after the review edits. The log is `tickets/.logs/libp2p-3-3-dependency-line.review.log`, and the result is under *Validation* below.
- **Not verified, carried forward:** nobody has run the portal link from the optimystic checkout. The claim that YN0071 is gone rests on the ranges now matching what db-p2p resolves.
- **Tripwires:** none new. The relay-pin `NOTE:` in `test/helpers/relay.ts` already covers the one conditional concern, a future libp2p bump that leaves two interface versions.

## Validation

`yarn check` from the root, run after the review edits: typecheck and build are clean, and the test run shows **1304 passing, 0 failing** (about 11 minutes). The command exited 0, so the mocha exit watchdog is green.
