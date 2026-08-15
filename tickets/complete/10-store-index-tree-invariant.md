----
description: The routing table used to keep its ordered peer list and its by-name lookup in sync by hand in each place that wrote to it, and several of those places got it wrong; all writes now go through one internal chokepoint, a test drives random write sequences to prove the two stay in agreement, and restoring a saved table no longer lets the file overwrite the node's record of itself.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/test/digitree.invariants.spec.ts, packages/fret/test/service.table-persistence.spec.ts, docs/fret.md
----
## What landed

`DigitreeStore` keeps two views of one population: the ordered B+Tree (`byKey`, read by every
ring walk, `list()`, `exportEntries()`) and a map from peer id to that entry's tree key
(`byId`, read by `getById` / `remove` / `update` / `setState` / `setMembership` / `size()`).
The tree key embeds the coordinate (`hex(coord)|id`), so a coordinate change is a **re-key**,
not an in-place edit. Two write paths broke the resulting invariant in opposite directions.

**The invariant:** exactly one tree entry exists per peer id, and `byId` maps that id to that
entry's current key.

### The seam

New private `DigitreeStore.put(entry)` (`digitree-store.ts:130`) is the only place both
structures are written. It drops the id's existing entry when the key changed, then
`byKey.upsert`s the new one and points `byId` at it. `remove(id)` is the delete half and was
already correct — unchanged.

- `insert()` is **deleted**. It was the bug's origin: it discarded `BTree.insert`'s conflict
  signal, so a conflicting insert stored nothing while `byId` and every caller counted it as
  stored.
- `upsert(id, coord)` reads the existing entry via `getById` and hands the merged entry to
  `put`. Same "preserve mutable stats, refresh coord/lastAccess" contract as before.
- `update(id, patch)` builds the patched entry and calls `put`. The manual re-key block that
  called `deleteAt` on a path `updateAt` had already invalidated (and therefore threw
  `Path is invalid due to mutation of the tree`) is gone.
- `importEntries` routes each decoded entry through `put` — **replace by id, snapshot wins**,
  including a coordinate move — and returns the count of *distinct ids stored* via a `Set`,
  not the number of input records. `state` still forced to `'disconnected'`,
  `negotiateFailures` / `lastNegotiateFailureAt` still reset to 0.
- `update`'s patch type is now `PeerPatch = Partial<Omit<PeerEntry, 'id'>>`
  (`digitree-store.ts:55`). `id` is the identity `byId` is keyed on, so patching it is now
  unrepresentable rather than merely unused.

### A snapshot never speaks for self

`FretService.importTable` (`fret-service.ts:2217`) drops the snapshot record whose id is the
importing node's own before handing the rest to the store; the returned count therefore
excludes self. This is a consequence of the replace-by-id change, not a pre-existing bug —
import used to silently no-op on an id already present, which accidentally protected self's
live entry. Both fields that make self's entry authoritative come from the snapshot and both
would be wrong: `membership` (absent in a pre-membership snapshot, `unknown` in one taken by
another peer — either drops self out of every member-only ring view) and `coord` (a tampered
one moves self off its own ring position, so `enforceCapacity` no longer protects it).

## Testing

`packages/fret/test/digitree.invariants.spec.ts` — property test plus five targeted
regressions.

**Property test (`holds after any sequence of writes`).** fast-check drives 1–60 arbitrary ops
(`upsert` / coord-changing `update` / field `update` / `importEntries` / `reimport` / `remove` /
`setState` / `setMembership`) over an **8-id, 8-coordinate pool** — small on purpose, so re-keys
and key collisions actually occur instead of being astronomically unlikely with 32 random
bytes. After each op it checks both:

- *Structure* — `list().length === size()`; ids in `list()` distinct; every listed entry
  resolves through `getById` to the same coordinate; `neighborsRight` / `neighborsLeft` at
  `count = size()` return `size()` **distinct** ids (this is the assertion that catches the
  ring-walk shrink, where both copies of a duplicated id consume result slots).
- *Content* — an independent model map of what each entry should hold (coord, relevance,
  state, membership, the four health counters, negotiateFailures) is compared field by field.
  The model deliberately omits `lastAccess` (clock-derived) and `metadata`.

The `reimport` op feeds the store its own export. Every record then collides with a live id at
the same key, which is the replace-at-an-existing-key path applied to the whole population at
once — a shape no single-record import reaches. Its observable effect (`state` back to
`disconnected`, `negotiateFailures` back to 0) is modelled.

**Targeted regressions** — each documents one observed failure: import at a moved coordinate
leaves one entry that `remove` can delete; import over an existing id takes the snapshot's
fields; a snapshot carrying an id twice reports 1; `update(id, { coord })` re-keys without
throwing and the successor walk observes the move; `update(id, { coord })` preserves unnamed
fields.

`packages/fret/test/service.table-persistence.spec.ts` — new, service level over
memory-transport libp2p nodes. Covers `importTable` restoring a snapshot peer as
`member` / `disconnected`; ignoring a snapshot record for self that carries `membership:
'unknown'` and a bogus coordinate (self keeps `member` and its own coordinate, and is excluded
from the count); and re-importing the service's own export leaving the population unchanged.

### Validation run

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — **378 passing, 0 failing** (~5 min). No pre-existing
  failures surfaced; `tickets/.pre-existing-error.md` not written.
- `cd packages/fret && yarn build` — clean.
- No lint step exists in this repo (`AGENTS.md`: `yarn format` is off-limits for lack of a
  prettier config; `yarn check` — typecheck + build + test — is the gate).

`digitree.persistence.spec.ts`, `digitree.neighbors.spec.ts`, `ring-membership.spec.ts`,
`network.isolation.spec.ts` and the simulation specs all pass unchanged — no assertion was
adjusted anywhere.

## Docs

- `docs/fret.md`, *Routing store (Digitree) & indices (A2)* — the invariant, the single write
  seam, and coordinate-change-is-a-re-key.
- `docs/fret.md`, *Routing table persistence* — import replaces by id; returns distinct ids
  stored; **a snapshot never speaks for self**, with the two fields that would otherwise be
  wrong and a pointer to the still-open coordinate-verification concern for other peers.
- `packages/fret/src/index.ts` — `PeerPatch` added to the public type re-exports.
- `tickets/plan/16-store-perf-allocation.md` — note that its proposed early-exit ("a repeated
  id proves the wrap walk wrapped") is only sound *because* this invariant now holds; asks for
  a `NOTE:` at the walk site when 16 lands.
- `tickets/plan/19-cleanup-store-ring.md` — untouched; mechanical and downstream, no conflict.

Out of scope and deliberately not touched: coordinate length/charset validation at the decode
boundary (`fix/11-coord-length-validation`).

## Review findings

### Checked

Implement-stage diff read first, ahead of the handoff. `digitree-store.ts` in full;
`fret-service.ts` at every `store.upsert` / `getById` / `update` site and at
`enforceCapacity` / `seedFromPeerStore` / `importTable` / `exportTable`; `src/index.ts`
exports; the digitree `BTree` API surface (`insert` vs `upsert` vs `updateAt` semantics and
entry freezing); `docs/fret.md` A2 and *Routing table persistence*; `digitree.persistence.spec.ts`
and the new invariants spec; the board's open tickets naming these files.

**Seam mutation-tested, not just read.** Two deliberate breakages, each reverted:

- Removing the re-key delete from `put` → 4 tests fail, including the property.
- Swapping `byKey.upsert` back to `byKey.insert` → 3 fail, the property with exactly the model
  message the handoff quoted (`after op 1 (touch): p6.relevance is 0, expected 5e-324`).
  Structural assertions alone pass this one. The model half is load-bearing as claimed.

### Fixed in this pass (minor)

- **`importTable` repaired self's `membership` but not self's `coord`.** Both are supplied by
  the snapshot and both are clobbered by the new replace-by-id semantics; a wrong self
  coordinate moves self off its own ring position, so `enforceCapacity`'s
  `protectedIdsAround(selfCoord)` no longer protects it. Replaced the one-field repair with one
  rule — drop the snapshot's record for self — which closes both and is less code. Docs bullet
  rewritten to match. This narrows the *self* case of coordinate tampering only; the general
  case is a separate open ticket (below).
- **`PeerPatch` was not exported from `src/index.ts`** while being the parameter type of the
  public `DigitreeStore.update`, so a consumer could not name it. Added alongside `PeerEntry`.
  (`plan/22-public-api-types` also touches `index.ts` but concerns `any`-typing and a duplicate
  import at other lines — no conflict.)
- **The `importTable` self guard had no test** — the gap the handoff asked to be probed. New
  `test/service.table-persistence.spec.ts`, three tests. The two assertions that would have
  failed against the pre-fix code are the coordinate and the returned count.
- **Property test had no export→import round-trip op**, which the handoff offered as a cheap
  addition. Added as `reimport`; it earns its place by reaching the replace-at-an-existing-key
  path across the whole population at once.

### Checked and left alone, with reasons

- **`update(id, { metadata: undefined })` sets the key rather than deleting it** — flagged in
  the handoff. Benign *and* unreachable: every reader is a truthiness check (`snap.metadata`,
  `entry?.metadata`, `exportEntries`'s conditional spread), and the only site that patches
  metadata (`fret-service.ts:1185`) is guarded by `if (snap.metadata)`. No `NOTE:` added —
  there is no condition under which it becomes work. The metadata site is separately claimed by
  `backlog/plan/3-metadata-sanitization`.
- **Capacity eviction interleaved with a re-key** — the handoff called this an argument rather
  than a test. It holds: `enforceCapacity` snapshots the population through `list()` into a
  plain array before removing anything, reads only `.id` / `.relevance` off it, and `remove`
  re-resolves by id, so no invalidated tree path is ever touched. The property test's `remove`
  op covers the store half.
- **`neighborsRight` / `neighborsLeft` still `Set`-dedup their result** even though the
  invariant now makes duplicates impossible within one traversal. Still required: `count >
  size()` wraps the walk and re-pushes. Those walk sites are claimed by
  `plan/19-cleanup-store-ring` and `plan/16-store-perf-allocation`.
- **Coordinate tampering in other peers' import records** — `backlog/plan/2-routing-table-export-integrity`
  already asks for exactly this (its point 3: re-verify `hashPeerId(id)` against the stored
  coordinate on import). Not re-filed; site-claim grep found it.
- **`insert()` has no surviving callers** anywhere in `src/` or `test/` — verified, not assumed.
- **No caller mutates a returned `PeerEntry`.** The `BTree` freezes entries, so a stray field
  assignment would throw under ESM strict mode. Grepped every entry-field assignment in `src/`;
  the only hit is a read (`peer-discovery.ts:72`).

### New tickets filed: none

Every concern found either resolved at its own site in this pass or is already claimed by an
open ticket named above. Nothing rose to the "climb the architecture ladder" bar — the
architectural move this ticket exists to make (one write seam plus a property test that fails
for anything bypassing it) is the thing that landed.

### Tripwires recorded: none

The two conditional concerns in this code already carry their own markers at their sites: the
filtered-walk `NOTE:` about O(`size()`) skip-scanning on a mostly-foreign ring
(`digitree-store.ts:241`), and hot-path allocation churn (`plan/16-store-perf-allocation`, with
the invariant dependency noted there). Nothing new turned up that is fine-now-but-conditional.
