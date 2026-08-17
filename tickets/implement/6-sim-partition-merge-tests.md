----
description: The network simulator cannot model a network split, so nothing checks that the two halves keep working on their own and knit back together once the split heals — a scenario the design document names as required testing.
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation/message-bus.ts, packages/fret/test/simulation.partition.spec.ts, docs/fret.md
difficulty: hard
----
`docs/fret.md` — *Testing strategy* — names "partition/merge behavior" as a simulation-tier
requirement, and *Partition and merge hooks* describes what should happen. No scenario in the
suite splits the network. This ticket makes a split expressible in the deterministic simulation
harness and adds the scenario.

## Why the harness cannot express it today

Two separate obstacles, both of which must be removed:

**1. Nothing gates peer-to-peer contact.** Every cross-peer path in `test/simulation/fret-sim.ts`
reaches the other peer unconditionally, and several bypass the message bus entirely:

| Site | What it does today |
|---|---|
| `handleConnect` (~336) | samples from *every* alive peer globally |
| `exchangeNeighborsDirect` (~497) | writes straight into the other peer's store (instant mode) |
| `sendNeighborSnapshots` (~473) | sends via bus, but also *reads* the neighbor's store directly to build its reply |
| `handleLeave` (~358) | fans notices to every alive peer (both bus and instant arms) |
| `handleRoute` (~552) | hops to any candidate the store names |
| `processDeliveredMessage` (~302) | delivers whatever was queued before a cut |

Setting a per-link `lossRate: 1.0` through `SimMessageBus.setLink` only covers the two bus arms;
the direct-store arms would carry state across the cut regardless, so a partition modelled that
way would silently not be a partition.

**2. Nothing prunes an unreachable-but-alive peer.** The sim's only liveness signal is the global
`alive` flag. A partitioned peer is alive, so each half keeps the other half in its neighbor sets
forever — coverage would not move, and a partition assertion would measure nothing. The harness
needs the escalation `docs/fret.md` describes (*Stabilization and churn handling* → hard failure)
before "the ring healed around the split" is an observable event at all.

## Design

### Reachability is one predicate, consulted by every cross-peer site

```ts
// fret-sim.ts
partition(groups: ReadonlyArray<ReadonlyArray<string>>): void
heal(): void
private reachable(a: string, b: string): boolean
```

- State is `private partitionOf = new Map<string, number>()`, peer id → group index.
- `reachable(a, b)` is `true` when the map is empty (no partition active) or when both ids resolve
  to the same group. An id absent from the map resolves to group `0` — so a peer that **joins
  while a split is active lands in the first group**. That is a stated default, not an accident:
  a new node bootstraps against whoever it can reach, and group 0 is the harness's stand-in for
  "the side the bootstrap list points at".
- `heal()` clears the map. Calling `heal()` with no partition active, or `partition(...)` twice
  without an intervening heal (the second call replaces the first), are both defined no-throw
  operations.
- Every site in the table above consults `reachable` — including the *direct store reads* in
  `sendNeighborSnapshots` and `exchangeNeighborsDirect`, since those model the far peer
  *responding*, not merely our send.
- `processDeliveredMessage` drops a message whose endpoints are no longer mutually reachable:
  a cut applies to traffic already in flight, and counts as a drop (`MetricsCollector.recordMessageDrop`).
- Expose `crossPartitionBlocked(): number` — a count of contacts refused by the predicate — so the
  spec can assert "nothing crossed the cut" directly rather than inferring it from store contents.

### Failure escalation reuses the real store fields, not a parallel map

`DigitreeStore` already carries `state` and `contactFailures`, so the sim models liveness with the
production representation rather than a second one:

- During `handleStabilize`, a peer attempting contact with a neighbor it cannot reach does
  `store.update(id, { contactFailures: n + 1 })`; at `deadAfterFailures` (default 3, overridable
  via a new optional `SimConfig.deadAfterFailures`) it calls `store.setState(id, 'dead')`.
- One strike per stabilization tick per neighbor. Production requires strikes to be ≥ 500 ms apart
  (*Ring membership* → why the run must be spread over time); tick spacing is ≥ the stabilization
  interval, so that rule holds by construction here — say so in a comment rather than re-implementing
  the spacing check.
- A successful contact resets `contactFailures` to 0.
- Ring-shaped reads in the sim pass a `state !== 'dead'` filter into
  `neighborsRight`/`neighborsLeft` (both already take an optional `filter` — `digitree-store.ts:349,373`).
  Sites: neighbor computation in `handleStabilize`, `collectSnapshotEntries`, `snapshotCoverage`,
  `deadNeighborRatio`, and the routing candidate list in `handleRoute`. The sim does not model
  `membership`, so this filter is liveness only.

### Healing needs a re-probe path, or the merge half is untestable

Once each side marks the other dead, nothing would ever contact it again — the same trap production
solves with the dead arm of the re-probe pass (*Ring membership* → *Re-probe passes*). Mirror it
minimally: each stabilization tick, each peer re-probes up to `deadReprobePerTick` (default 2) of
its own dead entries; a reachable one goes back to `state: 'disconnected'` with `contactFailures: 0`.
Order candidates by **ascending `lastAccess`** so a truncated pass rotates instead of re-deriving
the same head — the same rule the production pass states for its own budget slice. The sim has no
backoff model and does not need one; note that difference in a comment.

### Coverage must be measured against what each peer can reach

`snapshotCoverage()` divides by the global alive count. Under a 50/50 split that caps coverage at
~0.5 by construction, so a "the ring healed" assertion would be measuring the split, not the healing.
Give the ideal denominator a per-peer reachable-alive population instead. **Hard requirement: with
no partition active the returned number must be identical to today's**, since the existing
`simulation.spec.ts`, `churn-scenarios.spec.ts` and `message-bus.spec.ts` thresholds are calibrated
against it. Verify by running those three specs unchanged.

## Interaction with `24-sim-router-realism`

That ticket owns the same file and plans to replace the oracle-assisted routing filter and the
churn scheduling. This work lands first (lower sequence). Two contact points to leave in good shape:

- The `reachable` predicate is the seam that ticket's local-knowledge routing must also honour —
  a hop is only a hop if the two peers can contact each other. Leave it as a single private method
  with no call-site copies.
- The `state !== 'dead'` ring filter added here is *not* the global `alive` oracle that ticket
  objects to; it reads only what the probing peer's own store recorded. Do not fold the two
  together, and do not remove the existing global-`alive` prune loop — retiring that belongs to 24.

## Edge cases & interactions

- **Unbalanced split (1 peer vs N−1).** The singleton's live neighbor set empties. Coverage for it
  must be defined (no division by zero, no `NaN` propagating into the average), and it must recover
  fully after `heal()`.
- **In-flight messages at the moment of the cut** are dropped on delivery, not delivered late.
- **Messages in flight at the moment of `heal()`** — any sent before the heal were already dropped;
  healing must not resurrect them.
- **Churn during a partition.** A leaver on side A produces notices only within A; side B discovers
  the departure through its own failure escalation, not through a notice. A joiner during a split
  lands in group 0 per the stated default.
- **`heal()` without `partition()`**, and `partition()` replacing an active partition, are no-ops /
  replacements rather than throws.
- **Three-way split.** The API takes N groups, not two; assert at least one three-group case so the
  predicate is not silently two-valued.
- **A peer listed in two groups** is a caller error — last write wins, and it must not corrupt the
  map. State the rule; a throw is also acceptable if stated.
- **Determinism.** Two runs at the same seed with the same partition/heal schedule must produce
  identical metrics — the harness's existing property (`message-bus.spec.ts:153`), which must
  survive the new mutable state.
- **Existing suites unchanged.** `simulation.spec.ts`, `churn-scenarios.spec.ts`,
  `message-bus.spec.ts`, `sim-profiles.spec.ts` must pass without edits to their thresholds. Any
  threshold that has to move is evidence the "no partition ⇒ unchanged coverage" rule was broken.
- **Wall-clock.** Keep the new spec inside the runner's window; N ≈ 40 with a 500 ms stabilization
  cadence over three phases is enough. Do not add an N=100 partition case.

## Key tests and expected outputs

New file `test/simulation.partition.spec.ts`, one seeded ring (N ≈ 40, k 15, m 8, no churn) run in
three phases — converge, cut, heal:

- **Baseline.** After convergence, coverage ≥ the threshold the existing suites use, and a route
  from a group-A peer to a coordinate owned by a group-B peer succeeds.
- **Nothing crosses the cut.** After `partition([A, B])` and several ticks,
  `crossPartitionBlocked() > 0`, and no store on side A holds a *live* (non-dead) entry for any
  side-B peer.
- **Each half re-forms its own ring.** Within `deadAfterFailures` ticks, cross-side entries are
  `dead`; coverage measured per reachable population returns to the baseline threshold on both
  sides.
- **Routing respects the cut.** An A→B route fails (`recordRoute(false, …)`); an A→A route still
  succeeds.
- **Merge.** After `heal()` and several more ticks, cross-side entries return to `disconnected`
  via the re-probe path, whole-ring coverage returns to the baseline threshold, and an A→B route
  succeeds again.
- **Singleton split.** `partition([[oneId], everyoneElse])` — the singleton's live neighbor count
  reaches 0 with coverage well-defined, and returns to the baseline after `heal()`.
- **Three-way split** heals from all three groups at once.
- **Determinism.** Same seed, same schedule, two runs → deep-equal metrics.

## TODO

- Add `partitionOf` / `partition()` / `heal()` / `reachable()` / `crossPartitionBlocked()` to `FretSimulation`.
- Route every cross-peer site through `reachable` (the six in the table above), including the direct store reads.
- Drop cross-partition messages at delivery and count them as bus drops.
- Add contact-failure escalation to `handleStabilize` using `contactFailures` + `setState('dead')`, with `SimConfig.deadAfterFailures` (default 3).
- Pass a `state !== 'dead'` filter into every ring-shaped read in the harness.
- Add the bounded dead-entry re-probe (`deadReprobePerTick`, default 2, ascending `lastAccess`).
- Rework `snapshotCoverage` to a per-peer reachable population; confirm the no-partition value is unchanged.
- Write `test/simulation.partition.spec.ts` with the cases above.
- Run `simulation.spec.ts`, `churn-scenarios.spec.ts`, `message-bus.spec.ts`, `sim-profiles.spec.ts` unchanged and confirm green.
- Update `docs/fret.md` — *Testing strategy* — to name the new spec as what pins partition/merge, in the same "behavior, then the spec that pins it" style the rest of the document uses.
- `npx tsc --noEmit` and the full `yarn test` from `packages/fret/`.
