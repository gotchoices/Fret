description: Make repeated successful contact with a peer actually improve its score, and add a way to score a peer we have only been told about exactly once. This is the scoring-function half of the fix; the routing-table half follows in a companion ticket.
files: packages/fret/src/store/relevance.ts, packages/fret/test/relevance.properties.spec.ts
difficulty: easy

## Why this is split out

This ticket was carved off `25-frequency-credit-only-from-gossip` after two agent runs were
budget-capped before making any edit. Nothing in this ticket touches `fret-service.ts` or
`docs/fret.md` — both belong to the companion ticket
`frequency-credit-service-gossip`, which has this one as its `prereq:`. Keep the split: one
file of source, one file of test, no service reading.

## The decision (settled — do not re-open)

The relevance base is `w_r·recency + w_f·frequency + w_h·health` (0.4 / 0.2 / 0.4). Two facts
about it produce the reported inversion (a peer contacted 500 times ranking *below* one merely
named 500 times in other peers' snapshots):

- `frequency = log1p(accessCount)/5`, and **only `touch` increments `accessCount`** — and `touch`
  is what the snapshot-merge paths run for every id a *remote peer* names. So hearsay accrues
  frequency without bound.
- `health` is a *ratio*, so it saturates on the first success. `recordSuccess` touches neither
  counter that grows, so the 2nd and the 500th successful round trip add nothing.

Three rules, each checkable in isolation:

1. **A completed RPC is an access.** `recordSuccess` increments `accessCount`, exactly as `touch`
   does. Fixes "500 successes score what 1 success does".
2. **A failed RPC is not.** `recordFailure` leaves `accessCount` alone. Frequency rewards peers
   that proved useful; letting failures accrue it lets a permanently-dead peer we keep re-probing
   climb the longer it stays dead (the dead re-probe arm probes it forever, and the 0.7 decay is
   applied once per call, not cumulatively — it cannot offset a growing term). Failure already
   has two signals: the ratio in `health`, and that decay.
3. **A mention scores an entry once, at creation, and never again.** That is what
   `initialRelevance` below is for; the companion ticket wires it up.

**Health stays a pure rate — a deliberate decline, not an oversight.** The plan ticket offered
"a health term that distinguishes 1 success from 500" as an alternative arm. Rejected: volume now
lives in `frequency` and quality in `health`; putting volume in both double-counts it and forces
every weight to be re-tuned. Record it at `healthScore` as an accepted-tradeoff `NOTE:` (see
*Accepted tradeoffs* in the workflow rules) so the next reviewer does not re-file it. Revisit
condition: if the frequency term is ever removed or re-weighted to near zero.

## Shape

```ts
/**
 * Score a brand-new entry once, from its own empty counters.
 * No counter is incremented and the KDE is NOT observed: a name we were handed is not
 * a distance we accessed.
 */
export function initialRelevance(entry: PeerEntry, x: number, model: SparsityModel, now = Date.now()): number
```

Body is `baseRelevance(entry, now) * sparsityBonus(model, x)` — note **no `observeDistance` call**,
which is the one thing that makes it different from a `touch` with the increment removed.

For an entry straight out of `DigitreeStore.upsert` (verified — defaults are `relevance: 0`,
`lastAccess: now`, `accessCount: 0`, `successCount: 0`, `failureCount: 0`, `avgLatencyMs: null`,
`membership: 'unknown'`, `state: 'disconnected'`) the base works out to
`0.4·recency(now=lastAccess)=0.4` + `0.2·log1p(0)/5=0` + `0.4·health(0/0 ratio → 0.5 rate,
null latency → 0.5 penalty → 0.5)=0.2` = **0.6**, times the sparsity bonus. That sits *below* any
genuinely contacted, fresh peer and can be beaten by an aged genuine entry losing its recency —
correct decay, not a regression.

`recordSuccess` gains `accessCount: entry.accessCount + 1` in **both** the `baseRelevance` input
object and the returned patch. `recordFailure` unchanged. `touch` unchanged.

### Frequency is unbounded in principle

`log1p` slows but does not cap. With hearsay removed it grows only with real completed RPCs, so
it is bounded by traffic; at `accessCount` 1e6 the term contributes 0.55 against `recency` /
`health` ceilings of 0.4 each. Not a defect today — record as a `NOTE:` tripwire at
`frequencyScore`; **do not file a ticket** for it.

## Tests

`test/relevance.properties.spec.ts` already has `makeEntry(overrides?)` and
`FIXED_NOW = 1_700_000_000_000`. Pin, at that clock and a fixed `x`, with a **fresh model per
call** so the sparsity bonus is constant:

- `recordSuccess` × 500 scores **strictly above** `recordSuccess` × 1. (Today: identical.)
- `recordFailure` × 500 does **not** score above `recordFailure` × 1.
- `initialRelevance` does not move `model.occupancy` (a mention is not an observed distance).
- `initialRelevance` on a fresh entry scores **strictly below** `recordSuccess` × 1 on the same
  fresh entry at the same clock/model.
- The existing "a success outranks a failure" property must keep passing unchanged.

The test at the end of the `recordSuccess` block carries a comment block that explicitly declines
to pin a direction and cites the now-closed slug
`tickets/backlog/bug-frequency-credit-only-from-gossip`. That comment is what must be replaced by
the assertions above.

The cross-arm property "`recordSuccess` × 500 outranks a gossip-created entry named 500 more
times" needs `noteDiscovered`, so it lives in the companion ticket, not here.

## TODO

- Add `initialRelevance` to `relevance.ts` (exported; no `observeDistance`).
- Increment `accessCount` in `recordSuccess` only — both the `baseRelevance` input and the patch.
- Replace the ~20-line `NOTE:` in the JSDoc directly above `recordSuccess`. It documents the old
  behavior in detail (quoting 1.2600 / 1.5275 / 1.0449 / 0.8619) and points at the closed backlog
  slug. Replace with a short statement of the settled rule: frequency counts proven contact;
  failures do not accrue it; a mention scores once at creation via `initialRelevance`.
- Add the accepted-tradeoff `NOTE:` at `healthScore` (health is deliberately a rate; revisit if
  the frequency term is removed or re-weighted to near zero).
- Add the unbounded-frequency tripwire `NOTE:` at `frequencyScore`.
- Update `test/relevance.properties.spec.ts` per *Tests* above.
- Leave `docs/fret.md` alone — the companion ticket owns every doc edit, so the two do not
  collide on one file.
- `cd packages/fret && npx tsc --noEmit && yarn test`
