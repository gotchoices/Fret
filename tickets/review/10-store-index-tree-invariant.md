----
description: The routing table used to keep its ordered peer list and its by-name lookup in sync by hand in each place that wrote to it, and several of those places got it wrong; all writes now go through one internal chokepoint, and a test drives random write sequences to prove the two stay in agreement.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/digitree.invariants.spec.ts, docs/fret.md, tickets/plan/16-store-perf-allocation.md
difficulty: medium
----
## What landed

`DigitreeStore` keeps two views of one population: the ordered B+Tree (`byKey`, read by every
ring walk, `list()`, `exportEntries()`) and a map from peer id to that entry's tree key
(`byId`, read by `getById` / `remove` / `update` / `setState` / `setMembership` / `size()`).
The tree key embeds the coordinate (`hex(coord)|id`), so a coordinate change is a **re-key**,
not an in-place edit. Two write paths broke the resulting invariant in opposite directions.
Both are fixed at one site.

**The invariant, stated once:** exactly one tree entry exists per peer id, and `byId` maps that
id to that entry's current key.

### The seam

New private `DigitreeStore.put(entry)` (`digitree-store.ts:130`) is the only place both
structures are written. It drops the id's existing entry when the key changed, then
`byKey.upsert`s the new one and points `byId` at it. `remove(id)` is the delete half and was
already correct — unchanged.

- `insert()` is **deleted**. It was the bug's origin (it discarded `BTree.insert`'s conflict
  signal, so a conflicting insert stored nothing while `byId` and every caller counted it as
  stored) and it had no callers outside the file. Its three internal callers now use `put`.
- `upsert(id, coord)` reads the existing entry via `getById` and hands the merged entry to
  `put`. Same "preserve mutable stats, refresh coord/lastAccess" contract as before.
- `update(id, patch)` builds the patched entry and calls `put`. The manual re-key block that
  called `deleteAt` on a path `updateAt` had already invalidated (and therefore threw
  `Path is invalid due to mutation of the tree`) is gone entirely.
- `importEntries` routes each decoded entry through `put` — **replace by id, snapshot wins**,
  including a coordinate move — and returns the count of *distinct ids stored* via a `Set`,
  not the number of input records. `state` still forced to `'disconnected'`,
  `negotiateFailures` / `lastNegotiateFailureAt` still reset to 0.

### Two changes beyond the ticket's TODO list

Both are small, both are argued below, both are fair game to push back on.

1. **`update`'s patch type is now `PeerPatch = Partial<Omit<PeerEntry, 'id'>>`**
   (`digitree-store.ts:55`). `id` is the identity `byId` is keyed on; patching it could only
   ever leave the two structures disagreeing, so it is now unrepresentable rather than merely
   unused. One caller annotation in `fret-service.ts:416` changed from `Partial<PeerEntry>` to
   `PeerPatch`. No caller passed `id` (verified by grep over all six `store.update(` sites).

2. **`FretService.importTable` re-asserts self's `member` label after import**
   (`fret-service.ts:2217`). This is a consequence of the semantic change, not a pre-existing
   bug: import used to silently no-op on an id already present, which accidentally protected
   self's seeded `member` label. Now the snapshot wins, so a record for self carrying
   `unknown` (another peer's table, or one predating the membership field) demotes self out of
   every member-only ring view. `seedFromPeerStore` re-seeds self each stabilization tick, so
   the old behavior would have self-healed in ~1 tick — but the window is real and the guard
   is one line. **This guard has no test** (see gaps).

## Testing

`packages/fret/test/digitree.invariants.spec.ts` — new. Property test plus four targeted
regressions.

**Property test (`holds after any sequence of writes`).** fast-check drives 1–60 arbitrary ops
(`upsert` / coord-changing `update` / field `update` / `importEntries` / `remove` / `setState` /
`setMembership`) over an **8-id, 8-coordinate pool** — small on purpose, so re-keys and key
collisions actually occur instead of being astronomically unlikely with 32 random bytes. After
each op it checks both:

- *Structure* — `list().length === size()`; ids in `list()` distinct; every listed entry
  resolves through `getById` to the same coordinate; `neighborsRight` / `neighborsLeft` at
  `count = size()` return `size()` **distinct** ids (this is the assertion that catches the
  ring-walk shrink, where both copies of a duplicated id consume result slots).
- *Content* — an independent model map of what each entry should hold (coord, relevance,
  state, membership, the four health counters, negotiateFailures) is compared field by field.

**Why the model half matters — it is not belt-and-braces.** I verified the property against a
deliberately broken seam (swapping `byKey.upsert` back to `byKey.insert`). With structural
assertions only, **it passed**: a conflicting insert keeps both structures consistent in *count*
while silently discarding the data it was asked to store. Only after adding the model
comparison did it fail (`after op 1 (touch): p6.relevance is 0, expected 5e-324`). A reviewer
re-running that experiment should see the same. The model deliberately omits `lastAccess`
(clock-derived) and `metadata`.

**Targeted regressions** — each documents one observed failure from the source ticket:

- import an id at a different coordinate → one tree entry at the new coordinate, `size() === 1`,
  `getById` resolves there, and `remove` empties the store (the orphan's tell was surviving
  `remove` and reappearing in `exportTable`);
- import over an existing id → snapshot's `relevance` / `membership` / `accessCount` /
  `successCount` / `failureCount` / `avgLatencyMs` are what the entry holds afterwards;
- import a snapshot containing one id twice → reported count 1, `size()` 1;
- `update(id, { coord })` → no throw, `getById` resolves, `size()` and `list().length` stay 1,
  and a successor walk observes the entry at its new ring position;
- `update(id, { coord })` preserves fields the patch did not name.

### Validation run

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — **375 passing, 0 failing** (~6 min). No pre-existing
  failures surfaced; `tickets/.pre-existing-error.md` not written.
- `cd packages/fret && yarn build` — clean.

`digitree.persistence.spec.ts`, `digitree.neighbors.spec.ts`, `ring-membership.spec.ts`,
`network.isolation.spec.ts` and the simulation specs all pass unchanged — no assertion was
adjusted anywhere.

## Known gaps — please probe these

- **`importTable`'s self-membership guard is untested.** There is no service-level test for
  `importTable` / `exportTable` at all (`grep -r importTable packages/fret/test` → nothing).
  The guard is asserted by reading, not by running. A test needs the libp2p memory harness
  (`test/helpers/libp2p.ts`); worth adding, and worth checking my reasoning about the
  ~1-tick self-heal window while you are there.
- **Capacity eviction is not exercised by the property test.** `enforceCapacity` lives on
  `FretService`, not the store, so the store-level property never sees an eviction interleaved
  with a re-key. Eviction only calls `store.remove`, which is the seam's delete half, so I
  believe it is safe — but that is an argument, not a test.
- **`update(id, { metadata: undefined })` sets `metadata` to `undefined` rather than deleting
  the key.** Pre-existing spread behavior, unchanged by this work, and not covered by the model
  (which omits `metadata`). Flagging it because the model's omission could hide it.
- **The property test's op pool is what I chose it to be.** It has no concurrent/interleaved
  ops (the store is synchronous, so there is nothing to interleave) and no `exportEntries` →
  `importEntries` round-trip inside the sequence. A round-trip op would be a cheap addition if
  you think it earns its place.
- **`put` is private and TypeScript-private only.** Nothing at runtime stops a future
  subclass or a cast from touching `byKey` / `byId` directly. The property test is the actual
  enforcement, not the access modifier.

## Docs and adjacent tickets

- `docs/fret.md` — invariant stated under *Routing store (Digitree) & indices (A2)* (one entry
  per peer id, id index points at its current key, single internal write seam, coordinate
  change is a re-key). *Routing table persistence* gained two bullets: import replaces by id,
  and returns distinct ids stored; plus the self-label note.
- `tickets/plan/16-store-perf-allocation.md` — appended a note to its body. Its proposed
  early-exit ("a repeated id proves the wrap walk wrapped") is only sound *because* this
  invariant now holds; before it, a duplicate id could appear mid-walk with no wrap and the
  early exit would truncate. Asks for a `NOTE:` at the walk site when 16 lands.
- `tickets/plan/19-cleanup-store-ring.md` — untouched. It extracts a shared directional walker
  from the four wrap walks in this file; mechanical and downstream, no conflict with the seam.

Out of scope and deliberately not touched: coordinate length/charset validation at the decode
boundary (`fix/11-coord-length-validation`).
