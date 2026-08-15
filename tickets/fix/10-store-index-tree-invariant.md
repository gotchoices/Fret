----
description: The routing table keeps two views of the same data — an ordered ring and a lookup index — and two of its write paths can leave them disagreeing, producing peers that show up in routing but cannot be found or removed, or a crash when a peer's ring position changes.
files: packages/fret/src/store/digitree-store.ts
difficulty: medium
repro: static — inferred from code review of the two write paths; confirm with the property test described below (it fails today on the import path).
----
`DigitreeStore` maintains two structures over the same entries: the ordered B+Tree keyed by ring coordinate (what every ring walk reads) and the `byId` index from peer id to entry (what every lookup, eviction, and count reads). Correctness of essentially everything above the store rests on one unstated invariant:

> **Exactly one tree entry exists per peer id, and `byId` points at it.**

Nothing enforces that today. Two write paths break it in different ways, which is why this is one ticket with two arms rather than two point fixes: the fix is to make the invariant hold by construction — route every mutation through a single internal helper that owns both structures — and then prove it with a property test that no future write path can quietly bypass.

## Arm 1 — `insert()` ignores conflicts, so `importEntries` can orphan tree entries

The raw insert path ignores the conflict signal the underlying tree returns on a duplicate key, and the import routine inserts entries directly rather than going through the upsert logic (`digitree-store.ts:77-81`, `:312-335`). Imported coordinates come from a file or the wire and are never re-derived, so importing an id at a coordinate different from its existing entry creates a **second** tree entry for the same id. That second entry is unreachable through `byId`, cannot be evicted, and yet appears in every ring walk. It also skews the filtered-walk scan cap, which trusts the `byId` size as the entry count while the tree actually holds more. Same-coordinate duplicates instead silently over-report the restored-entry count.

Expected: importing entries never produces two tree entries for one id; a re-imported id updates its existing entry (including a coordinate move); the reported restored count matches what was actually stored.

## Arm 2 — `update()`'s re-key branch throws and desyncs `byId`

The update method has a re-key branch that runs *after* the underlying tree has already handled the key change (`digitree-store.ts:132-135`). The tree's `updateAt` delete+re-inserts the entry when its key changes and bumps the tree version; the store then calls `deleteAt` on the path it held before that mutation. That path is now stale, so path validation throws. Even if it did not throw, it would delete the entry that was just re-inserted, and `byId` is never re-mapped to the new position.

Latent today — no caller re-keys an entry — but it is a loaded trap, and Arm 1's fix (import must move an existing id to a new coordinate) turns re-key into a *live* path, so the two must land together.

Expected: changing an entry's coordinate relocates it in the ordered tree, keeps a single live tree entry, and leaves `byId` pointing at the new location.

## Requirements

- Give the store one internal mutation helper that owns both the tree and `byId`; make `insert`, `upsert`, `update`, `importEntries`, and eviction go through it. Check the path/conflict signal the tree returns rather than discarding it.
- Rely on `updateAt`'s returned `[path, wasUpdate]` and refresh the id index when the key changed; delete the manual re-key block.
- Route `importEntries` through the upsert logic; report the count actually stored.
- **Add a property test asserting the invariant directly** — after an arbitrary sequence of `upsert` / `update` / `importEntries` / eviction operations, the tree entry count equals the `byId` size, and every tree entry is reachable via `byId` at its current coordinate. This is the part that retires the class; a future write path that bypasses the helper fails this test rather than shipping.

References: review store section, major findings "insert() ignores conflicts; importEntries can orphan tree entries" and "update() re-key branch throws and desyncs byId".
