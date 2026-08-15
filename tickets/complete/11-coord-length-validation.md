description: Ring coordinates are now checked for correct size before they can enter the routing table — at the point they are decoded from the network or a saved file, and again at the table's own write point — closing a gap where a malformed coordinate silently scrambled peer ordering.
files: packages/fret/src/ring/hash.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/ring.properties.spec.ts, packages/fret/test/digitree.persistence.spec.ts, docs/fret.md
----
## What shipped

Decode-boundary validation in `packages/fret/src/ring/hash.ts`:

- `base64urlToCoord(s)` throws unless the decoded byte length is `COORD_BYTES` (32).
- `hexToCoord(hex)` validates against `^[0-9a-fA-F]{64}$` before parsing. Previously `parseInt` on a non-hex pair returned `NaN`, which coerces to `0` when assigned into a `Uint8Array`, so garbage silently became a plausible near-zero coordinate.

Consumer fix in `packages/fret/src/service/fret-service.ts`: both snapshot sample-merge sites (`mergeAnnounceSnapshot`, `mergeNeighborSnapshots`) were decoding with the raw `u8FromString(s.coord, 'base64url')`, bypassing the helper; both now call `base64urlToCoord`. Each is already inside a per-entry `try/catch` that logs and skips, so one malformed sample entry is dropped rather than the whole merge.

Added during review (see findings):

- **Store-level width invariant.** `DigitreeStore`'s single private write seam (`put`) now rejects any coordinate that is not exactly `COORD_BYTES` wide. The tree key is `hex(coord)|id`, so a wrong-width coordinate produces a wrong-length key that sorts into an arbitrary ring position and silently corrupts every ordered read. One check at the seam kills the whole class regardless of which decode path produced the bytes; the per-decoder checks stay as the boundary rejection.
- **`importEntries` is now all-or-nothing.** It decodes every record's coordinate before writing any of them.
- **DRY**: the store's private `coordToHex` duplicate was deleted in favour of the `ring/hash.js` export it already imports from.

Explicitly out of scope (per the originating ticket): re-hashing a provided coordinate against its peer id to verify authenticity — the separate planned security work under "Not yet implemented — Message authentication" in `docs/fret.md`.

## Review findings

**Checked**: the full implement diff read before the handoff summary; every `u8FromString` / `base64urlToCoord` / `hexToCoord` call site in `src/` and `test/`; the store's write seam and tree-key derivation; the `importTable` → `importEntries` persistence path; `docs/fret.md`'s Digitree and Routing-table-persistence sections; whether any existing test or the simulation harness writes a non-32-byte coordinate (none do — all coord helpers are 32-wide).

**Major — architecture, fixed in this pass rather than filed.** The implement handoff flagged the `importTable` behavior change and left it. Two problems sat behind it, and both resolve at one site each:

- *Partial import on a malformed record.* `importEntries` decoded inside its write loop, so a corrupt record threw mid-loop: records before it were already in the tree, the caller's `enforceCapacity()` never ran, and `importTable` returned nothing while having mutated the store. Fixed by decoding all coordinates first. Fail-loud on a corrupt persisted file is kept — that is the right default for a restore path — but it is now clean.
- *The class, not the instance.* Validating at each decoder leaves the next decode path (a future protobuf/CBOR reader, a direct `upsert` caller) free to reintroduce exactly this bug. The bad state is now unrepresentable in the store: the seam rejects it. This is the boundary-invariant rung, so no point ticket was filed for the instance.

**Minor — fixed inline**: the duplicated `coordToHex` in the store.

**No tickets filed.** Both findings resolved here; neither leaves residual work.

**No tripwires recorded.** Nothing found that is fine now and only bites later — the two findings were live defects on the persistence path, not conditional ones.

**Accepted tradeoffs**: none found at any touched site (no `NOTE:` markers), so nothing was re-litigated or skipped on that basis.

**Docs**: `docs/fret.md` was out of date on both counts and is updated — the Digitree bullet list (A2) gains the coordinate-width invariant and why the tree key makes it load-bearing; the Routing-table-persistence section gains the all-or-nothing import rule and contrasts it with the skip-and-log behavior of the wire-snapshot merge loops.

**Tests**: the implementer's three cases in `test/ring.properties.spec.ts` cover the decoders' happy/edge paths adequately. Added to `test/digitree.persistence.spec.ts`:
- `rejects a wrong-width coordinate at the write seam` — 31- and 33-byte coords throw and leave the store empty.
- `a malformed coordinate rejects the whole snapshot without importing part of it` — a good record ordered ahead of a bad one is *not* left behind.

## Verification
- `npx tsc --noEmit` — clean.
- `yarn test` — 383 passing, 0 failing (full suite, from `packages/fret/`).
- No lint step exists in this repo; `yarn check` (typecheck + build + test) is the gate, and `yarn format:check` is known-failing repo-wide for the reason recorded in `AGENTS.md`.
