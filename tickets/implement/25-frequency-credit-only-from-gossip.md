----
description: A peer we have successfully contacted hundreds of times can rank below one we have never contacted but that other peers keep naming, so the routing table drops the proven-good peer first. Fix the scoring so repeated contact earns credit and repeated hearsay does not.
files: packages/fret/src/store/relevance.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/relevance.properties.spec.ts, packages/fret/test/relevance.eviction.spec.ts, docs/fret.md
difficulty: medium
----

## The decision (settled here — do not re-open)

The relevance base is `w_r·recency + w_f·frequency + w_h·health` (0.4 / 0.2 / 0.4). Two facts
about it produce the inversion:

- `frequency = log1p(accessCount)/5`, and **only `touch` increments `accessCount`** — and `touch`
  is what the snapshot-merge paths run for every id a *remote peer* names. So hearsay accrues
  frequency without bound.
- `health` is a *ratio*, so it saturates on the first success. `recordSuccess` touches neither
  counter that grows, so the 2nd and the 500th successful round trip add nothing.

The design adopted:

**Frequency counts proven contact. Being named by someone else creates an entry and nothing more.**

Three rules, each stated so it can be checked in isolation:

1. **A completed RPC is an access.** `recordSuccess` increments `accessCount`, exactly as `touch`
   does. This is the arm that fixes "500 successes score what 1 success does".
2. **A failed RPC is not.** `recordFailure` leaves `accessCount` alone. Frequency exists to
   reward peers that proved useful; letting failures accrue it lets a permanently-dead peer we
   keep re-probing climb the ranking the longer it stays dead (the dead re-probe arm probes it
   forever, and the 0.7 decay is applied once per call, not cumulatively — it cannot offset a
   growing term). Failure already has its own two signals: the ratio in `health` and that decay.
3. **A mention scores an entry once, at creation, and never again.** A gossiped id we hold no
   entry for is created and given a one-off baseline score from its own (empty) counters. An id
   we already hold is left completely alone — same score after a thousand mentions as after one.
   So mention count is not a lever an attacker (or a chatty honest peer) can pull.

**Health stays a pure rate — this is a deliberate decline, not an oversight.** The plan ticket
offered "a health term that distinguishes 1 success from 500" as an alternative arm. Rejected:
volume now lives in `frequency` and quality in `health`; putting volume in both double-counts it
and forces every weight to be re-tuned. Record it at `healthScore` as an accepted-tradeoff
`NOTE:` (see *Accepted tradeoffs* in the workflow rules) so the next reviewer does not re-file it.
Revisit condition: if the frequency term is ever removed or re-weighted to near zero.

### Why a baseline rather than "gossip gets nothing at all"

The obvious minimal fix — make the merge paths a bare `upsert` with no scoring, matching the rule
already documented for leave-notice replacements — **starves discovery at capacity**. Stored
relevance is only ever written by a scoring call, so a never-scored entry sits at `relevance = 0`;
`enforceCapacity` sorts ascending and evicts the lowest unprotected entry, so on a full table
every newly discovered peer is evicted before the classification pass can probe it, and the table
can never learn a new peer again. A fixed baseline avoids that while still being flat in mention
count, which is the property the leave-replacement rule actually wanted.

The baseline sits *below* any genuinely contacted, fresh peer (no frequency credit, `health` at
the neutral 0.5 from a 0/0 ratio and an unmeasured latency) and can be beaten by an aged genuine
entry losing its recency — which is correct decay, not a regression.

## Shape

`packages/fret/src/store/relevance.ts`

```ts
/**
 * Score a brand-new entry once, from its own empty counters.
 * No counter is incremented and the KDE is NOT observed: a name we were handed is not
 * a distance we accessed.
 */
export function initialRelevance(entry: PeerEntry, x: number, model: SparsityModel, now = Date.now()): number
```

`recordSuccess` gains `accessCount: entry.accessCount + 1` in both the `baseRelevance` input and
the returned patch. `recordFailure` unchanged. `touch` unchanged.

`packages/fret/src/service/fret-service.ts`

```ts
/**
 * Record that some *other* peer named this id. Creates the entry with a one-off baseline
 * score; an id we already hold is left untouched, so mention count is not a score lever.
 */
private async noteDiscovered(id: string, coord: Uint8Array): Promise<void>
```

`applySuccess`'s `store.update` patch must carry `accessCount: next.accessCount` — that patch is
built field-by-field, so a field not listed is silently not written.

### Call sites (line numbers approximate — grep the symbol)

Keep `applyTouch` — these are interactions we took part in, not hearsay:
- `peer:connect` handler (~968) — a transport connection formed.
- announce-snapshot **sender** (~1915) — an inbound RPC on our namespaced protocol; the strongest
  evidence there is (see *Evidence strength* in `docs/fret.md`).

Switch to `noteDiscovered`:
- announce-snapshot id lists and sample entries (~1939, ~1963)
- fetched-snapshot id lists and sample entries (~2529, ~2540)
- `seedFromBootstraps` (~2089) — a configured name, not a peer we contacted; it is contacted
  moments later anyway and scores properly then.

Leave alone: `seedFromPeerStore` (already scores nothing) and the leave-replacement `upsert`
(~1802) — its existing `NOTE:` explaining the deliberate absence of `applyTouch` should be
updated to point at `noteDiscovered` as the general rule rather than reading as a local exception.

## Edge cases & interactions

- **Frequency is unbounded in principle** (`log1p` slows but does not cap). With hearsay removed
  it grows only with real completed RPCs, so it is bounded by traffic. At `accessCount` 1e6 the
  term contributes 0.55 against `recency`/`health` ceilings of 0.4 each. Not a defect today —
  record as a `NOTE:` tripwire at `frequencyScore`; do not file a ticket.
- **Capacity/eviction.** Add an eviction test: a peer with many recorded successes must survive a
  capacity squeeze against a never-contacted peer named in many snapshots. That is the
  user-visible half the plan ticket could only measure at the function level. `enforceCapacity`
  compares *stored* scores taken under different KDE states — hold the model fixed, or assert an
  ordering robust to it (the plan ticket measured 1.0449 vs 0.8619 on a shared model: same
  ordering, lower magnitudes).
- **Lost-increment race.** `applySuccess` reads, awaits `selfCoord()`, then writes a value derived
  before the await; two concurrent chains lose one increment. `accessCount` now rides that same
  path. Same tolerance as `successCount` — these counters only feed a score recomputed on every
  call — but the existing NOTE on `applySuccess` names the counters explicitly and must name this
  one too. Do **not** make it read-modify-write; the pooled tick's candidate sets are disjoint by
  construction (`docs/fret.md`, *Stabilization and churn handling*).
- **Existing entry, mention path.** `noteDiscovered` must not `upsert` an id it already holds:
  `upsert` refreshes `lastAccess`, which is both the recency input and the ordering key for the
  unknown-classification probe rotation ("ascending `lastAccess`"). Refreshing it on gossip would
  sink a heavily-gossiped unknown peer to the back of its own probe queue.
- **A discovered id whose peer id or coordinate will not parse** must still be skipped by the
  merge loops' existing per-entry `try/catch` — `noteDiscovered` must not swallow that (a
  wrong-width coordinate throws at the store's write seam, by design).
- **Self.** `noteDiscovered` must never create or rescore self's entry; self is seeded `member`
  and its local entry is authoritative (same reasoning as `importTable` dropping self's record).
- **Import/export.** `accessCount` is already in `SerializedPeerEntry`; no schema change. An
  imported entry keeps its `accessCount`, which now means "contacts", not "mentions" — so a
  pre-change snapshot restores inflated frequency. Acceptable and self-correcting (relevance is
  rewritten on the next scoring call); state it in the review handoff rather than adding a
  migration.
- **Dead / foreign peers.** Rule 2 means a peer stuck in the dead re-probe arm no longer climbs.
  Assert it: N failures in a row must not raise relevance above where 1 failure left it (clock
  and model held fixed).

## Tests (write these first)

At a pinned clock and a fixed `x`, with a fresh model per call so the sparsity bonus is constant:

- `recordSuccess` × 500 scores **strictly above** `recordSuccess` × 1. (Today: identical.)
- `recordSuccess` × 500 scores **strictly above** an entry created by `noteDiscovered` and then
  named 500 more times. (Today: below — the reported inversion.)
- `noteDiscovered` × 500 == `noteDiscovered` × 1, exactly. Flat in mention count.
- `recordFailure` × 500 does not score above `recordFailure` × 1.
- `initialRelevance` does not move `model.occupancy` (a mention is not an observed distance).
- Service-level eviction test per *Edge cases* above.
- The existing "a success outranks a failure" property in `test/relevance.properties.spec.ts`
  must keep passing unchanged.

## TODO

- Add `initialRelevance` to `relevance.ts`; increment `accessCount` in `recordSuccess` only.
- Replace the long `NOTE:` above `recordSuccess` (it documents the old behavior and points at a
  now-closed backlog slug) with a short statement of the settled rule.
- Add the accepted-tradeoff `NOTE:` at `healthScore` and the unbounded-frequency tripwire `NOTE:`
  at `frequencyScore`.
- Add `FretService.noteDiscovered`; carry `accessCount` in `applySuccess`'s patch; update the
  `applySuccess` NOTE to name it.
- Switch the five hearsay call sites; leave the two interaction sites on `applyTouch`.
- Update the leave-replacement `NOTE:` (~1802) to reference the general rule.
- Update `test/relevance.properties.spec.ts` — it currently pins *no* direction on either
  behavior and cites the closed backlog slug; it must now pin the direction.
- Update `docs/fret.md`: *Relevance scoring and table management* (components list) and
  *Relevance score calculation* (the notes under the `base = …` block) to state that frequency
  counts proven contact only, that a mention scores once at creation, and that health is
  deliberately a rate.
- `cd packages/fret && npx tsc --noEmit && yarn test`
