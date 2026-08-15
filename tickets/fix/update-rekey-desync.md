----
description: When a routing-table entry's ring position changes, the store throws or corrupts its internal index instead of moving the entry cleanly.
files: packages/fret/src/store/digitree-store.ts
difficulty: medium
----
Today the update method has a re-key branch that runs after the underlying tree has already handled the key change. The tree's updateAt call delete+re-inserts the entry when its key changes and bumps the tree version; the store then calls deleteAt on the path it held before that mutation. That path is now stale, so path validation throws. Even if it did not throw, it would delete the entry that was just re-inserted, and the id-to-entry index is never re-mapped to the new position. This is latent — no caller re-keys an entry today — but it is a loaded trap for any future coordinate-change caller.

Expected behavior: changing an entry's coordinate relocates it in the ordered tree, keeps a single live tree entry, and leaves the id-to-entry index pointing at the new location.

References: review store section, major finding "update() re-key branch throws and desyncs byId" (digitree-store.ts:132-135). Fix hint: delete the manual re-key block; rely on updateAt's returned [path, wasUpdate] and refresh the id index when the key changed.
