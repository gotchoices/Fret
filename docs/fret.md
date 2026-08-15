### FRET: Finger Ring Ensemble Topology (Chord-with-Fingers libp2p overlay for Optimystic)

This document proposes FRET, a Chord-style ring overlay with symmetric successor/predecessor neighbor sets and logarithmic fingers, optimized for fast discovery, low chatter, and robustness under churn. FRET replaces reliance on libp2p's KadDHT for our use-cases (cluster lookup, coordinator selection, and routing hints), while remaining transport-agnostic and libp2p-compatible.

---

### Goals
- Provide discovery and routing for libp2p services without proof-by-exhaustion queries.
- Deterministic or high-probability cluster construction even when n < k.
- Minimize processing and bandwidth; support rapid expansion/shrink (minutes-scale churn).
- Symmetric neighbor sets (successors and predecessors) to maximize overlap and routing resilience.
- One-pass, unified discovery+activity path: route towards cluster and embed the activity once "near enough."
- Local test for in-cluster membership; avoid expensive global searches.

### Identifier space and hashing
- Peer ID: fixed-length ring coordinate r(peer) = SHA-256(peerId.multihash.bytes) truncated/expanded to B bits
- Key coordinate: r(key) = SHA-256(keyBytes) using the same hash family as peers
- Ring arithmetic: all comparisons are modulo 2^B where B = 256 bits
- Distance metric: d(a,b) = min(clockwise_distance(a,b), counterclockwise_distance(a,b))
- **One metric, everywhere.** `min(cw, ccw)` (`minDistance`) is the *only* distance function in FRET: neighbor/cohort walks, next-hop selection (both the cost path and the legacy connected-first path), the payload-inclusion heuristic, and the relevance sparsity model all measure with it. The wrap-around point therefore behaves like every other point on the ring — two coordinates straddling it are adjacent, as they should be. A bit-XOR metric is *not* interchangeable here: it treats the identifier space as a bit-tree, so it maximizes exactly where arc length minimizes, and its magnitudes are incommensurable with the ring-circumference-derived thresholds (cluster span, near-radius) they would be compared against. See `test/ring-wrap-distance.spec.ts` for the seam vectors that pin this down.
- Because it is the *shorter* of the two arcs, ring distance maxes out at 2^(B−1) = 2^255, not 2^256 − 1.
- Tie-breaking: when equidistant, prefer lexicographic order of peer IDs. Unlike XOR, ring distance is not unique per coordinate — one peer clockwise and one counter-clockwise can sit at the same arc length — so this tie-break is load-bearing, not decorative.

### Overlay model: Ring with symmetric neighbors and optional fingers
- Successor set S(p): the next m peers clockwise after p (m = ceil(k/2) by default).
- Predecessor set P(p): the previous m peers counterclockwise before p (m = ceil(k/2)).
- Finger cache: Ordered B+Tree which maintains all known peers in a single ordered index keyed by ring coordinate.  Approximates a finger-table. Secondary index by relevance score (see below) for bounded capacity and victim selection.
- Maybe these are all part of the same cache set, and the successor and predecessor sets just have infinite relevance.

### Relevance scoring and table management
- The routing table has a hard capacity C. When over capacity, evict the lowest-relevance entries.
- Components (bucketless, sparsity-weighted):
  - Access recency (EMA decay) and frequency (log-slowing).
  - Health: success/failure ratio and average RTT.
  - Sparsity bonus over distances: maintain a smooth blend of distances without hard buckets.
    - Compute normalized log-distance x ∈ [0,1] from self to peer (1 = far, 0 = near).
    - Maintain a tiny KDE over x with m fixed centers and EMA occupancy.
    - Sparsity bonus S(x) = clamp(((ideal(x)+ε)/(density(x)+ε))^β, sMin, sMax).
    - This increases score for underrepresented distances and tapers overrepresented ones.
  - Neighbors: entries in S(p) ∪ P(p) are always retained unless explicitly dead.
- Victim selection: lowest score first.

### Join and bootstrap
1. New node chooses any reachable bootstrap peer(s).
2. Bootstrap queried for nearest to destination (new node's ID). Flag also requests a sampling of cached nodes (to seed the new node's cache). The sample is sparsity-weighted (`selectDiverseSample`): candidates are scored by the sender's sparsity bonus over ring distance and the top entries returned, biasing toward under-represented ring regions rather than peers clustered near the sender. Successor/predecessor members are excluded from the sample since they are already carried in their own snapshot fields.
3. New node incorporates cache (evicting if needed by relevance), dials nearest peer(s) to ID, and repeats until neighborhood reached.
4. Neighborhood detection: when self appears in the two-sided cohort of size m for its own ID
5. Once in neighborhood, performs stabilization (see below) and announces presence to S/P sets
6. Hot-transaction seeding (non-FRET but incorporating hooks): neighbors send recent pend/commit deltas for blocks whose key ranges intersect the new node's responsibility zone. Bounded by rate, size, and time.

### Stabilization and churn handling
- Periodic stabilization (every Ts):
  - Verify reachability of entries in S(p) and P(p); replace failed ones with next best candidates from the Digitree. If incoming message exchange received since last stabilization, skip verification.
  - Exchange compact neighbor snapshots with immediate successors and predecessors; merge deltas.
  - Opportunistically probe a few finger candidates per cycle (budgeted) to maintain logarithmic reachability.
- Failure detection and recovery:
  - Soft failure (timeout): decay relevance score by factor δ (e.g., 0.7); retry with exponential backoff
  - Hard failure (3+ consecutive timeouts or explicit error): remove from S/P; mark as dead in Digitree
  - Recovery: on successful contact after failure, reset relevance score to baseline
- Symmetry: maintain |S(p)| = |P(p)| = m by filling gaps from Digitree candidates

## Leave
- Graceful departure protocol:
  1. Send leave notification to all S(p) ∪ P(p) with suggested replacements from Digitree
  2. Transfer hot transactions and pending state to successors
  3. Notify any connected peers outside S/P before disconnecting
- Recipients of leave notification immediately remove departing peer and probe suggested replacements

### Determining cluster membership and coordinator (two-sided cohort)
- The cohort and its anchors are drawn only from same-network **members** (see *Network-scoped admission*): the alternating walk skips `foreign` / `unknown` entries, so a co-resident foreign network never contributes a cohort member, anchor, or coordinator for this network.
- Two anchors: aSucc = successor(h); aPred = predecessor(h).
- Cohort build (alternating two-sided): [aSucc, aPred, succ¹(aSucc), pred¹(aPred), …] until we collect min(k, n) unique peers, or satisfy a caller-provided wants ≤ k.
- Local membership test: peer p locally computes the alternating two-sided cohort using its S/P index and checks if p is within the first k (or wants) entries.
- Handling n < k: the alternating walk yields min(n, k); quorum adapts automatically.
- Coordinator: not required to be deterministic; any in-cluster member the search lands on may coordinate with threshold signatures.

#### Flexible cohort and thresholding
- The cohort is a means to gather a minimum number of signatures (minSigs = k−x); exact membership may vary slightly across peers due to view differences.
- If some candidates return erroneous validations or are unavailable, they are filtered out and the cohort expands outward symmetrically until minSigs is reached.
- Repository constraint: the cohort must include peers that can serve/commit the target block's repo; if a newly included peer lacks required state, it may sync-on-demand before validating.
- Policy vs primitives: FRET exposes primitives to assemble two-sided cohorts, expand/filter, and provide successor/predecessor walks. Higher layers configure k, x, and repo sync policies.

### Unified find+maybe-act RPC
Single pipeline for discovery and action:
- RouteAndMaybeAct { key, wantK, wants?, ttl, minSigs, digest, activity?, breadcrumbs[], correlationId }
  - key: content key or transaction-affinity key
  - wantK: target cluster size k (or min quorum requirements)
  - wants: optional number of peers requested (≤ k) for partial cohorts or staged discovery
  - ttl: hop/time budget
  - minSigs: num required activity signatures (k−x)
  - digest: lightweight summary (for non-in-cluster probes)
  - activity: optional payload (pend/commit). Included when near enough by size/distribution estimate
  - breadcrumbs: the peers this *message* has already passed through, to prevent loops and provide traceability. A receiver that finds itself in the trail treats the message as a loop and answers with an *empty* NearAnchor (see *Cheap-guard rejections* below) — no routing hint at all — so a message must **never** carry its own destination. That matters most on the activity resend: its destination is normally the peer that just answered the probe (it named itself as an anchor — that is the point of the two-phase flow), so stamping that peer into the trail would make it refuse the resend as a loop and the activity would silently never run. The resend carries the probed peer only when it is resending to a *different* anchor, where it is a genuine "don't bounce back" hint.
  - correlationId: identifies a request **phase**, not a whole lookup. A find-then-act lookup mints two: one shared by every digest-only probe it sends, one shared by every activity-bearing message. Each is minted once per lookup (not per message), which is what makes a retry idempotent — a peer that already performed the work recognises the repeat and returns its stored certificate rather than doing it twice.

Routing rule:
1. If local membership test says "in-cluster":
   - If activity included: perform activity (callback) given the two-sided cohort (expand/filter as needed to satisfy minSigs), then return commit certificate
   - If no activity: reply with NearAnchor { anchors, cohortHint: PeerId[], estimatedClusterSize, confidence } inviting a resend with activity
   - **Anchors are measured against the key's own coordinate.** The candidate pool is the key's successor and predecessor windows, and the two anchors are the pool's *closest* members to the key (connected peers preferred when distances are within a byte, per the next-hop heuristic) — not one from each side. Both anchors may therefore sit on the same side of the key; anchors are routing hints, and being nearest the key is what makes the resend land in-cluster. Measuring from any fixed point instead (self, or the all-zero coordinate) silently returns whichever peers happen to have numerically small coordinates, which is a correctness bug, not a bias — see `test/pick-anchors.spec.ts`.
   - Cache result to handle duplicate requests, keyed on correlation ID **and phase** (digest-only vs activity-bearing). Keying on the ID alone is wrong: the probe and the resend that follows it share an ID, so the probe's NearAnchor would be served as the answer to the message carrying the work and the activity would never run. Since the responder's own anchor list normally names itself, that resend usually arrives right back at the peer holding the probe's cache entry. The phase is read off the message's `activity` field; the payload itself is not hashed into the key, so a re-encoded-but-equivalent retry still hits the cache instead of re-performing the work.
   - **Only a terminal answer is cached.** For a digest probe the NearAnchor *is* the answer. For an activity-bearing message a NearAnchor is a refusal — "I did not perform the work; the ring says try over there" — returned when no activity handler is installed, or when the peer is not in-cluster and its forward found no hop or failed. Storing a refusal would answer every retry of that work for the cache TTL with the same refusal and lose the activity silently, which is the phase-collision failure one level in. So an activity-bearing message caches only a commit certificate. The cost is that a replayed activity can re-drive a forward attempt; that is correct, because the work was never performed, and TTL decrement, breadcrumbs and the rate-limit bucket already bound it.
2. Else (not in-cluster): forward towards h by choosing the next hop that minimizes absolute ring distance to h using S/P (and optional finger cache). Optionally attach redirect hints (local near-h successors/predessors) to speed convergence.
   - Next-hop selection heuristic (connected-first bias):
     - Define cost(peer) = w_d·normDist(h, peer) − w_conn·isConnected(peer) − w_q·linkQuality(peer) + w_b·backoffPenalty(peer).
     - normDist scales absolute ring distance by the estimated network size N_est; use a "near radius" r_near ≈ (ringCirc / N_est)·β to detect proximity to the neighborhood.
     - When far (dist > r_near): allow slack ε_far in distance improvements; prefer already-connected peers even if slightly farther.
     - When near (dist ≤ r_near): require strict distance improvement (ε_near ≈ 0); prioritize most proximal candidates even if disconnected.
     - **In near mode, strict improvement is measured against the node's own distance to the key, not merely among the candidates.** The selector is given the node's ring coordinate; when the node itself is within r_near of the key, only candidates strictly closer to the key than the node are eligible. Ordering candidates against each other cannot see this — with every near candidate sitting behind the node, the closest-of-a-bad-set is still a hop *away* from the key, so messages drift backwards and only breadcrumbs plus TTL stop the loop. In near mode, forward progress is therefore a property of the selector rather than of the loop guards.
     - **Far mode has no such floor, and today that is a gap, not a design choice.** The connected-peer bonus (w_conn ≈ 0.3–0.5) dwarfs the distance term's resolution: normDist is a log-scale position, so one binary order of magnitude of ring distance is worth only w_d/256 ≈ 0.002. A connected candidate therefore outranks a disconnected one that is over a hundred binary orders closer — far beyond the "slightly farther" slack the bullet above describes, and with nothing stopping the chosen hop from being farther from the key than the sender. Because r_near saturates the whole ring below n_est ≈ 2·β·k (≈60 at the defaults), far mode is unreachable on small rings and this only bites at scale. Tracked in `tickets/` as the far-mode self-distance floor; the invariant worth having is one floor applied in *both* modes.
     - When no near candidate qualifies, the selector yields **no hop** — there is deliberately no fall-through to far mode, since every far candidate lies beyond r_near ≥ the node's own distance and is therefore guaranteed worse than staying put. No hop is an outcome both callers already handle: `routeAct` answers with a NearAnchor (hints, not a backwards hop) and `iterativeLookup` reports `exhausted`. A near node with nothing better than itself stops and hands back hints.
     - The node coordinate is optional to the selector and is supplied **only on the forwarding path**, because that is where backwards drift compounds into a loop. A node *originating* a lookup is aiming at the key's **cluster** — the k peers nearest the key, spanning both sides — not at the key point, so an originator that is itself the peer nearest the key must still contact a cluster member, and every one of them is farther from the key than it is; filtering there does not prevent a loop (the lookup's own already-contacted set does that) and only refuses to send, silently dropping the activity. Anchor selection for a NearAnchor reply never reaches this code at all — it calls the selector with no options and so runs the legacy connected-first path, where the node coordinate is ignored; that is fine, since anchors rank peers by closeness to the key as a hint for *another* peer's resend.
     - The forwarding path is also the case where withholding costs nothing: a node forwards only when it is *not* in-cluster, i.e. it sits at index ≥ 2 of the key's alternating two-sided cohort, which puts at least one peer (the nearer of the two anchors) strictly closer to the key than it is. A strictly-improving hop therefore normally exists, and no-hop means the closer peers were all excluded as breadcrumbs or undialable — a genuinely exhausted local view.
     - Confidence-aware: when confidence is low, increase w_conn and reduce reliance on distance; when high, increase w_d and tighten ε_near. Update penalties as observations arrive.
3. TTL guards prevent loops; breadcrumbs help diagnose route quality.

Cheap-guard rejections (ordering vs the rate limit):
- **The maybeAct token bucket is taken first, before any per-message work at all** — before the breadcrumb-loop check, the dedup lookup, the timestamp check, the TTL check and the payload-size check. Any other order leaves the guards themselves unmetered, so a flood of trivially-invalid messages (stale timestamp, `ttl: 0`) would never touch the bucket while still costing the receiver per-message work. A message rejected by a guard therefore spends a token exactly like a valid one; the reply on an empty bucket is the usual `Busy` + `retry_after_ms`.
- **A guard rejection is a static, zero-computation reply**: a `NearAnchor` with empty `anchors` / `cohortHint` and `estimatedClusterSize`/`confidence` of 0. It deliberately does *not* compute real anchors, because that hashes the key and walks the ring twice — the very per-message cost the bucket exists to bound. The sender loses the routing hint it used to get on these paths and falls back to its own local cohort for the next attempt, which is the accepted price.
- Real anchors are computed on a rejection in exactly one case: `routeAct` throwing unexpectedly. That happens *after* the token was spent and real routing was attempted, so a best-effort answer is worth its cost there.
- A guard rejection is never cached: it is not a terminal answer for the message's phase (see the dedup rule above).

Payload inclusion heuristic:
- Maintain (sizeEstimate, confidence). Include activity if probability of being in-cluster ≥ threshold T based on distance to h vs expected cluster span and confidence.
- Otherwise send digest-only to get redirects/hints, then resend with activity when near.

### Reputation and exclusions (later phase)
- Local scoring for misbehavior (invalid validations, equivocation) increases penalty; above threshold excludes from S/P and routing decisions.
- Gossip of signed evidence remains optional; local autonomy preserved.
- Cluster expansion compensates for excluded peers to maintain k where possible.

### Network size estimation
- **Member-scoped.** The estimate counts only this network's members (`membership === 'member'`), so a co-resident foreign network sharing the transport cannot inflate `n_est` or the derived cluster span / near-radius. `estimateSizeAndConfidence` takes an optional member filter that `FretService` supplies; the exported standalone defaults to counting every entry, leaving the simulator unaffected.
- Maintain online estimate (n_est, confidence ∈ [0,1]):
  - Arc length method: average gap between consecutive S/P members; n_est = 2^B / avg_gap
  - Finger sampling: probe random points, measure hop counts; use exponential decay model
  - Weighted average of both methods; weight by method confidence
  - Peer-reported estimates: when a received `NeighborSnapshotV1` carries `size_estimate` and `confidence` (both positive), the receiver feeds them into its local estimator as an external observation (`reportNetworkSize`, source `snapshot:<peerId>`). This happens on both the announce path (`mergeAnnounceSnapshot`) and the fetched-neighbor path (`mergeNeighborSnapshots`). Snapshots advertise the sender's *raw* FRET-local estimate (not its blended `getNetworkSizeEstimate`), so blending received estimates does not re-amplify already-blended values. Observations are bounded by a sliding time window and a max count. NOTE: these reports are unauthenticated — see the planned size-consensus / bounded-gossip work in `tickets/` for Sybil-resistant aggregation.
- Confidence calculation:
  - Base confidence from sample count and recency
  - Zero if disconnected from bootstrap or |S∪P| < m/2
  - Decay by factor 0.95 per minute without updates
- Usage:
  - Operations require min confidence (e.g., 0.3) to proceed
  - Cluster span estimate = k * (2^B / n_est)
  - Near-radius r_near = β * cluster_span where β ∈ [1.5, 3]

### libp2p integration
- Discovery: implement a libp2p peerDiscovery-compatible interface backed by FRET's Digitree. Emits peers from S/P/F (pruned, debounced). **Member-only**: both the periodic `FretPeerDiscovery.scan` and `FretService.emitDiscovered` emit only `member` peers, so a foreign peer is never surfaced to libp2p's discovery pipeline (which would re-seed it into selection upstream). `scan` re-scans the whole store each tick, so a peer is emitted as soon as the probe pass classifies it `member`.
- Protocol IDs and message formats (length-prefixed UTF-8 JSON):
  - /fret/1.0.0/neighbors - JSON-encoded NeighborSnapshot
  - /fret/1.0.0/maybeAct - JSON-encoded RouteAndMaybeAct
  - /fret/1.0.0/leave - JSON-encoded LeaveNotice
  - /fret/1.0.0/ping - JSON-encoded PingLite
- Stream management:
  - Max inbound: 32 (Edge) / 128 (Core)
  - Max outbound: 64 (Edge) / 256 (Core)
  - Stream read deadline: one overall budget per read (`readAllBounded`, 5s default, uniform across the four RPCs today). There is deliberately **no** per-chunk idle timer — a gap between chunks is a slow link, not end-of-stream, and an idle timer truncated healthy transfers into malformed JSON and failure-scored the (healthy) sender. libp2p v3's `close()` half-closes, so `iter.next()` resolves `{ done: true }` on genuine EOF; the overall deadline is what bounds a peer that stalls mid-payload. Exceeding it throws a read-timeout error rather than returning the partial buffer, so a timeout is never mistaken for a short-but-valid message.
  - Multiplexing: reuse streams for multiple requests where possible
  - Snapshot caps: successors/predecessors/sample are profile-bounded (Edge ≤ 6/6/6, Core ≤ 12/12/8)

### Dialability (can we reach this peer at all?)

Every FRET outbound RPC funnels through one seam, `openRpcStream`: reuse an open connection if there is one, otherwise `dialProtocol` with a **bare peer id**. FRET never learns or stores multiaddrs — its wire messages carry peer-id strings only — so a bare-id dial succeeds only when libp2p's own peerStore already holds an address for that peer, learned by libp2p (identify over a direct connection, a bootstrap entry, a transport's discovery) and never by FRET. For a peer known only through FRET gossip it does not, and the dial fails with `NoValidAddressesError`.

So "**has addresses**" throughout this document means precisely: *the libp2p peerStore holds at least one multiaddr for this peer*. A peer is **dialable** when it is either currently connected or has addresses. Fixing dialability makes the *skip decision* correct; it does not by itself make more peers reachable (that is address-hint propagation, which FRET does not do today).

- The service answers `hasAddresses` from a local id set rather than reading `peerStore.get` per call, because every caller is a synchronous filter predicate while the peerStore API is async. The set is rebuilt wholesale from the `peerStore.all()` walk the stabilization tick already performs (so it is bounded by peerStore size and prunes itself), and refreshed per-peer on `peer:identify` / `peer:update` so a freshly-learned address is usable before the next tick.
- **Maintenance paths skip an undialable peer** — leave notices, replacement warm-up, announces, probe passes. Attempting the dial can only end in `NoValidAddressesError`, and on the `stop()` path a stack of them also delays shutdown.
- **Routing paths filter into the walk, never out of the result.** `routeAct` and `iterativeLookup` build their candidate list with dialability composed into the ring walk's own predicate alongside the member gate (`e => isMember(e) && isDialable(e.id)`), so the selector picks the best *reachable* hop instead of dead-ending a route that still had usable hops behind it — the same rule as the breadcrumb/cohort exclusions. Post-filtering the assembled cohort instead would shrink it below the requested count, and to empty when the peers nearest the key happen to be unreachable. (Anchor ids returned in a `NearAnchor` reply are a plain list rather than a sized walk, so those *are* filtered directly; an emptied anchor list falls back to the local cohort.) Only a genuinely empty candidate set falls through to the existing `NearAnchor` / `exhausted` outcomes. A hop skipped for unreachability is **not** a negotiate-failure strike: an unreachable peer is not evidence of a foreign one.
- **Announce is the one path that dials on purpose.** `announceNeighbors` is connection-only by default (`requireExisting`); the service's announce choke point passes `dial: true` because those target lists deliberately *prefer* non-connected peers — a connected peer learns the same content through normal exchange. That choke point applies the dialability guard and checks it before spending an announce token, and additionally skips a `foreign` peer: announce targets walk the store unfiltered so a freshly-connected `unknown` peer is not stalled, but dialing a peer already proved to serve another network can only return `UnsupportedProtocolError`.

### Ring membership (same-network vs foreign)
Every FRET RPC is namespaced by network: the wire protocols are `/optimystic/${networkName}/fret/1.0.0/{neighbors,maybeAct,leave,ping,...}`, so two services with different `networkName`s cannot negotiate each other's protocols. The routing table, however, is populated by network-agnostic libp2p signals (peerStore, `peer:connect`, bootstraps, neighbor snapshots). In a deployment where one libp2p node hosts several control networks over a shared transport, a peer that participates only in *another* network is, at the libp2p level, a fully-connected peer — admitted to the table but unable to serve this network's protocols.

To distinguish these, each routing-table entry carries a tri-state `membership` label:

- **`unknown`** — freshly discovered, not yet classified (the default on insert).
- **`member`** — confirmed to serve this network's FRET protocol.
- **`foreign`** — confirmed NOT to serve it (belongs to another network).

The tri-state (rather than a boolean) keeps a same-network peer whose `identify` hasn't completed (legitimately `unknown`) distinct from a confirmed-foreign peer, so the former is never starved.

#### Evidence strength (how labels are resolved)

Membership evidence has a **strength ordering, and a weaker or staler signal never overrides a stronger, more recent one.** In one line: **`member` is only ever set by positive proof, and only ever cleared by repeated direct proof of absence.**

| Signal | Strength | What it actually proves | May set |
|---|---|---|---|
| Completed **outbound** namespaced RPC (ping / maybeAct) | strong | The remote served this network's protocol just now | `member` |
| **Inbound** namespaced RPC from a transport-authenticated sender | strong | The remote dialed this network's protocol just now | `member` |
| `identify` protocol list containing one of ours | strong (positive only) | The remote advertised our protocol as of capture time | `member` |
| `identify` protocol list containing none of ours | weak | What the remote advertised *at capture time* — may predate our own handler registration | `foreign`, only from `unknown` |
| One "could not negotiate" failure | weak | The remote had no answerable handler *at that instant* | nothing on its own |
| N time-separated "could not negotiate" failures (N = 3) | strong | The remote persistently does not serve this network | `foreign` |

Every classification routes through a single guard on `FretService` (`applyMembershipSignal(id, signal)`), so the ordering is stated once and a call site added later inherits it rather than repeating the bug it exists to prevent. Concretely:

- **Self** is always `member` (seeded at the self-upsert site).
- **Successful namespaced RPC → `member`.** Any completed ping / maybeAct over this network's protocols proves membership; normal traffic confirms members for free, and also resets the consecutive-failure run.
- **Inbound namespaced RPC → `member`.** All four inbound handlers (ping, neighbors request, maybeAct, announce) receive the transport-authenticated `connection.remotePeer` and promote the sender. Reaching one of them at all means the remote dialed a protocol only this network's peers speak. This re-admits a peer we struggle to dial but that reaches us (e.g. behind NAT) immediately and with no extra probe traffic.
- **Unsupported-protocol error → evidence, not a verdict.** libp2p throws `UnsupportedProtocolError` when the remote doesn't support the dialed protocol — but a same-network peer that has not yet run `registerRpcHandlers()`, or that is restarting (`stop()` unhandles all five protocols), produces exactly the same error as a genuinely foreign peer. Each such failure increments a per-peer consecutive-failure counter (`PeerEntry.negotiateFailures`); only at a threshold of **3** does the peer demote to `foreign`. Any positive proof — a successful RPC in either direction, or an identify list containing one of ours — resets the counter to 0. A timeout / transient failure is not even counted; it leaves the label untouched for a later retry. Two of the three call sites (the neighbor-latency probe and the maybeAct forward path) draw their targets from member-gated views, so *every* demotion there would otherwise be a confirmed member being demoted on one blip. Delaying the `unknown → foreign` demotion costs nothing in correctness — `unknown` is already excluded from every ring view — so the whole price is ~2 extra pings per genuinely-foreign peer, once, spread across the existing backoff schedule (1 s + 2 s + 4 s ≈ 7 s to a settled label).
- **peerStore protocols (when `identify` has run).** On `peer:identify` / `peer:update`, the peer's negotiated-protocol list is checked: contains one of ours → `member`; non-empty but contains none → `foreign` **but only from `unknown`**; empty → left `unknown`. The negative arm is deliberately weak because the list may have been captured before this service registered its handlers — a stale `peer:update` must not overturn a peer confirmed by RPC. The same check also runs over the start-time / per-tick seed poll: `seedFromPeerStore` enumerates `peerStore.all()` and classifies each entry off its protocol list, so a peer whose `identify` completed before this service started is labelled at `start()` without waiting for an event or an outbound probe. (This poll used to carry its own `unknown`-only guard; that rule is now general and lives in the guard.) This also delivers re-admission — a peer that later starts serving this network re-identifies and is re-evaluated `foreign → member`.

- **Classification probe pass.** Because the member-only ring views (below) exclude `unknown` peers, a bounded pass on each stabilization tick pings up to N `unknown` peers directly from the store (preferring connected / has-addresses ones — see *Dialability* below) so an unclassified same-network peer is resolved within ~1 tick rather than starved. It reads the store directly, *not* the gated ring views, which is how it still sees unknowns. The pass runs only while unknowns exist; in single-network steady state every peer becomes `member` and it is a no-op.
- **Foreign re-probe pass.** A smaller companion pass re-probes a couple of `foreign` peers per tick. Before the member-only ring views landed, a same-network peer that was *mislabeled* `foreign` (e.g. `identify` completed before it had registered our handlers) self-healed for free — `probeNeighborsLatency` pinged near ring peers regardless of label. Gating excludes foreign peers from the ring, closing that path, so this RPC backstop replaces it: a successful namespaced ping re-admits a mislabeled peer to `member`. It is bounded — only a couple of off-backoff foreign peers per tick, and a confirmed-foreign probe records an exponentially-growing backoff (doubling each window, capped at 32×) so a *genuinely* foreign peer is probed at most ~once per window and tapers toward ~once/32s in steady state. Within the per-tick budget, candidates are ordered by **ascending backoff factor** — the factor is a proxy for how many times we already confirmed a peer foreign, so a freshly-demoted peer (the one most likely to be mislabeled) is serviced before a long-confirmed foreign one rather than queueing behind it. That ordering matters because the pass's throughput is small: with F genuinely-foreign peers in steady state, peers come off backoff at ≈ F/32 per second while the pass services ≈ 2 per 1.5 s tick ≈ 1.33 per second in passive mode, so above roughly F ≈ 42 the pass is saturated. (Arithmetic from those constants, not a measurement — and the reason mislabelling is fixed at the labelling site, per the evidence-strength ordering above, rather than in this recovery budget.) (The `peer:update` identify path above also re-admits, but it is not guaranteed — it depends on the remote pushing an identify update — so the re-probe is the dependable path.)

**Why the run must be spread over time.** A "run" of failures only distinguishes *persistently absent* from *momentarily absent* if the observations are independent. Concurrent callers — several inbound `maybeAct` requests forwarding to the same restarting hop, say — all fail in the same instant against the same blip; that is one observation, not three. So a failure landing within 500 ms of the last counted one is ignored rather than counted, which makes a burst unable to reach the threshold on its own. The spacing sits well under the shortest interval at which the probe passes can legitimately re-observe a peer (the 1 s first backoff window), so genuine sequential failures are never swallowed and the ~7 s time-to-label for a genuinely foreign peer is unchanged.

`negotiateFailures` lives on the routing-table entry (rather than a service-local map) so it is evicted with its entry for free. It is exported in `SerializedPeerEntry` for diagnostics but **reset to 0 on import**, for the same reason `state` is forced to `disconnected`: handshake history cannot survive a restart. Its companion `lastNegotiateFailureAt` (the spacing timestamp) is not serialized at all — unlike the count it carries no diagnostic value across a restart. The store stays network-agnostic — it stores and exposes both fields and never branches on them, exactly as it already does for `membership`.

Labels are durable across the network-agnostic re-seeds (`upsert` preserves an existing entry's full mutable state — relevance, health counters, state, membership, and metadata — refreshing only coord and lastAccess; defaults are applied only for a genuinely new peer) and reversible in both directions (no state is permanent). Foreign peers are tagged and retained rather than evicted — an evicted foreign peer is just re-added by the next connect/seed and re-probed in a loop.

#### Network-scoped admission (member-only ring views)

Every ring-shaped read is **member-only**: a peer participates in this network's ring only once its `membership` is `member`. Concretely, a peer that is `foreign` (or still `unknown`) is never a neighbor, cohort member, routing candidate, size-estimate contributor, snapshot sample entry, or discovery emission for this network. Self is seeded `member`, so it always participates; a single-node ring still self-reports a size estimate of 1.

The gate is applied **inside the ordered ring walk**, not by post-filtering the result. `DigitreeStore`'s `neighborsRight` / `neighborsLeft` / `successorOfCoord` / `predecessorOfCoord` take an optional `filter` predicate; on a miss they **skip and keep advancing** rather than stopping, so a cluster of foreign peers sitting nearest a key cannot starve the cohort (the alternating walk over-fetches `wants * 2` and still collects `wants` members). A bounded-scan guard caps a filtered walk at one full traversal (`size()` entries) so a ring with zero matching entries terminates instead of spinning on the wrap-around. The store itself stays network-agnostic — it never names `membership`; `FretService` owns the predicate `e => e.membership === 'member'` and passes it. With no filter (the default) behavior is byte-for-byte unchanged, so direct store users (e.g. the design simulator) and the exported `assembleCohort` / `estimateSizeAndConfidence` / `selectDiverseSample` standalones are unaffected.

`unknown` peers are excluded from the ring because they are not yet confirmed same-network. They are not starved: the classification probe pass (above) reads the store **directly** — not the gated ring views — so it still resolves them, typically promoting a same-network peer to `member` within ~1 tick, after which it appears in the ring. The outgoing snapshot's neighbor lists and sparsity sample are also member-scoped, so neighbor-exchange never re-introduces a foreign peer to same-network peers (the transitive-propagation guard); inbound merges still upsert received ids as `unknown` and let classification vet them before any ring use. Capacity eviction protects only member neighbors around self, so a foreign peer (relevance ~0) becomes a preferred eviction victim rather than squatting in a protected slot.

In a single-network deployment every peer is `member` after warm-up, so member-scoping is a no-op on results — the only cost is the per-entry membership comparison while walking.

### Active vs passive state (network manager)
- Passive: background stabilization at a modest cadence; only gentle maintenance (no aggressive dialing).
- Active (connection warm-up; refcount-based): when an operation starts, enter active mode to avoid serial dial chains:
  - Pre-dial/ping a bounded set of hot peers (route-critical successors, near-h nodes, recent routing nodes)
  - Refresh reachability for those entries; keep RPC queues shallow
  - Exit active when all refcounts drop to zero; revert to passive

Notes:
- Active is about connection warm-up, not a strict "tick" loop. Stabilization cadence continues independently (profile-dependent).
- Warm-up budgets are profile-tuned (see Operating profiles) and bounded to protect mobile/edge nodes.

### Partition and merge hooks (outside FRET, but supported)
- Each repo instance initializes with a nonce.
- Neighbors exchanging state include repo nonces; cross-partition healing only allowed if nonces match and revisions do not conflict; otherwise manual reconciliation.
- FRET surfaces "neighborhood merge" events to higher layers when previously disjoint rings connect.

### Fuzzy routing intervals (emergent finger-like structure)
- During routing and stabilization, we bias discovery/merges toward logarithmically spaced intervals around targets rather than exact keys.
- Combined with sparsity-weighted relevance, this seeds routing-relevant peers without explicit finger tables.
- The cache thus self-organizes into a distance-balanced spine that accelerates future lookups, while remaining purely cache/relevance-driven.

### Small vs large networks
- Small (n << k): successor walk yields min(n, k). Deterministic and fast (one hop likely sufficient).
- Large: finger-accelerated greedy routing converges in O(log n) hops. Stabilization keeps fingers fresh under churn.
- Dynamic: symmetric S/P overlap speeds convergence after mass joins/leaves; relevance scoring avoids hotspots.

### Configuration (suggested defaults)
- k (cluster size target): 15
- x (tolerated faulty): 1 (minSigs = k−x = 14)
- m (successors and predecessors): ceil(k/2) = 8
- C (routing table capacity): 2048
- Stabilization period Ts: 1–3s passive; 250–500ms active
- Active pre-dial budget: 4–8 peers per second

### Operating profiles (Edge vs Core)
- Edge (lightweight/mobile):
  - Lower token bucket rates/bytes for neighbor snapshots and maybeAct; smaller snapshot sizes
  - Conservative pre-dial budget (e.g., 2–4 peers/sec; max 2 concurrent); shorter active duration
  - Longer passive stabilization cadence; fewer probes per window
  - Stricter payload caps; prefer digest-only until confidently near-cluster
  - Smaller inbound RPC concurrency; earlier "busy/Retry-After" responses
- Core (server-grade):
  - Higher token rates/bytes and larger snapshots to seed others
  - Aggressive pre-dial (e.g., 6–12 peers/sec; max 4–6 concurrent) during active
  - Faster stabilization cadence; more probes to heal topology quickly
  - Larger payload caps; earlier inclusion of activity to reduce RTTs
  - Higher inbound concurrency; buffered backpressure with bounded queues

### Security and abuse considerations

See [threat-analysis.md](threat-analysis.md) for comprehensive threat modeling and [threat-rir-mitigated.md](threat-rir-mitigated.md) for residual posture with Right-is-Right.

#### Current state
- Timestamp bounds (±30s) for message freshness, deliberately equal to the dedup TTL below. Any slack between the two is a replay window — a captured message whose dedup entry has expired but whose timestamp still passes is accepted and re-performed — so the two constants move together (`DEDUP_TTL_MS`). A deployment with poor clock sync can pass a wider window per call, at the cost of re-opening that gap.
- Correlation ID + phase dedup cache (30s TTL; capacity 2048 Core / 512 Edge) for maybeAct — the key is the correlation ID paired with whether the message carries an activity, so a digest probe and the activity resend sharing that ID get separate cache slots, and only a terminal answer is stored (see the routing rule above). Capacity is profile-derived because an entry evicted before its TTL is a replay hole: Core carries the higher inbound rate and so is given 4× the slots, while Edge's tighter inbound maybeAct rate limit already caps how fast its cache can be churned.
- Correlation IDs are minted from the WebCrypto RNG (`crypto.randomUUID`, falling back to `crypto.getRandomValues` where `randomUUID` is unavailable — React Native, older browsers). `Math.random` was predictable from observed outputs, which let an attacker pre-fill a peer's dedup cache with answers for requests not yet sent. The self-id and timestamp prefixes are traceability only and need not be secret.
- Rate limiting via global token buckets (per-protocol, profile-tuned Edge/Core), including the inbound announce handler (gated before any merge work; on rejection the message is dropped and `diag.rejected.rateLimited` increments). Each bucket is taken **before** the handler's own validity checks, so invalid messages are metered too — see *Cheap-guard rejections* under the maybeAct routing rule for why that ordering is load-bearing.
- Inbound snapshot-merge caps: both the neighbor-fetch merge and the announce merge slice remote successors/predecessors/sample to the same per-profile bounds (Core 16/16/8, Edge 8/8/6) before iterating, so one crafted message cannot force thousands of parse+hash+upsert ops regardless of the 128 KB byte limit
- Breadcrumb loop detection and TTL limits on routing
- Capacity-bounded routing table (C=2048) with relevance-based eviction
- Transport identity verification: every RPC handler receives `(stream, connection)`; any message carrying a `from` field (leave notice, announce snapshot) is dropped unless `from` equals the transport-authenticated `connection.remotePeer`, and mismatches are counted (`diag.rejected.identityMismatch`). Handlers without a `from` (neighbors request, maybeAct, ping) still adopt the two-argument signature so the authenticated sender is available (threaded to the maybeAct handler for future per-peer rate limiting).

#### Not yet implemented (planned — see tickets/)
- Message authentication:
  - Sign all messages with sender's private key; verify on receipt
  - Verify ring coordinates in sample entries (re-hash rather than trust provided coords)
- Replay hardening:
  - Dedup protection for leave notices (the TTL/timestamp alignment, strong correlation IDs, and profile-tuned dedup capacity are done — see Current state above)
- Leave authentication:
  - Require signature from departing peer
  - Liveness ping before removal
  - Treat suggested replacements as untrusted hints
- Per-peer rate limiting alongside global buckets (the inbound announce handler now has a global bucket; per-peer buckets remain planned)
- Admission control (dual-path):
  - Open path: density-based friction using consensus size estimate and regional peer counts
  - Application-controlled path: `AdmissionPolicy` hook receives peer ID, credential (via metadata), connection origin (IP, relay status, full multiaddr); application returns admit/deny/default
  - Enables flash-join use cases (e.g., voting) where credentialed peers bypass density friction while open-path peers face Sybil resistance
- Sybil resistance:
  - Bounded gossip size consensus for network-wide density detection
  - Constrained join with graduated resistance in over-populated ring regions
  - Identity cost (PoW or similar) for open-path admission (design TBD)
- Eclipse attack mitigation:
  - Periodic random walks to discover peers outside immediate neighborhood
  - Multi-path bootstrap verification
  - Alert on sudden S/P set changes
- Cohort diversity requirements (IP range, AS number)
- End-to-end payload encryption (activity readable only by target cluster, not forwarding hops)
- Breadcrumb/routing metadata privacy (path obfuscation)
- Reputation exclusions locally enforced; evidence objects signed and bounded

### Migration plan (high-level)
1. Introduce FRET module (routing table, S/P/F management, stabilization loops).
2. Implement neighbor snapshot RPC and active/passive manager.
3. Implement route.maybeAct pipeline and integrate with transactor paths.
4. Replace KadDHT usages with FRET APIs for coordinator/cluster selection.
5. Add size estimation and payload inclusion heuristic.
6. Optional: gossip/evidence and hot-transaction seeding.

### Aspect-oriented implementation plan
- Service shell & lifecycle (A1)
  - Startable service; registrar handle/unhandle; capabilities/dependencies.
  - `stop()` is a strict mirror of `start()`: it bumps the run generation, clears the loop
    timers, detaches node listeners, `unhandle`s all five protocols, then sends leave notices
    (unhandle only removes *inbound* handlers, so outbound leaves still go out). Both are
    idempotent: `start()` is guarded against re-entry and resets run-scoped flags, and `stop()`
    returns immediately unless a run is in progress, so start→stop→start is safe and a repeated
    `stop()` does not re-send the leave fan-out to peers already told goodbye.
  - **Run generation.** Background loops (stabilization, active preconnect) capture the run
    generation when armed and exit — rather than rescheduling — once it no longer matches.
    A boolean "am I running" flag cannot do this: `stop()` clears it but cannot cancel a timer
    already pending, and the next `start()` sets it back to true, so the stale tick resurrects
    itself and the service ends up with two live loops. Both loops also store their timer handle
    so `stop()` can cancel them outright.
  - Intentionally-detached async work goes through `FretService.detach(promise, label)`, which
    attaches a logging catch. Under Node's default `--unhandled-rejections=throw`, a bare
    `void somePromise()` whose body can throw is a process-fatal rejection.
  - Modes: Edge/Core profiles; client/server toggle analogous to kad-dht.
  - Ready gate for early queries; allow zero-peers override for single-node dev.
- Routing store (Digitree) & indices (A2)
  - Ordered B+Tree keyed by ring coordinate; secondary relevance index.
  - **One entry per peer id, and the id index points at its current key.** The store keeps two
    views of the same population: the ordered tree (every ring walk, `list`, `exportEntries`)
    and a map from peer id to that entry's tree key (`getById`, `remove`, `update`, `size`).
    The tree key embeds the coordinate (`hex(coord)|id`), so **changing a peer's coordinate is a
    re-key, not an in-place edit** — the old entry must be dropped as the new one is placed.
    All mutation therefore funnels through a single private write seam inside `DigitreeStore`
    (plus its delete half, `remove`); no write path re-derives the bookkeeping for itself.
    Breaking the invariant in either direction is silently corrupting rather than loud: an extra
    tree entry is walked by the ring but unreachable by id (so `remove` cannot delete it, and it
    consumes a slot in every ring walk, shrinking cohorts below the requested count), while a
    stale id mapping hides a live entry from every id-keyed reader. `test/digitree.invariants.spec.ts`
    pins it — a model-based property test over arbitrary write sequences, so a future write path
    that bypasses the seam fails there rather than shipping.
  - Bounded capacity with victim selection; infinite relevance for S/P.
  - Import/export compact snapshots for bootstrap and neighbors (NeighborSnapshotV1).
  - Import/export full routing table snapshots for persistence and fast bootstrap (see Routing table persistence below).
- Neighbor management & snapshots (A3)
  - RPC: neighbors (request/response with caps, tokens, compression).
  - Merge policy with de-dup, score updates, health checks.
- Cohort assembly primitives (A4)
  - Two-sided alternating walk with wants ≤ k; filter/expand API.
  - Membership test helper; repo-capability tagging for members.
- RouteAndMaybeAct pipeline (A5) ✓
  - Async generator (`iterativeLookup`) for progressive results; breadcrumbs/TTL. The walk keeps a `visited` set (seeded with self) of every peer it has contacted — probe target, activity target, busy responder — and passes it *into* the candidate walk as the exclusion, so a remote anchor list that keeps naming an already-probed peer cannot stall the lookup on repeat probes. On a ring too small to offer a fresh hop this reaches `exhausted` promptly instead of burning the attempt budget.
  - Next-hop selector: cost-function mode with near/far behavior, backoff penalty, confidence weighting; legacy connected-first fallback.
  - Payload inclusion heuristic: `shouldIncludePayload` based on distance to key vs cluster span and confidence.
  - Correlation-ID + phase dedup cache; breadcrumb loop rejection.
  - Activity callback interface (`setActivityHandler`) for threshold signature tracking (minSigs).
- Stabilization & health (A6)
  - Periodic S/P verification, finger probes; jitter; skip if recent traffic.
  - Failure pruning and decay; reinsert on recovery.
- Rate limiting & backpressure (A7)
  - Per-peer token buckets; global in-flight caps; bounded queues.
  - Busy/Retry-After responses; local exponential backoff.
  - Profile-tuned budgets (Edge/Core).
- Metrics, logging, and tracing (A8)
  - Per-op counters/errors/latencies; structured logs with prefixes.
  - Correlation ids across maybeAct phases; hop counts; cohort sizes.
- Repo sync hooks (A9)
  - Signals for "needs repo state"; callback to higher layer to fetch/sync-on-demand.
  - Partition/nonce surfaces for safe merges.
- Integration adapters (A10)
  - PeerDiscovery: emit peers from S/P/F.
  - Replacement hooks for coordinator/cluster selection in core transactor.

### Data structures and algorithms

#### Digitree implementation
- B+Tree with order 32 (31 keys per node, 32 children)
- Primary key: ring coordinate (256-bit)
- Secondary indices:
  - Relevance score (float64, maintained as heap)
  - Last access time (for LRU)
  - Connection state (connected/disconnected/dead)
- Operations:
  - insert(peer, coord): O(log n)
  - findNearest(coord, count): O(log n + count)
  - evictLowestRelevance(): O(log n)
  - updateRelevance(peer, delta): O(log n)

#### Ranges and paths integration with Digitree
- Reference: Digitree documentation on ranges, iterators, and Paths ([Digitree docs](https://digithought.github.io/Digitree/))
- Successor (clockwise) of coordinate h:
  - p = tree.find(h); if p.on then succ = p else succ = tree.next(p); if succ is off-end, wrap with tree.first()
  - Iterate successors with `ascending` or `moveNext` for K steps; collect into array to avoid path invalidation during mutations
- Predecessor (counterclockwise) of h:
  - p = tree.find(h); pred = tree.prior(p.on ? p : p); if pred is off-start, wrap with tree.last()
  - Iterate predecessors with `descending` or repeated `prior`
- Wrap-around ranges:
  - Clockwise K successors: enumerate `ascending(start)` up to end, then `ascending(tree.first())` until K reached
  - Counterclockwise K predecessors: enumerate `descending(start)` then `descending(tree.last())`
- Paths lifecycle:
  - Paths not returned from mutation are invalid after any mutation; only use mutation-returned paths for further mutation (per Digitree semantics)
  - For stabilization/routing, avoid mutating during iteration; snapshot peer IDs first, then perform network actions
- Key immutability:
  - Entries are frozen; do not mutate keys after insertion; to update coordinates, delete+insert
- Efficient nearest:
  - Use `find` and the "crack" path: `next` yields successor, `prior` yields predecessor; this is O(log n)
- Counting and diagnostics:
  - `getCount` for quick checks; use `first/last`, `ascending/descending` for ordered scans

#### Relevance score calculation (bucketless sparsity model)
```
Inputs per-peer: lastAccess, accessCount, successCount, failureCount, avgLatencyMs.
Global: KDE centers ci (m≈12), occupancy Oi (EMA), kernel width σ, decay α, exponent β.

x = normalized_log_distance(self, peer) ∈ [0,1]
observe: Oi ← (1−α)Oi + α·Kσ(|x−ci|)
density(x) = Σ Oi·Kσ(|x−ci|)
ideal(x) = Σ 1·Kσ(|x−ci|)   // uniform target
S(x) = clamp(((ideal(x)+ε)/(density(x)+ε))^β, sMin, sMax)

base = w_r·recency(lastAccess) + w_f·freq(accessCount) + w_h·health(success/failure, avgLatency)
relevance = base · S(x)
```

Notes:
- `normalized_log_distance` is derived from **ring distance** (`min(cw, ccw)`), not XOR — the same `normalizedLogMagnitude` helper the next-hop cost function uses, so "near" means the same thing to routing and to the KDE. Since ring distance maxes at 2^255, x reaches 1 only for a pair sitting exactly antipodal; every other pair lands at 1 − 1/256 ≈ 0.996 or below. The KDE centers span 0.042–0.958 and x is only ever used as a relative position, so nothing is rescaled to compensate.
- No explicit buckets or finger tables; a single ordered Digitree plus sparsity-aware scoring yields an emergent, distance-balanced cache well-suited to routing.
- During a routing walk, temporary (ephemeral) multipliers may bias candidates near the desired step distance, but long-term scores remain governed by S(x).

#### Cohort assembly algorithm
```
function assembleCohort(key, wants, excludeSet):
  # Over-fetch both walks: `wants * 2` so the two walks overlapping on a small ring still
  # yield `wants` distinct ids, `+ |excludeSet|` so exclusions blanketing one walk's window
  # don't starve it. Each walk is capped at the ring size, so an over-large ask just
  # returns every entry.
  reach = wants * 2 + excludeSet.size
  succs = neighborsRight(key, reach)   # distinct, ordered clockwise
  preds = neighborsLeft(key, reach)    # distinct, ordered counterclockwise
  cohort = []
  seen = {}
  while cohort.size < wants and (succs or preds remain):
    # Alternate sides on cohort size; a skipped candidate does not advance the alternation,
    # so the same side is re-drawn until it yields an admissible id.
    take = (cohort.size % 2 == 0 and succs remain) ? next(succs) : next(preds)
    if take not in excludeSet and take not in seen:
      seen.add(take); cohort.add(take)
  return cohort   # distinct by construction — never dedup or truncate afterwards

function isInCluster(self, key, k):
  cohort = assembleCohort(key, k, {})
  return self in cohort
```

Exclusions must be passed **into** the assembly, never applied to its result: filtering the
returned array shrinks the cohort below `wants` even when the ring holds enough admissible
peers. The same rule covers the routing-candidate path, where the exclusion set is the
breadcrumb trail plus self — a long trail would otherwise dead-end a route that still had
usable next hops.

### Wire formats

#### Neighbor snapshot (JSON)
```
interface NeighborSnapshotV1 {
  v: 1;
  from: string;                 // PeerId (base58btc)
  timestamp: number;            // unix ms
  successors: string[];         // S(p) peer ids
  predecessors: string[];       // P(p) peer ids
  sample?: Array<{             
    id: string;                 // peer id
    coord: string;              // base64url ring coordinate (32 bytes)
    relevance: number;          // float score
  }>;
  size_estimate?: number;       // n_est
  confidence?: number;          // [0, 1]
  sig: string;                  // base64url signature over canonical JSON
}
```

#### RouteAndMaybeAct (JSON)
```
interface RouteAndMaybeActV1 {
  v: 1;
  key: string;                  // base64url key bytes
  want_k: number;
  wants?: number;
  ttl: number;                  // ms or hops (implementation-specific)
  min_sigs: number;
  digest?: string;              // base64url digest
  activity?: string;            // base64url payload
  breadcrumbs?: string[];       // peer ids
  correlation_id: string;       // base64url uuid/bytes
  timestamp: number;            // unix ms
  signature: string;            // base64url signature
}
```

#### NearAnchor (JSON)
```
interface NearAnchorV1 {
  v: 1;
  anchors: string[];            // ≤2 peers nearest the key coordinate (see Routing rule)
  cohort_hint: string[];        // small peer id set
  estimated_cluster_size: number;
  confidence: number;           // [0, 1]
}
```

#### LeaveNotice (JSON)
```
interface LeaveNoticeV1 {
  v: 1;
  from: string;                 // departing PeerId (base58btc)
  replacements?: string[];      // suggested replacement PeerIds (max 12, sanitized by receiver)
  timestamp: number;            // unix ms
}
```

#### Serialized routing table (JSON)
```
interface SerializedPeerEntry {
  id: string;                   // PeerId (base58btc)
  coord: string;                // base64url ring coordinate (32 bytes)
  relevance: number;            // float score at time of export
  lastAccess: number;           // unix ms
  state: PeerState;             // 'connected' | 'disconnected' | 'dead'
  membership?: MembershipState; // 'unknown' | 'member' | 'foreign'; absent in pre-membership snapshots → 'unknown'
  negotiateFailures?: number;   // consecutive failed protocol negotiations; exported for diagnostics, reset to 0 on import
  accessCount: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  metadata?: Record<string, any>;
}

interface SerializedTable {
  v: 1;
  peerId: string;               // exporter's PeerId
  timestamp: number;            // unix ms at export time
  entries: SerializedPeerEntry[];
}
```

### Routing table persistence
FRET's routing table (Digitree store) is in-memory by default. The `exportTable` / `importTable` API allows callers to snapshot and restore the full routing table across restarts, avoiding cold-start bootstrap latency.

- **Export**: `exportTable()` returns a `SerializedTable` containing every peer entry in the Digitree, with `Uint8Array` coordinates encoded as base64url strings. The envelope includes the exporter's peer ID and a timestamp.
- **Import**: `importTable(table)` deserializes entries back into the Digitree. All imported entries have their state forced to `'disconnected'` since connection liveness cannot survive a restart. Membership labels are preserved (a persisted table is same-network by construction); a missing `membership` field in an older snapshot defaults to `'unknown'`. Capacity enforcement runs after import, so importing a table larger than the local capacity evicts lowest-relevance entries as usual.
  - **Replace by id.** Import is public and nothing stops a caller invoking it after `start()`, at which point self and any peer-store-seeded peers are already in the table. A snapshot record for an id already present therefore *replaces* that entry outright, including a coordinate move — the snapshot is the more recent view of that peer, and the alternative (leaving the existing entry in place) both discards the restored data and, on a coordinate move, strands the old entry in the tree unreachable by id.
  - **Returns the number of distinct ids stored**, not the number of input records, so a snapshot carrying an id twice reports 1.
  - Because replacement is unconditional, `importTable` re-asserts self's `member` label afterwards: a record for self (another peer's snapshot, or one predating the membership field, which decodes as `unknown`) would otherwise demote self out of every member-only ring view until the next stabilization tick re-seeded it.
- **Persistence layer is external**: FRET only handles serialization/deserialization. The caller decides where and how to store the JSON (filesystem, IndexedDB, database, etc.).
- **JSON-safe**: The `SerializedTable` structure is fully JSON-serializable and survives `JSON.stringify` / `JSON.parse` round-trips.

Typical usage:
```
// Before shutdown
const table = fret.exportTable();
await fs.writeFile('fret-table.json', JSON.stringify(table));

// On startup
const saved = JSON.parse(await fs.readFile('fret-table.json', 'utf-8'));
const count = fret.importTable(saved);
// count entries restored; stabilization loop re-validates liveness
```

After import, the normal stabilization loop probes restored peers to update connection states and relevance scores. This makes import safe even with stale data — unreachable peers will be decayed and eventually evicted.

### Implementation notes

#### Concurrency and locking
- Digitree: RWMutex for tree operations; separate mutex for relevance updates
- S/P sets: atomic swaps for updates; read-copy-update pattern
- Stabilization: non-blocking; uses snapshot-and-merge approach
- RPC handlers: bounded worker pools per protocol

#### Error handling patterns
- Network errors: exponential backoff with jitter; max 5 retries
- Invalid messages: log and drop; update sender reputation
- Capacity exceeded: evict by relevance; notify higher layers
- Partition detected: alert and enter conservative mode

#### Testing strategy
- Unit tests: Digitree operations, cohort assembly, relevance scoring
- Integration tests: Join/leave scenarios, stabilization convergence
- Simulation: Large-scale churn patterns, partition/merge behavior
- Benchmarks: Routing latency, memory usage, message overhead

### Open questions / next steps
- Exact relevance weight tuning based on network simulations
- Optimal CBOR vs protobuf tradeoffs for different message types
- Identity cost mechanism for open-path Sybil resistance (PoW difficulty, stake, or hybrid)
- End-to-end payload encryption scheme compatible with progressive routing (cluster key agreement, onion encryption, or coordinator-targeted encryption with re-encryption on redirect)
- VRF-based ring coordinate rotation (epoch nonce rotates positions, preventing permanent ID grinding)
- Integration timeline with existing KadDHT-dependent code
