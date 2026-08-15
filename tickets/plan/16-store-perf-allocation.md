----
description: The routing store rebuilds throwaway data on every lookup and ring walk, wasting work on a hot path.
files: packages/fret/src/store/digitree-store.ts
difficulty: medium
----
Two hot paths churn allocations. The key builder constructs a fresh sixty-four-character hex string on every binary-search probe — roughly a dozen to twenty per lookup — even though entries are frozen and their key is therefore stable and could be cached on the entry or in a side table. The wrap-around walks push potential duplicates into an array and then deduplicate with a set built afterward; a repeat insertion into a set encountered mid-walk would itself prove the ring has fully wrapped and permit an early exit. These walks run many times per stabilization tick.

Expected behavior: a lookup reuses a cached key for each entry instead of rebuilding it, and a wrap walk collects into a set with early exit on the first repeat rather than post-hoc deduplication.

References: review store section, minor perf finding "Hot-path allocation churn" (digitree-store.ts:64-73, 253-293). Fix hint: cache the per-entry key (on the frozen entry or a WeakMap); collect wrap walks into a set and exit early on a repeat.
