----
description: Restoring a saved routing table can create hidden duplicate peers that are visible to routing but impossible to look up or remove.
files: packages/fret/src/store/digitree-store.ts
difficulty: medium
----
The raw insert path ignores the conflict signal the underlying tree returns on a duplicate key, and the import routine inserts entries directly rather than going through the upsert logic. Because imported coordinates come from a file or the wire and are never re-derived, importing an id at a coordinate different from its existing entry creates a second tree entry for the same id. That second entry is unreachable through the id index and cannot be evicted, yet it appears in every ring walk. It also skews the filtered-walk scan cap, which trusts the id-index size as the entry count while the tree actually holds more. Same-coordinate duplicates instead silently over-report the restored-entry count.

Expected behavior: importing entries never produces two tree entries for one id; a re-imported id updates its existing entry (including a coordinate move), and the reported restored count matches what was actually stored.

References: review store section, major finding "insert() ignores conflicts; importEntries can orphan tree entries" (digitree-store.ts:77-81, 312-335). Fix hint: route import through the upsert logic and check the path the insert call returns.
