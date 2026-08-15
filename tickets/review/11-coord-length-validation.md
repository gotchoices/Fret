description: Ring coordinates decoded from the wire are now checked for correct length and hex charset before entering the routing table, closing a gap that could silently scramble the peer ordering.
files: packages/fret/src/ring/hash.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/ring.properties.spec.ts
difficulty: easy
----
Decode-boundary validation added to `packages/fret/src/ring/hash.ts`:

- `base64urlToCoord(s)` now throws if the decoded byte length is not `COORD_BYTES` (32), instead of silently returning a wrong-length `Uint8Array`.
- `hexToCoord(hex)` now validates the input against `^[0-9a-fA-F]{64}$` before parsing, and throws on any mismatch — wrong length or non-hex charset. Previously `parseInt` on a non-hex pair returned `NaN`, which coerces to `0` when assigned into the `Uint8Array`, so garbage input silently became a valid-looking zero-ish coordinate.

Consumer fix in `packages/fret/src/service/fret-service.ts`: the two sample-entry merge sites (`mergeAnnounceSnapshot` ~line 1206, `mergeNeighborSnapshots` ~line 1506) were decoding snapshot-carried coordinates with the raw `u8FromString(s.coord, 'base64url')` — bypassing the hash.ts helper and its new length check entirely. Both now call `base64urlToCoord(s.coord)`. Both call sites were already wrapped in a per-entry `try/catch` that logs and skips (`mergeAnnounceSnapshot sample upsert failed for %s`, `mergeNeighborSnapshots sample upsert failed for %s`), so a throw here degrades gracefully — one malformed sample entry is dropped, not the whole snapshot merge.

`packages/fret/src/store/digitree-store.ts:362` (`importEntries`, used by `importTable` persistence restore) already called `base64urlToCoord` and gets the new validation for free — not modified, not in the ticket's scope. Note for the reviewer: `importTable` → `importEntries` has no per-entry try/catch, so a corrupted persisted-table entry now aborts the whole `importTable` call instead of being silently admitted with a wrong-length coord. This is a behavior change but arguably a stricter/safer default for a persistence-restore path (fail loud on a corrupted file over silently admitting corrupt ring state); not fixed here since out of ticket scope (files: hash.ts only) and no existing test exercises malformed persisted entries.

Explicitly out of scope (per originating ticket): re-hashing provided coordinates against the peer id to verify authenticity — that's the separate planned security work referenced in `docs/fret.md` under "Not yet implemented — Message authentication: Verify ring coordinates in sample entries (re-hash rather than trust provided coords)".

## Tests added
`packages/fret/test/ring.properties.spec.ts` — three new cases under "coordinate encoding round-trips":
- `base64urlToCoord throws on wrong-length input` (empty, one-short, one-long)
- `hexToCoord throws on wrong-length input` (empty, one-short, one-long)
- `hexToCoord throws on non-hex charset instead of coercing to zero bytes`

## Verification
- `npx tsc --noEmit` — clean
- `yarn build` — clean
- `yarn test` — 381 passing (full suite, including new cases and the simulation/estimator suites)

## Review findings
(none filed — implement stage only; reviewer to fill in)
