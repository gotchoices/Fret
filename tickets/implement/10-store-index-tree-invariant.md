----
description: The routing table keeps two views of the same peer list — an ordered ring and a by-name lookup — and several write paths can leave them disagreeing, so a peer can end up listed twice in the ring, invisible to lookups, impossible to remove, or silently dropped when a saved table is restored.
files: packages/fret/src/store/digitree-store.ts, packages/fret/test/digitree.persistence.spec.ts, packages/fret/test/digitree.neighbors.spec.ts, docs/fret.md
difficulty: medium
repro: verified — both arms reproduced against HEAD; observed output quoted below.
----
`DigitreeStore` maintains two structures over the same entries:

- `byKey` — the ordered B+Tree keyed by `hex(coord)|id`. Every ring walk (`neighborsRight` / `neighborsLeft` / `successorOfCoord` / `predecessorOfCoord`), `list()`, and `exportEntries()` read it.
- `byId` — a `Map` from peer id to that tree key. Every `getById`, `remove`, `update`, `setState`, `setMembership`, and `size()` reads it.

Because the tree key embeds the coordinate, **changing a peer's coordinate changes its tree key** — an update is a re-key, not an in-place edit. Everything above the store rests on one invariant that nothing currently enforces:

> **Exactly one tree entry exists per peer id, and `byId` maps that id to that entry's current key.**

Two write paths break it, in opposite directions. They are one ticket because they resolve at one site: the store has no single place that owns both structures, so each write path re-derives the bookkeeping and each gets it wrong differently. The fix is one internal mutation seam that every write goes through, plus a property test that fails for any future write path that bypasses it.

## Arm 1 — `insert()` discards the tree's conflict signal, so `importEntries` orphans entries

`insert` (`digitree-store.ts:96-100`) calls `byKey.insert(entry)` and throws away the returned path. The tree returns `on = false` on a duplicate key and **does not store the entry**; the store nevertheless sets `byId` and its callers count the entry as stored. `importEntries` (`:334-361`) calls `insert` directly rather than going through `upsert`'s existing merge logic, and imported coordinates come off disk or the wire and are never re-derived from the peer id. Three failures follow.

**1a — a coordinate move orphans the old tree entry.** Importing an id at a coordinate different from its existing entry produces a *second* tree entry, because the two coordinates yield two different tree keys and neither insert conflicts. Observed:

```
store.upsert('p1', coord 10); store.importEntries([p1 @ coord 200])
  imported count 1   size() 1   list().length 2
  list ids  [ 'p1@10', 'p1@200' ]
  after remove('p1'): size() 0   list [ 'p1@10' ]
```

The orphan `p1@10` is unreachable through `getById`, survives `remove`, is exported again on the next `exportTable()`, and still appears in every ring walk.

**1b — an orphan shrinks ring walks below the requested count.** `neighborsRight` / `neighborsLeft` increment their result counter per pushed id and de-duplicate only at the end (`Array.from(new Set(out))`), so both copies of an orphaned id consume slots. A window containing both copies returns fewer distinct peers than asked for. Observed:

```
tree: [ 'p1@10', 'p1@20', 'p2@30' ]        // p1@10 orphaned by an import
neighborsRight(coord 0, 2)  ->  [ 'p1' ]   // asked for 2 distinct, got 1
```

The filtered-walk scan cap has the same root: `maxScan = this.size()` reads `byId.size` while the tree holds more, so a filtered walk can stop before completing one traversal.

**1c — re-importing an existing id silently discards the restored data and over-reports.** When the coordinate *is* unchanged (the normal case — coordinates are hash-derived, so a snapshot of a peer already in the table has the same coordinate), the tree key matches, `byKey.insert` conflicts, and the imported entry is dropped on the floor while `importEntries` still counts it. This is the routinely-reachable arm: `importTable` is public and nothing stops a caller invoking it after `start()`, at which point self and any peer-store-seeded peers are already present. Observed:

```
store.upsert('p1', coord 10);                       // relevance 0, membership 'unknown'
store.importEntries([p1 @ coord 10, relevance 99, membership 'member', accessCount 7])
  reported restored: 1
  relevance: 0   membership: unknown   accessCount: 0     // snapshot data silently lost
```

Expected: importing never produces two tree entries for one id; a re-imported id replaces its existing entry, including a coordinate move; the reported restored count is the number of ids actually stored.

## Arm 2 — `update()`'s re-key branch throws and desyncs `byId`

`update` (`digitree-store.ts:145-157`) calls `byKey.updateAt(path, next)` and *then* checks whether the key changed, calling `deleteAt` on the path it captured beforehand. But `updateAt` already handles the key change: `internalUpdate` (digitree `b-tree.js:376-393`) re-inserts under the new key, deletes the old entry, and bumps the tree version. The captured path is stale by then, so `deleteAt`'s path validation throws. Observed:

```
store.upsert('p1', coord 10); store.update('p1', { coord: coord 200 })
  THREW: Path is invalid due to mutation of the tree
  getById('p1'): undefined
  tree list:     [ 'p1@200' ]      // tree re-keyed correctly
  size():        1                 // byId still maps p1 -> the old key
```

So the entry is orphaned in the opposite direction from Arm 1: live in the ring, invisible to every `byId` reader. And if the throw did not happen, the `deleteAt` would delete the entry `updateAt` had just re-inserted.

Dormant today — grep confirms no caller passes `coord` in an `update` patch (`fret-service.ts:337, 348, 364, 396, 420, 1185`). But Arm 1's fix makes a coordinate move a live path, so the two land together.

Expected: changing a coordinate relocates the entry in the ordered tree, leaves exactly one live tree entry, and leaves `byId` pointing at its new key. No throw.

## Design

Add one private mutation seam and route every write through it. `upsert`'s existing delete-then-insert re-key dance is the correct model; the seam generalizes it so `update` and `importEntries` inherit it rather than each re-deriving it.

```ts
/**
 * The single write seam over both structures: places `entry` as the one and only
 * tree entry for its id and points `byId` at it. Every mutating path goes through
 * here, so the one-entry-per-id invariant holds by construction.
 */
private put(entry: PeerEntry): PeerEntry {
	const key = makeKey(entry);
	const prevKey = this.byId.get(entry.id);
	if (prevKey !== undefined && prevKey !== key) {
		// Coordinate changed => tree key changed. Drop the old entry before
		// placing the new one, or the tree keeps both under different keys.
		const prev = this.byKey.find(prevKey);
		if (prev.on) this.byKey.deleteAt(prev);
	}
	this.byKey.upsert(entry);   // insert-or-replace at `key`: cannot conflict
	this.byId.set(entry.id, key);
	return entry;
}
```

Two notes on the shape:

- **Use `byKey.upsert`, not `byKey.insert` or the `updateAt` return value.** `BTree.upsert` is insert-if-absent / replace-in-place-if-present, so it has no conflict outcome to check and covers the plain-field-update case and the post-delete re-key case with the same call. That is strictly simpler than checking `updateAt`'s `[path, wasUpdate]` and handling its "new key already present" failure arm — which, once the invariant holds, is unreachable anyway. (The source ticket's hint suggested the `updateAt` route; this achieves the same invariant with one fewer branch, and the property test pins the outcome either way.)
- **Paths stay fresh.** `find` is called immediately before `deleteAt` with no mutation between, and `byKey.upsert` does its own internal `find`. Neither path can go stale — which is exactly the failure in Arm 2.

`remove(id)` is the delete half of the same seam and is already correct; leave it as the single delete path.

The public mutating surface then becomes `upsert`, `update`, `setState`, `setMembership`, `remove`, `importEntries` — all funnelling into `put` / `remove`. Make `insert` private (it has no callers outside this file — verified by grep for `.insert(` across `packages/fret`) so no future caller can write to the tree without the seam; simplest is to delete `insert` outright and have its two internal callers use `put`.

### `importEntries` semantics

Route each deserialized entry through `put`, which gives replace-by-id semantics: **the snapshot wins**, including a coordinate move. That is what fixes 1a and 1c together. `state` is still forced to `'disconnected'` and `negotiateFailures` / `lastNegotiateFailureAt` still reset to 0 — unchanged, and for the same documented reason (handshake and connection liveness cannot survive a restart).

Return the number of **distinct ids stored**, not the number of input records, so a snapshot carrying an id twice reports 1. Track with a `Set<string>` of ids seen and return its size.

Out of scope: coordinate length/charset validation at the decode boundary — that is `fix/11-coord-length-validation`, same subsystem, different seam. Do not add validation here.

### Invariant test

The property test is the part that retires the class: a future write path that bypasses `put` fails it rather than shipping. New file `packages/fret/test/digitree.invariants.spec.ts`, fast-check (already a dependency — see `digitree.persistence.spec.ts` for the idiom).

Generate an arbitrary sequence of operations drawn from `upsert` / `update` (including coordinate-changing patches) / `importEntries` / `remove` / `setState` / `setMembership`, over a **small** id pool (~8) and a **small** coordinate pool (~8) so collisions and re-keys actually occur rather than being astronomically unlikely. After the sequence, assert:

- `store.list().length === store.size()` — tree entry count equals `byId` size. (`list()` walks the tree, so it is the tree's count; no new API needed to reach the private tree.)
- The ids in `store.list()` are distinct — one tree entry per id.
- For every listed entry, `store.getById(e.id)` resolves and its coordinate equals the listed entry's coordinate — `byId` points at the *current* entry, not a stale one.
- `store.neighborsRight(anyCoord, store.size())` returns `store.size()` distinct ids, and likewise `neighborsLeft` — the ring walk sees exactly the same population (this is the assertion that catches the 1b shrink).

Alongside it, targeted regressions that document each observed failure (a property test alone does not explain the bug to the next reader):

- Import an id at a coordinate different from its existing entry: one tree entry, at the new coordinate, `size() === 1`, `getById` resolves there, and `remove` empties the store.
- Import over an existing id: the snapshot's `relevance` / `membership` / `accessCount` / `successCount` / `failureCount` / `avgLatencyMs` are what the entry holds afterwards (today they are silently discarded).
- Import a snapshot containing the same id twice: reported count is 1, `size()` is 1.
- `update(id, { coord })`: does not throw, `getById` still resolves, the entry's ring position moved, `size()` unchanged, `list().length === 1`.

### Interaction with adjacent open tickets

- `plan/16-store-perf-allocation` proposes early-exiting a wrap walk on the first repeated id (a repeat proves the ring wrapped). That reasoning is only sound *once this invariant holds* — today a duplicate id can appear mid-walk without any wrap having occurred, which would truncate the walk. Worth a sentence in that ticket's body or a `NOTE:` at the walk site when 16 lands; no work here.
- `plan/19-cleanup-store-ring` extracts a shared directional walker from the four wrap walks in this same file. Purely mechanical and downstream of this ticket by sequence; no conflict with the write seam.

## TODO

- Add the private `put(entry)` seam to `DigitreeStore` with the doc comment explaining why it exists (it is the only place both structures are written).
- Delete `insert`; point `upsert`'s two branches and `importEntries` at `put`.
- Rewrite `update` to build the patched entry and call `put`; delete the manual re-key block at `:153-156` entirely.
- Rewrite `importEntries` to build each `PeerEntry` as it does today and call `put`; count distinct ids stored via a `Set` and return that.
- Add `packages/fret/test/digitree.invariants.spec.ts` with the fast-check property test and the four targeted regressions above.
- Run the full suite: `cd packages/fret && yarn test`. `digitree.persistence.spec.ts`, `digitree.neighbors.spec.ts`, `cohort.properties.spec.ts` and the simulation specs are the ones most likely to move; investigate any change rather than adjusting an assertion.
- Type-check: `cd packages/fret && npx tsc --noEmit`.
- Document the invariant in `docs/fret.md` under *Routing store (Digitree) & indices (A2)* (or the *Digitree implementation* subsection): one tree entry per peer id with the id index pointing at its current key, enforced by a single internal write seam, and note that a coordinate change is a re-key rather than an in-place edit.
