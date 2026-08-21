----
description: A batch of mechanical cleanups in the store and ring code to remove duplication, dead code, and misleading constructs.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/store/relevance.ts
difficulty: easy
----
The store and ring modules carry several small cleanups worth doing together:

- Four near-identical wrap walks exist in the store; extract one directional walker and reuse it.
  There are now **five**: the resumable paged walk added for peer discovery (`walkFrom`) is a
  sixth-line-for-sixth-line copy of the same forward wrap-and-skip loop as the successor and
  clockwise-neighbours walks, differing only in where it starts and whether it collects entries
  or ids. Worth stating why this one matters beyond tidiness: the shared shape carries a
  bounded-scan guard (stop after one full lap) that is the only thing stopping a filtered walk
  from spinning forever on the wrap-around when nothing matches. Every copy is a place a future
  walk can be written without that guard. Extracting the directional walker makes an unbounded
  filtered ring walk unwritable in the store, rather than a convention each new method has to
  remember.
- The store re-implements a coordinate-to-hex helper that already lives in the ring hash module; use the exported one.
- The lexicographic-less comparison pads left-aligned while the xor and clockwise helpers pad right-aligned; pick one padding convention.
- A metadata field typed as a record of any should be a record of unknown.
- A helper named as if it adds counters is actually a bare spread; rename or inline it.
- A dead guard clamping a constant to a minimum of one serves no purpose; remove it.
- A mirrored-index xor loop is an obfuscated forward loop; write it plainly.
- In the relevance module, the touch path computes base relevance using the pre-increment access count, unlike the record-success and record-failure paths; fold the incremented access count in so all three agree.

Out of scope: the dead ring-distance exports (clockwise-distance and min-distance) are handled by the separate consolidate-ring-distance ticket; do not touch them here.

<!-- resume-note -->
Prior run hit BUDGET_WARNING partway through research (no log file — cut short before any
edits). Fully read `digitree-store.ts` and `relevance.ts` (both in full); did not yet read
`ring/hash.ts` or `ring/distance.ts`, and did not grep the rest of the tree. No code changed yet.
Findings, so the next run doesn't re-derive them:

- **Item "bare-spread counters helper" — located and resolved.** `relevance.ts:101-103`:
  `function withCounters(entry, patch) { return { ...entry, ...patch }; }` — literally just a
  spread, used 3x (`touch`, `recordSuccess`, `recordFailure`). Fix: inline `{ ...entry, ...patch }`
  at each call site and delete `withCounters`; a 1-line misleadingly-named wrapper is worse than
  inlining, and 3 call sites isn't enough reuse to justify a name.
- **Item "relevance touch path access-count basis" — located and resolved.** `relevance.ts`
  `touch()` (~105-115) computes `const base = baseRelevance(entry, now);` off the *pre-increment*
  entry, then increments `accessCount` only in the returned patch. Compare `recordSuccess`
  (~157-169) and `recordFailure` (~171-182): both build a locally-modified entry with the counter
  *already incremented* (`{ ...entry, successCount: entry.successCount + 1 }` /
  `{ ...entry, failureCount: entry.failureCount + 1 }`) before calling `baseRelevance`, so the
  sparsity/health/frequency blend sees the post-increment state. Fix: change `touch`'s base-calc
  line to `const base = baseRelevance({ ...entry, accessCount: entry.accessCount + 1 }, now);` —
  matches the other two paths' pattern exactly.
- **Item "extract shared directional walker" — design already sketched in-file, not yet built.**
  `digitree-store.ts:425-460` carries a NOTE block (left by an earlier pass) describing exactly
  this extraction and why it wasn't done inline. Five walk methods exist today, all seeking via
  `ceilPath`/`floorPath` then walking `next`/`prior` with a `maxScan` bounded-scan guard when a
  filter is given:
  - `successorOfCoord` / `predecessorOfCoord` (~385-423): find first match, single result.
  - `neighborsRight` / `neighborsLeft` (~462-506): collect into a `Set` up to `count`, with an
    early-exit-on-repeat-id (proof of having lapped the ring — see the class's own invariant that
    there's exactly one tree entry per id).
  - `walkFrom` (~524-548): paged/resumable, returns `PeerEntry[]` (not ids) plus a resume cursor,
    starts *strictly after* a given cursor rather than at the seek point.
  Recommended shape: one private generator/iterator over one direction (`next` or `prior`) from a
  start path, wrapping past the end, bounded at `size()` entries when filtered (unbounded when not
  — preserves today's byte-for-byte behavior on the unfiltered path), yielding matching entries in
  order. Each of the 5 public methods becomes a thin consumer: take-first, collect-into-Set-until-
  count-or-repeat, or take-until-count-with-cursor-tracking. The guard (bounded scan) and the wrap
  logic live in exactly one place; a future 6th walk built by copying a public method's *consumer*
  logic (not the seek/wrap loop) can't reintroduce an unguarded spin. Keep the `neighborsRight`/
  `neighborsLeft` early-exit-on-repeat behavior and the `walkFrom` strictly-after/paging behavior
  as documented in their existing docblocks — those are behavior, not incidental to the loop shape.
- **Items NOT yet located — need grep, not yet done:**
  - "store re-implements a coordinate-to-hex helper that already lives in ring hash module" —
    `digitree-store.ts` already imports and uses `coordToHex` from `../ring/hash.js` (used in
    `ceilPath`, `floorPath`, `makeKey`), so the duplicate isn't in this file as read. Check
    `ring/hash.ts` itself and any other store-adjacent file for a second hex-conversion
    implementation.
  - "lexicographic-less comparison pads left vs xor/clockwise pad right" — not in
    `digitree-store.ts` or `relevance.ts`. Likely `ring/distance.ts` (padding shows up around a
    hex/byte comparison for the peer-id tie-break). Read `ring/distance.ts` and `ring/hash.ts`.
  - "metadata field typed Record<string, any> should be Record<string, unknown>" — NOT in
    `digitree-store.ts`: `PeerEntry.metadata` and `SerializedPeerEntry.metadata` are already
    `Record<string, unknown>`. Grep the tree (likely `service/fret-service.ts`) for
    `Record<string, any>`.
  - "dead guard clamping a constant to a minimum of one" — not found in either file read so far.
    Grep for `Math.max(1,` across `src/`.
  - "mirrored-index xor loop that's an obfuscated forward loop" — not found in either file read.
    Not `ring/distance.ts`'s dead `clockwiseDistance`/`minDistance` exports (explicitly out of
    scope per this ticket) — check `relevance.ts`'s sparsity/KDE code and
    `selector/next-hop.ts`/`estimate/size-estimator.ts` for an xor-indexed loop that's really just
    counting forward.

Next run: finish locating the 5 ungrepped items above (quick greps), confirm each against its
cited file/line in this ticket's `References:` line, then this ticket is ready to resolve into an
`implement/` ticket per the Plan-stage rules (design fully resolved — no open questions once the
5 locations are confirmed and the walker's consumer-shape is settled per the sketch above).
<!-- /resume-note -->


Expected behavior: identical behavior with less duplication and no dead or misleading code; the relevance touch path uses the same access-count basis as the other record paths.

References: review store section, cleanup finding "Mechanical cleanups" (digitree-store.ts:208-294) and minor finding on relevance (relevance.ts:103-113).
