----
description: On small networks the cohort assembly can return fewer members than requested even when enough distinct members exist.
files: packages/fret/src/service/cohort.ts
difficulty: easy
----
When the network size is close to the requested cohort size, the clockwise and counterclockwise walks return overlapping ids. The alternating merge only checks the caller's exclude set, not what it has already collected this pass, so the output length reaches the requested count while still counting cross-list duplicates. A final dedup then shrinks the cohort below the requested size, even though the ring holds enough distinct members to satisfy it.

Expected behavior: cohort assembly collects distinct members up to the requested count, drawing further from both walks when duplicates appear, and returns the full count whenever that many distinct members exist.

References: review store section, minor finding "Cohort under-fills when n ≈ wants" (service/cohort.ts:30-42). Fix hint: track a seen set inside the loop and skip already-collected ids while counting toward the target.
