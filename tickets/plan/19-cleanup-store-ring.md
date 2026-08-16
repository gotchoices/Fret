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

Expected behavior: identical behavior with less duplication and no dead or misleading code; the relevance touch path uses the same access-count basis as the other record paths.

References: review store section, cleanup finding "Mechanical cleanups" (digitree-store.ts:208-294) and minor finding on relevance (relevance.ts:103-113).
