description: Move p2p-fret onto the libp2p 3.3 dependency line (uint8arraylist 3, it-length-prefixed 11, multiformats 14, @libp2p/interface ^3.3) and release it, so optimystic can link the FRET checkout again and drop a type assertion.
files:
  - packages/fret/package.json (dependencies, peerDependencies, devDependencies)
  - yarn.lock
  - packages/fret/src/rpc/protocols.ts (`sendFramed`, `readFramed`, `readFramedFromStream`, `isMessageStream` — the `Uint8ArrayList` / `lp.encode.single` / `lp.decode` sites)
  - packages/fret/src/ring/hash.ts (`multiformats/hashes/sha2`)
  - packages/fret/src/service/address-records.ts, packages/fret/src/service/fret-service.ts (import uint8arraylist / multiformats)
  - packages/fret/test/helpers/rpc-fuzz.ts, packages/fret/test/rpc.*.spec.ts and the other specs importing these packages
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-10-05T04:34:50.923Z (agent: claude)
  Log file: C:\projects\Fret\tickets\.logs\libp2p-3-3-dependency-line.implement.2026-10-05T04-34-50-919Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
# Move p2p-fret onto the libp2p 3.3 dependency line

## Why (from optimystic)

Optimystic moved from libp2p 3.1.3 to 3.3.11. libp2p 3.3 types its streams with `uint8arraylist` 3, so
`@optimystic/db-p2p` moved to `uint8arraylist` ^3.0.2 and `it-length-prefixed` ^11.0.1. `p2p-fret` 1.0.0
still declares `uint8arraylist` ^2.4.8, `it-length-prefixed` ^10.0.1, `multiformats` ^13.4.2 and
`@libp2p/interface` ^3.1.0. Consequences on the optimystic side:

- Yarn refuses to portal-link this checkout into db-p2p (`YN0071 … it-length-prefixed@10.0.1 conflicts with
  parent dependency it-length-prefixed@11.0.1`, same for `uint8arraylist`), so FRET and optimystic can no
  longer be developed side by side.
- Even when linked, two installs of `@libp2p/interface` (3.1 here, 3.3 there) produced ~25 "`PeerId` is not
  assignable to `PeerId`" errors.
- FRET's exported `readFramed` is typed over `uint8arraylist` 2 lists; a libp2p 3.3 stream yields v3 lists,
  so optimystic carries a type assertion around it. (They interoperate at run time — both majors brand lists
  with the same `Symbol.for(...)` — only the types disagree.)

Optimystic currently installs `p2p-fret` 1.0.0 from npm; users and CI are unaffected. This ticket unblocks
optimystic ticket `fret-checkout-cannot-be-linked-on-the-libp2p-3-3-line`.

## Target versions (what optimystic's db-p2p resolves)

| package | from | to |
|---|---|---|
| `uint8arraylist` (dep) | ^2.4.8 | ^3.0.2 |
| `it-length-prefixed` (dep) | ^10.0.1 | ^11.0.1 |
| `multiformats` (dep) | ^13.4.2 | ^14.0.5 |
| `@libp2p/interface` (peer + dev) | ^3.1.0 | ^3.3.0 |
| `libp2p` (peer + dev) | ^3.1.3 | ^3.3.11 |
| `@libp2p/peer-id` (peer + dev) | ^6.0.4 | ^6.0.15 |
| `@libp2p/identify` (dev, exact pin 4.0.10) | 4.0.10 | ^4.1.14 — check why it was pinned exactly (git log/blame) before unpinning |
| `@libp2p/circuit-relay-v2` (dev, exact pin 4.1.3) | 4.1.3 | ^4.2.13 — same check |
| `@libp2p/crypto`, `@libp2p/tcp` (dev) | | ^5.1.23, ^11.0.28 |

Also bump `@libp2p/utils`, `@libp2p/logger`, `@libp2p/peer-record`, `@libp2p/memory`, `@libp2p/plaintext` to
the releases built against `@libp2p/interface` 3.3 (whatever libp2p 3.3.11 itself depends on), so the tree
holds ONE `@libp2p/interface` 3.3.x. `@multiformats/multiaddr` stays ^13. `@chainsafe/libp2p-noise` /
`-yamux` still pull `uint8arraylist` 2 transitively; that is expected (dev only) and not this ticket's problem.

Raising the peer floor to libp2p 3.3 is a breaking change for consumers on 3.1/3.2 — release as a **minor at
least, arguably major** (pre-2.0 semver judgment for the maintainer; 1.1.0 is acceptable if the changelog
states the new peer floor).

## Risk / likely code changes

Mechanical in the main. Points to check:

- **uint8arraylist 2 → 3**: v3 is ESM-only and typed for newer TS; the `Uint8ArrayList` class API
  (`subarray`, `consume`, `append`, `byteLength`, `isUint8ArrayList`) is the same. Watch for changed
  method return types under strict mode, and for test helpers constructing lists directly.
- **it-length-prefixed 10 → 11**: `encode.single` / `decode` keep their shape; check option names
  (`maxDataLength`, `maxLengthLength`) and the error classes `readFramed`'s truncation detection relies on
  (`UnexpectedEOFError`, `InvalidDataLengthError`/`InvalidDataLengthLengthError`) — `isFrameTruncation`
  and the error-text assertions in `rpc.stream-errors.spec.ts` / `rpc.protocols.spec.ts` are where a rename
  would show.
- **multiformats 13 → 14**: only `sha256.encode` in `ring/hash.ts`; verify the digest bytes are unchanged
  (the ring coordinate must stay byte-identical — an existing hash test or a fixed-vector assertion covers it).
- **@libp2p/utils `byteStream`** (used in `readFramedFromStream`): confirm its read signature under the 3.3
  line; the stream-path tests exercise it.
- `@libp2p/interface` 3.3 may widen `Stream` / `Connection` types; fix whatever `tsc --noEmit` reports.

## Edge cases & interactions

- Exported surface (`readFramed`, `sendFramed`, `Stream` re-export in `src/index.ts`) must now type against
  v3 lists so a libp2p 3.3 caller needs no cast — verify by inspection of the emitted `.d.ts`.
- Lockfile must contain a single `@libp2p/interface` major-3 version used by the package (check with
  `yarn why @libp2p/interface`).
- The mocha exit watchdog must stay green — newer libp2p releases occasionally change timer/handle teardown.

## Acceptance

- `yarn check` (typecheck + build + test) passes from the root.
- `packages/fret/package.json` declares the versions above; `yarn.lock` regenerated.
- Release-ready: version bumped and a `.release-notes.pending.md` noting the new peer floor. `yarn release`
  needs an interactive preflight confirmation, so the maintainer cuts the release itself; the review/complete
  handoff should say so explicitly.

## Optimystic follow-ups (context only — done in the optimystic repo, NOT here)

- Restore the `p2p-fret` portal entry in optimystic's root `package.json` resolutions (`yarn dev:link`).
- Remove the type assertion in `readFrame` in `packages/db-p2p/src/cohort-topic/stream-util.ts`.
- Bump the `p2p-fret` range in `packages/db-p2p/package.json` and `packages/substrate-simulator/package.json`.

## TODO

- [ ] Bump the dependency ranges in `packages/fret/package.json`; resolve the two exact dev pins.
- [ ] `yarn install`; confirm a single `@libp2p/interface` 3.3.x via `yarn why`.
- [ ] `npx tsc --noEmit` from `packages/fret/`; fix type fallout in `rpc/protocols.ts` and tests.
- [ ] Confirm `ring/hash.ts` digests unchanged under multiformats 14.
- [ ] `yarn check` green.
- [ ] Bump version, write `.release-notes.pending.md` (new peer floor: libp2p ^3.3.11 / @libp2p/interface ^3.3.0).
