description: Converge on a bounded network size consensus via signed observations exchanged in neighbor snapshots
dependencies: 5-transport-identity-verification (observations must come from verified identities), 4-replay-dedup-hardening (timestamp tightening)
files: src/estimate/size-estimator.ts, src/service/fret-service.ts (reportNetworkSize ~line 1061-1078, getNetworkSizeEstimate, snapshot ~line 814), src/rpc/neighbors.ts, docs/fret.md
prereq: message-signatures
tradeoffs: Adds a signed observation array to every snapshot — more bytes, more verification — to defend an input whose current failure mode is a mis-sized cluster span rather than a breach; a maintainer may prefer to first land the estimator accuracy fixes already queued (fix/12-size-estimator-fixes) and see whether purely local estimates are then good enough.
----

### Problem

Network size estimation is currently local-only with lightweight sharing. Each peer computes `n_est = 2^256 / median_gap` from its own Digitree, and `NeighborSnapshotV1` carries optional `size_estimate` and `confidence` fields. `reportNetworkSize` accepts external estimates but with no authentication — any code path can inject arbitrary values (threat-analysis.md §2.4).

Without agreement on network size, peers cannot independently assess whether a ring region is over- or under-populated. This is a prerequisite for density anomaly detection and constrained join (see `3-constrained-join-neighbor-attestation`).

### Added evidence — the local estimate got cheaper to manipulate (from review of `size-estimator-fixes`)

The estimator accuracy fix this ticket's `tradeoffs:` line hoped might make local estimates
"good enough" has landed, and it moves the manipulation cost the wrong way. Two changes:

- The gap population is no longer every entry in the store (capacity 2048). It is the
  successor/predecessor window: `2m + 1` coordinates immediately around the node's own ring
  position, 17 at the default `m = 8`. Entries outside that window contribute nothing to
  `n_est`, so an attacker no longer needs to out-number the store — they need coordinates
  nearer the victim than the victim's own neighbours.
- The statistic is the arithmetic mean of those gaps, not the median. The mean has a breakdown
  point of zero, so each admitted Sybil moves it by roughly `1/2m` (~6%), and on the order of
  `m` of them move `n_est` by a factor of two. The median needed roughly half the population.

This is the same precondition as an eclipse, so it is not an independent attack — but it does
mean the local statistic has no outlier resistance left to fall back on, which strengthens the
case for this ticket rather than weakening it. `docs/threat-analysis.md` §2.4 has been corrected
to say so. A related blind spot is recorded as a `NOTE:` at `dispersionFactor` in
`src/estimate/size-estimator.ts` and pinned by the test
`KNOWN BLIND SPOT: an eclipsed neighbourhood scores high confidence on a wrong n`
(`test/size-estimator.spec.ts`): confidence is computed from spacing regularity *within* the
sampled arc, so an evenly-spaced attacker band scores ~0.875 while `n_est` is off by ~1000x.
Whatever consensus this ticket lands should therefore also feed the reported **confidence**, not
only the size.

### Approach

Evolve the existing estimate sharing into a lightweight bounded gossip protocol:

- Each peer computes a local estimate from its Digitree gaps (existing `estimateSizeAndConfidence`).
- Peers include **signed** `(peerId, estimate, confidence, timestamp)` observations in neighbor snapshots. The signature ties the observation to a transport-verified identity.
- Recipients maintain a collection of recent observations from **distinct** peers, weighted by:
  - Observer confidence (existing field)
  - Observer age/reputation (longer-lived peers weighted higher to resist Sybil ballot-stuffing)
  - Recency (decay stale observations)
- The consensus estimate is the **weighted median** of qualifying observations, with a validity window and a minimum contributor count threshold before it's considered authoritative.
- Outlier rejection: observations that deviate more than a configurable factor (e.g., 3x) from the current consensus are discarded and the sender flagged.

### Expected behavior

`getNetworkSizeEstimate` returns an estimate that reflects observations from multiple independent peers, not just the local Digitree. The estimate is resistant to manipulation by a minority of Sybil nodes because:

1. Observations are signed and tied to transport-verified identities (can't forge observations from other peers).
2. Weighted median is robust to outliers — an attacker needs to control a majority of *observed* peers to shift the median significantly.
3. Age/reputation weighting means freshly-joined Sybils contribute less than established peers.

The consensus estimate becomes an input to density anomaly detection and constrained join decisions.

### Wire format extension

The `size_estimate` and `confidence` fields in `NeighborSnapshotV1` already exist. Extend with a small array of recent peer observations:

```
size_observations?: Array<{
  peer: string;          // observer peer ID
  estimate: number;      // their local n_est
  confidence: number;    // their local confidence
  timestamp: number;     // observation time
  sig: string;           // signature over (peer, estimate, confidence, timestamp)
}>;
```

Cap the array size in profile bounds (e.g., Edge: 4, Core: 8) to limit snapshot bloat. Peers gossip a rotating subset of their collected observations, converging network-wide over several stabilization cycles.

### Threat references

- threat-analysis.md §2.4 (High): Network size estimate manipulation — direct fix
- threat-analysis.md §1.1 (Critical): Sybil flood — consensus size enables density detection
- threat-rir-mitigated.md §2.4: Unchanged by RiR
