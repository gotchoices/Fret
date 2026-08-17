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
- These are all one cache set. There is no separate S/P container and no "infinite relevance" score — the successor/predecessor windows *are* the filtered ring walk (see *Network-scoped admission*), and their protection from eviction is a **protection set** computed at eviction time (see *Relevance scoring and table management*), not a score.

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
  - Neighbors: entries in S(p) ∪ P(p) are retained regardless of score, unless excluded from the ring view.
- Victim selection: lowest score first, **skipping a protection set** — `FretService.enforceCapacity` asks the store for the live members immediately around self (`protectedIdsAround(self, max(2, m), isLiveMember)`) and never evicts one, however low it scores. Two consequences that are behavior, not wording:
  - **The protected set is `2·max(2, m) − 1` ids, not `2m + 1`.** Both walks start *on* self, so self consumes one slot per side and only `m − 1` live members are protected on each side — the m-th successor and m-th predecessor are evictable despite being genuine S(p)/P(p) members. Self-anchored ring walks elsewhere in the service share this off-by-one (they ask for `m` and then filter self out); the size estimator is the one site that compensates, asking each side for `m + 1`. Reconciling them onto one helper is `plan/23-fret-service-decomposition` item (a).
  - **Protection outranks the cap.** With `capacity < 2m − 1` the eviction loop runs out of unprotected candidates and the table stays over capacity. Unreachable at the shipped numbers (m 8, capacity 2048) and only reachable by misconfiguration; see the `NOTE:` at `enforceCapacity`.
  - Scores are compared as *stored*, not recomputed: `PeerEntry.relevance` is whatever the last scoring call wrote, and the sparsity bonus that multiplied it came from the service-wide model's occupancy at that moment. Eviction therefore ranks snapshots taken under different model states.
  - Pinned by `test/relevance.eviction.spec.ts`.

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
- **One tick's RPCs run pooled, not serially, under one tick-wide budget.** A tick (`stabilizeOnce`) contacts up to 4 near peers (ping, then snapshot fetch), up to Core 8 / Edge 4 `unknown` peers, and up to Core 2+2 / Edge 1+1 `foreign` and `dead` peers (see *Classification probe pass* and *Re-probe passes* under Ring membership). Walked one peer at a time, a tick's wall time was the *sum* of those 14–20 round trips — one hung peer cost every peer behind it its turn, and a tick under mass failure ran ~60 s Core / 50 s Edge against a 1.5 s passive interval (the loop awaits the tick before re-arming). Now:
  - **Concurrency:** at most `maintenanceConcurrency` outbound RPCs in flight — Core 6 / Edge 2, the *Operating profiles* pre-dial concurrency reused rather than re-invented — through the bounded pool `runPooled` (`src/utils/pool.ts`). Edge's 2 is deliberately conservative: an Edge tick truncates on the budget more often, which is that profile's stated posture ("fewer probes per window").
  - **Budget:** one `deadline` of `STABILIZE_TICK_BUDGET_MS` (5 s) per tick, a child of the run signal — so `stop()` collapses an in-flight tick at once, and expiry aborts in-flight RPCs and `skip`s the tasks not yet started. Wall time is on the order of the slowest single peer, bounded by 5 s, rather than a sum.
  - **Two phases.** Phase 1 pools the near peers, chaining ping → fetch **per peer** (`probeAndFetch`): `fetchNeighbors` is connection-only and it is usually the preceding ping that opens the connection, so the dependency is per peer, not "all pings, then all fetches". `enforceCapacity` runs once after phase 1 drains and the ids the merges saw for the first time are announced once — neither runs inside a pooled task (concurrent capacity enforcement would over-evict; a per-task announce would announce a peer per task). Phase 2 pools the classification and re-probe *targets* together, but each list is still **selected** under its own budget and ordering (`classifyTargets`, `reprobeExcludedTargets`) — only execution is pooled; merging the candidate lists would repeal the separate-budgets rule.
  - **Disjoint by construction, asserted not trusted.** The four candidate sets a tick pools — near = live member; classify = `unknown` non-dead; foreign arm = `foreign` non-dead; dead arm = `dead` — cannot name the same peer twice, which is what makes pooling safe against the lost-increment race on the score/strike counters (`applySuccess` / `applyFailure`). `test/stabilize-concurrency.spec.ts` pins the disjointness, the pool cap (high-water mark *equals* the cap, so the tick provably overlaps), the per-peer ping-before-fetch order, and the headline case: one hung near peer costs the tick its budget, not the other peers their probe and fetch.
  - **Truncation is not evidence.** Every pooled task compares against the tick signal it was handed (`wasCancelled`), so a budget expiry records no strike, no backoff, no relevance decay, no `pingsFail`, exactly like a `stop()` — see the cancellation bullet below.
  - **Candidate lists rotate, so a truncated tick never re-derives the same head.** Unknowns are ordered by ascending `lastAccess` before the budget slice (a probed one is bumped by `applySuccess` or backed off, so it rotates to the back with no bookkeeping); each re-probe arm orders by ascending backoff factor. The near list is the exception, kept in **ring order** (closest first) on purpose: those are the peers ring correctness depends on most, so a truncated tick should skip the 4th-closest and never the immediate successor.
- Failure detection and recovery:
  - Soft failure (timeout): decay relevance score by factor δ (e.g., 0.7). **Escalation is staged, not per-failure, and the near pass does not back off.** `probeNeighborLatency` — the pass that verifies the successor/predecessor windows — decays relevance and counts one contact strike, and records no backoff; `nearProbeTargets` has no backoff filter either, so a live member is re-verified on *every* tick (at most 4 near peers per tick) for at most `deadAfterFailures` (3) spaced strikes. Exponential backoff belongs to the off-ring probe passes (`probeMembership`, used by the classify / foreign / dead arms) and to the routing path — which is where a peer lands once the strikes exclude it from the ring. Pinned by `test/failure-recovery.spec.ts`.
  - Hard failure: `deadAfterFailures` (3) consecutive **failed contacts** mark the peer `dead` in the Digitree. A failed contact is a failure to reach the peer *at all* — the outbound RPC threw because the dial, stream, or read failed. Deliberately **not** a failed contact: a peer that answered and refused to negotiate this network's protocol (that is membership evidence — see *Evidence strength* — and proves the peer is alive), a peer that answered `ok: false` / busy, and an idle `peer:disconnect`. All three keep their relevance decay and contribute no strike.
    - Like the negotiate-failure run, the contacts must be **spread over time** to be independent observations: a failure landing within 500 ms of the last counted one is ignored, so a burst of concurrent calls failing against one restarting peer cannot reach the threshold on its own. The count lives on the routing-table entry (`PeerEntry.contactFailures`, with `lastContactFailureAt` as the spacing stamp) so it is evicted with its entry, and is clamped at the threshold so it stays bounded for a peer we keep re-probing. Self is never marked dead — a dead self would drop out of every ring view with no path back short of a restart.
    - **Removal from S/P is ring-view exclusion, not a separate step.** FRET keeps no standalone successor/predecessor *set* — those windows **are** the filtered ring walk (see *Network-scoped admission*), whose predicate is `membership === 'member' && state !== 'dead'`. So marking a peer `dead` removes it from the successor/predecessor windows, cohorts, routing candidates, the size estimate, and the outgoing snapshot's neighbor lists and sample, all at once. It also drops out of capacity protection — `enforceCapacity` protects only the peers that same predicate returns around self — so a dead peer with a decayed relevance becomes a preferred eviction victim with no eviction-specific code. The maintenance fan-outs that walk the store *unfiltered* (announce targets, leave notices) carry their own dead skip for the same reason they skip `foreign` and undialable peers: the dial can only fail, and the leave fan-out runs inside `stop()`, where a stack of doomed dials also delays shutdown. That skip is **one shared predicate** (`isDoomedDial` — undialable, `foreign`, or `dead`; `unknown` is deliberately still a target), not a guard restated per fan-out, because restating it is how the two drifted apart in the first place. Re-probing a dead peer belongs to the budgeted dead arm below, which backs off; a fan-out would retry every dead peer every tick.
  - Recovery: any proof of life clears the run and restores a `dead` peer to `connected` (if a connection exists) or `disconnected` — a completed outbound RPC, an inbound RPC (which is what re-admits a peer we struggle to dial but that reaches us), or a fresh `peer:connect`. Relevance is deliberately **not** reset to a baseline: the ordinary success scoring already up-ranks the peer, and wiping the health counters would erase the record of one that flaps. Conversely a `peer:disconnect` never clears `dead` — a closing connection is not proof of life, and it is precisely the event that follows a run of failed contacts, so clearing the label there would re-admit the peer with its counter still clamped at the threshold and have the next failure re-kill it.
    - Proof of life has to be able to *arrive*, and once excluded from the ring nothing dials the peer: stabilization draws its probe targets from the successor/predecessor windows. The dead arm of the re-probe pass (see *Re-probe passes* under Ring membership) is therefore the path back for a peer that recovers but never dials us and never forms a connection — without it such a peer stays dead until evicted at capacity, since `upsert` preserves `state` and a peerStore re-seed does not resurrect it either.
- **Our own cancellation is not evidence about the peer.** A run-signal abort (`stop()`) or a tick-budget expiry (`STABILIZE_TICK_BUDGET_MS`, whose signal is a child of the run signal) records no contact failure, no backoff, and no ping-failure diagnostic; only the RPC's own timeout does. The caller's signal is the discriminator because the sender builds its deadline as a *child* of the caller's signal, so the child fires in both cases while the caller's own signal fires only on a cancellation — which is also why no new error type was needed: the caller already holds the discriminating fact. Every maintenance task and routing loop that catches an RPC failure re-checks the signal it was handed before scoring anything (in the pooled tick each task is handed the *tick* signal explicitly, never defaulted from the run signal, so no task can escape the budget). Tasks the pool had not yet started when the signal fired are `skipped` — a distinct pool status, not a rejection, so nothing is scored for a peer never contacted. One task swallows rather than rethrows: `fetchNeighbors` behind `fetchAndMergeSnapshot` catches its own errors and returns an empty snapshot, so a fetch cancelled mid-flight is still counted in the fetched-snapshot diagnostic. Harmless — the aborted signal makes `openRpcStream` throw before it dials, so nothing is merged and no strike is recorded, and each fetch is its own pooled task so nothing "walks on" past it; the only effect is that diagnostic overcount. See the `NOTE:` on `fetchAndMergeSnapshot` for what would end that.
- Symmetry: maintain |S(p)| = |P(p)| = m by filling gaps from Digitree candidates

## Leave
- Graceful departure protocol:
  1. Send leave notification to all S(p) ∪ P(p) with suggested replacements from Digitree. The replacement list is **live-member-scoped** — the same transitive-propagation guard the outgoing snapshot's neighbor lists and sample carry (see *Network-scoped admission*). The recipient records these ids and its own classification pass probes them, so advertising a peer we already marked `foreign` or `dead` spends someone else's probe budget on peers we gave up on and re-seeds a foreign peer into a same-network view. The *targets* of the notice stay unfiltered by contrast: that walk defines the S(p) ∪ P(p) set the replacement list excludes, and it is not a list we advertise.
  2. Transfer hot transactions and pending state to successors
  3. Notify any connected peers outside S/P before disconnecting
- **Recipients remove the departing peer and treat its suggested replacements as untrusted hints, not as commands.** Each sanitized replacement id (≤ 12, capped in `src/rpc/leave.ts`) is deduped, dropped unless dialable, skipped if it is self or the departing peer, and otherwise recorded with a bare `upsert` — landing `membership: 'unknown'` at relevance 0. Deliberately no `applyTouch`: a relevance score would let an attacker-named id outrank a genuine peer at eviction time, and a name we were handed is not a peer we contacted. Probing is left to the passes that are already budgeted and backed off — `classifyTargets` selects exactly this set on the next stabilization tick, and a locally `foreign` or `dead` replacement falls to the matching `reprobeOffRingTargets` arm (see *Re-probe passes*).
- **A rate-limited leave is indistinguishable from an accepted one on the wire.** The inbound leave bucket is taken inside `handleLeave`, which returns `void` either way, while the handler around it (`registerLeave`) has already committed to replying `{ok: true}`. So a notice dropped by the rate limit is answered exactly like one that was acted on: the departing peer will not retry, and the recipient keeps a routing-table entry for a peer that has gone — until the ordinary contact-failure escalation marks it `dead`. The only local signal is `diag.rejected.rateLimited`. Recorded as today's contract, not endorsed; the discriminated result type in `tickets/plan/15-rpc-shared-helper` is what would let leave report busy. Pinned by `test/rpc.codec-properties.spec.ts`.
- **Per-leave outbound ceiling: 0 pings, 0 neighbor fetches, ≤ 12 local hash + upsert operations, and at most `announceFanout` announces** (Core 8 / Edge 4). That announce goes through the same debounced `announceOnDeparture` the `peer:disconnect` path uses, so a graceful departure — notice *then* disconnect — produces one burst per departed coordinate per 2 s rather than two, and the global announce bucket caps the node's total outbound announce rate across every source. The ceiling is therefore profile-tuned by existing constants; no leave-specific knob exists to keep in sync. Scaling this cost needs N distinct transport-authenticated connections, not N crafted messages.
- The cost of the change is latency: healing used to be attempted within one RPC round trip and now completes within ≤ 1 stabilization tick. The departing peer gave advance notice, so there is no urgency measured in milliseconds — and the old fast path was largely fictional, since `fetchNeighbors` is connection-only and returned an empty snapshot for a freshly-warmed non-connected peer.

### Determining cluster membership and coordinator (two-sided cohort)
- The cohort and its anchors are drawn only from same-network **members** (see *Network-scoped admission*): the alternating walk skips `foreign` / `unknown` entries, so a co-resident foreign network never contributes a cohort member, anchor, or coordinator for this network.
- Two anchors: aSucc = successor(h); aPred = predecessor(h).
- Cohort build (alternating two-sided): [aSucc, aPred, succ¹(aSucc), pred¹(aPred), …] until we collect min(k, n) unique peers, or satisfy a caller-provided wants ≤ k.
- Local membership test: peer p locally computes the alternating two-sided cohort using its S/P index and checks if p is within the first k (or wants) entries. The window is `max(2, min(wants ?? k, k))`: `wants` is clamped at k per the wire contract (`wants ≤ k`) so a malformed message cannot widen the window past the cluster the sender asked for, and the floor of 2 keeps both key-adjacent anchors acting even for a degenerate k of 0 or 1 — without it nobody would consider itself in-cluster and the message would forward until TTL ran out.
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
1. If local membership test says "in-cluster" — self appears among the first `min(wants ?? want_k, want_k)` entries of the key's alternating two-sided cohort, floored at 2 so the two key-adjacent anchors always act:
   - **The window is deliberately wider than the anchor pair.** The payload-inclusion heuristic attaches an activity because the sender judged the receiver near enough to act, so a cluster member that forwards instead spends a hop the sender never budgeted for.
   - If activity included: perform activity (callback) given the two-sided cohort (expand/filter as needed to satisfy minSigs), then return commit certificate. The acting cohort stays `want_k`-wide even when `wants` narrowed the membership window: the cohort exists to gather minSigs signatures and minSigs derives from the full k, so `wants` narrows *who acts*, not *how many peers the actor gathers*.
   - If no activity: reply with NearAnchor { anchors, cohortHint: PeerId[], estimatedClusterSize, confidence } inviting a resend with activity
   - **Anchors are measured against the key's own coordinate.** The candidate pool is the key's successor and predecessor windows, and the two anchors are the pool's *closest* members to the key (connected peers preferred when distances are within a byte, per the next-hop heuristic) — not one from each side. Both anchors may therefore sit on the same side of the key; anchors are routing hints, and being nearest the key is what makes the resend land in-cluster. Measuring from any fixed point instead (self, or the all-zero coordinate) silently returns whichever peers happen to have numerically small coordinates, which is a correctness bug, not a bias — see `test/pick-anchors.spec.ts`.
   - Cache result to handle duplicate requests, keyed on correlation ID **and phase** (digest-only vs activity-bearing). Keying on the ID alone is wrong: the probe and the resend that follows it share an ID, so the probe's NearAnchor would be served as the answer to the message carrying the work and the activity would never run. Since the responder's own anchor list normally names itself, that resend usually arrives right back at the peer holding the probe's cache entry. The phase is read off the message's `activity` field; the payload itself is not hashed into the key, so a re-encoded-but-equivalent retry still hits the cache instead of re-performing the work.
   - **Only a terminal answer is cached.** For a digest probe the NearAnchor *is* the answer. For an activity-bearing message a NearAnchor is a refusal — "I did not perform the work; the ring says try over there" — returned when no activity handler is installed, or when the peer is not in-cluster and its forward found no hop or failed. Storing a refusal would answer every retry of that work for the cache TTL with the same refusal and lose the activity silently, which is the phase-collision failure one level in. So an activity-bearing message caches only a commit certificate. The cost is that a replayed activity can re-drive a forward attempt; that is correct, because the work was never performed, and TTL decrement, breadcrumbs and the rate-limit bucket already bound it.
2. Else (not in-cluster): forward towards h by choosing the next hop that minimizes absolute ring distance to h using S/P (and optional finger cache). Optionally attach redirect hints (local near-h successors/predessors) to speed convergence.
   - Next-hop selection heuristic (connected-first bias):
     - Define cost(peer) = w_d·adjNormDist(h, peer) + w_b·backoffPenalty(peer), where adjNormDist is normDist discounted by an **allowance stated in binary orders of ring distance** (below). Connectedness and link quality are that allowance; they are not separate cost terms.
     - normDist scales absolute ring distance by the estimated network size N_est; use a "near radius" r_near ≈ (ringCirc / N_est)·β to detect proximity to the neighborhood.
     - **The non-distance preferences are expressed in orders of ring distance, because flat cost units are not commensurable with normDist.** normDist is a log-scale *position* whose entire dynamic range of 1.0 is spread over 256 binary orders, so one order of ring distance is worth only w_d/256 ≈ 0.0016 of cost. The former flat bonuses (w_conn ≈ 0.3–0.5, w_q = 0.1) therefore outranked 64–256 orders — up to the whole ring — and a connected candidate beat a disconnected one at *any* separation a real candidate pool can express. Stating each preference as a bounded number of orders keeps the bias and states its price.
     - When far (dist > r_near): a connected peer may give up **8 binary orders of ring distance** against a disconnected one (12 at confidence 0, 4 at confidence 1). 8 orders is one byte, matching the legacy connected-first path's `connectedToleranceBytes` default of 1, so both selector paths agree on what "slightly farther" means. Link quality gets a smaller allowance of up to 4 orders. These constants are reasoned from that legacy correspondence, not measured.
     - When near (dist ≤ r_near): require strict distance improvement (ε_near ≈ 0); prioritize most proximal candidates even if disconnected. Near candidates are ordered by distance alone, with the ring's lexicographic peer-id tie-break, so the whole cost function — the allowance above *and* the backoff term — is inert in near mode; inside r_near the runner-up is barely farther, so skipping a backed-off peer would buy little.
     - Backoff is deliberately left able to dominate distance: at the far weights a fully backed-off peer concedes ≈ 64 orders. A peer in backoff failed recently and may be gone, so a hop through it likely spends a full timeout and buys no progress — worse than a working hop that is merely farther. That is a stated decision rather than an artifact of scale; see the `NOTE:` at `farWeights` in `src/selector/next-hop.ts`.
     - **Strict improvement is measured against the node's own distance to the key, not merely among the candidates — and this is one rule applied in *both* modes.** The selector is given the node's ring coordinate; when it is supplied, only candidates strictly closer to the key than the node are eligible, and the filter runs *before* the near/far partition. Ordering candidates against each other cannot see this: with every candidate sitting behind the node, the closest-of-a-bad-set is still a hop *away* from the key, so messages drift backwards and only breadcrumbs plus TTL stop the loop. Forward progress is therefore a property of the selector rather than of the loop guards. `test/nexthop-cost.spec.ts` pins the invariant as a `fast-check` property over arbitrary pools, keys, self coordinates, near radii and confidences, asserting on the generated distribution so the far partition is provably reached.
     - Applying the floor before the partition **subsumes** the near-only filter it replaced rather than adding to it. When the node is near and no near candidate is closer, every far candidate has dist > r_near ≥ the node's own distance, so the general filter removes those too and the selector yields **no hop** — the deliberate "no fall-through to far mode", now falling out of the rule instead of being a special case. The only behavior it changes is the case it exists for: a far node whose candidates are all far may no longer pick one behind itself. No hop is an outcome both callers already handle: `routeAct` answers with a NearAnchor (hints, not a backwards hop) and `iterativeLookup` reports `exhausted`.
     - The floor is strict (`dist < selfDist`), never slack past the node's own position: the subsumption argument depends on it, and slack belongs among candidates, not against where the message already sits.
     - The node coordinate is optional to the selector and is supplied **only on the forwarding path**, because that is where backwards drift compounds into a loop. A node *originating* a lookup is aiming at the key's **cluster** — the k peers nearest the key, spanning both sides — not at the key point, so an originator that is itself the peer nearest the key must still contact a cluster member, and every one of them is farther from the key than it is; filtering there does not prevent a loop (the lookup's own already-contacted set does that) and only refuses to send, silently dropping the activity. Anchor selection for a NearAnchor reply never reaches this code at all — it calls the selector with no options and so runs the legacy connected-first path, where the node coordinate is ignored; that is fine, since anchors rank peers by closeness to the key as a hint for *another* peer's resend.
     - The forwarding path is also the case where withholding costs nothing: a node forwards only when it is *not* in-cluster, i.e. it sits at index ≥ the membership window (≥ 2) of the key's alternating two-sided cohort, which puts at least one peer (the nearer of the two anchors) strictly closer to the key than it is. A strictly-improving hop therefore normally exists, and no-hop means the closer peers were all excluded as breadcrumbs or undialable — a genuinely exhausted local view.
     - Confidence-aware, with the original direction preserved: when confidence is low, widen the connected allowance and reduce reliance on distance; when high, increase w_d and narrow the allowance. Update penalties as observations arrive.
3. TTL guards prevent loops; breadcrumbs help diagnose route quality.

Cheap-guard rejections (ordering vs the rate limit):
- **A structural validator runs immediately after the bucket and before every other guard** (`validateRouteAndMaybeAct`, `src/rpc/maybe-act.ts`): field types, finite numbers, a base64url-decodable `key` (decoded once in the handler and handed down to `routeAct`/`nearAnchorOnly`, so neither can throw on the field again), and caps on `key` / `correlation_id` / `breadcrumbs` sizes. All O(message size) — no hashing, no ring walks. A failure returns the same static reject as the other guards and increments `diag.rejected.malformed`. The position is load-bearing both ways: after the bucket so a malformed flood is metered like any other, before the remaining guards so none of them can throw on a field of the wrong type (a thrown guard used to leak the inbound stream). maybeAct-only today; `tickets/plan/15-rpc-shared-helper` generalizes it to the other wire messages.
- **The maybeAct token bucket is taken first, before any per-message work at all** — before the malformed-structure check above, the breadcrumb-loop check, the dedup lookup, the timestamp check, the TTL check and the payload-size check. Any other order leaves the guards themselves unmetered, so a flood of trivially-invalid messages (stale timestamp, `ttl: 0`) would never touch the bucket while still costing the receiver per-message work. A message rejected by a guard therefore spends a token exactly like a valid one; the reply on an empty bucket is the usual `Busy` + `retry_after_ms`.
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
- **Member-scoped.** The estimate counts only this network's members (`membership === 'member'`), so a co-resident foreign network sharing the transport cannot inflate `n_est` or the derived cluster span / near-radius. `estimateSizeAndConfidence` takes an options bag (`SizeEstimateOptions`) whose `filter` is the member gate `FretService` supplies; the exported standalone defaults to counting every entry, leaving the simulator unaffected.
- **The gap population is the S/P window, not the whole store.** The same options bag carries `selfCoord`, and supplying it is what selects the intended arc-length method: gaps are taken between adjacent members of the successor/predecessor window around self (self plus `neighborsRight`/`neighborsLeft` under the same filter, de-duplicated because a walk anchored at self returns self as its own first result on *both* sides — so each side is asked for `m + 1`, which is what makes the window the full self + m successors + m predecessors, i.e. G = 2m = 16 gaps at the default m = 8). Coordinates are re-centred on self as *signed* offsets so a window straddling coordinate 0 stays one contiguous run rather than splitting into two and manufacturing an interior gap the size of the ring.
  - **Omitting `selfCoord` is a documented degradation, not an equivalent path.** It falls back to consecutive gaps over every known coordinate and takes their median. A node's knowledge is deliberately non-uniform — it knows *every* peer adjacent to itself but only a sparsity-weighted scattering of far ones (see `selectDiverseSample`) — so whole-store gaps mix ~2m near-true spacings with a long tail of huge far-peer gaps. Once far peers outnumber near ones, which is the normal steady state, even the median lands in that tail and `n_est` collapses by one to two orders of magnitude, inflating cluster span by the same factor until every node believes it is near-cluster. Measured on a uniform-random ring with a node knowing self + 8 successors + 8 predecessors + 32 far peers: whole-store median returned 97 for a 2000-peer ring (−95%) where the S/P window returned 2462 (+23%). The four in-service call sites all pass `selfCoord`; `getNetworkSizeEstimate` is public and synchronous, so it passes the cached coordinate and falls through to the whole-store path when called before `start()` has hashed it.
  - **Neither population includes the wrap-around gap** (last coordinate back round to the first). A node's view of the ring is never complete, so that gap spans the arc it has *not* sampled: it is the single largest outlier in the population, and including it kept the dispersion factor below pinned near a constant on exactly the well-sampled windows it was meant to reward.
- Maintain online estimate (n_est, confidence ∈ [0,1]):
  - Arc length method: mean gap between consecutive S/P members; n_est = 2^B / avg_gap
  - Finger sampling: probe random points, measure hop counts; use exponential decay model
  - Weighted average of both methods; weight by method confidence
  - Peer-reported estimates: when a received `NeighborSnapshotV1` carries `size_estimate` and `confidence` (both positive), the receiver feeds them into its local estimator as an external observation (`reportNetworkSize`, source `snapshot:<peerId>`). This happens on both the announce path (`mergeAnnounceSnapshot`) and the fetched-neighbor path (`fetchAndMergeSnapshot`). Snapshots advertise the sender's *raw* FRET-local estimate (not its blended `getNetworkSizeEstimate`), so blending received estimates does not re-amplify already-blended values. Observations are bounded by a sliding time window and a max count. NOTE: these reports are unauthenticated — see the planned size-consensus / bounded-gossip work in `tickets/` for Sybil-resistant aggregation.
- Confidence calculation — an even blend of *how many* gaps were sampled and *how well* their mean is pinned down:

```
G     = number of gaps in the population above
cv    = sd(gaps) / mean(gaps)          // coefficient of variation
cvEff = max(cv, 1)                     // exponential-gap prior (see below)
rse   = cvEff / sqrt(G)                // relative standard error of the mean gap
dispersion = clamp(1 - rse, 0, 1)
sizeFactor = min(1, count / 2m)        // count = peers passing the member filter
confidence = clamp(0.5*sizeFactor + 0.5*dispersion, 0.05, 1)
```

  - Flooring `cv` at 1 encodes the prior that gaps on a uniform-random ring are exponentially distributed, so `cv ≈ 1` is the *healthy* value, not a defect: a synthetically perfect (evenly spaced) sample cannot claim zero sampling error from a handful of gaps. It also makes confidence monotone in window size and caps it at `0.5 + 0.5·(1 − 1/√G)` — 0.875 at G = 16, ~0.65 at G = 2.
  - This replaced a `minGap / maxGap` variance factor that was ~0 on any random ring (measured 4.4e-5 at n = 1000), which pinned confidence at exactly 0.5 for every node knowing ≥ 2m peers. Every consumer — `shouldIncludePayload`, the confidence-weighted next-hop cost, the ≥ 0.3 operation gate — treated that constant as if it carried information about sample quality.
  - **Known blind spot: dispersion is a purely local statistic.** A node whose neighbors are all packed into a tiny, evenly-spaced arc — an eclipse, or a very young ring — scores a high dispersion factor while `n_est` is wildly wrong, because no statistic over the sampled arc can see the arc that was never sampled. The defense is corroboration from peer-reported estimates (`reportNetworkSize` / `calibrateSizeFromSnapshot`), not a better local formula.
  - Zero if disconnected from bootstrap or |S∪P| < m/2
  - Decay by factor 0.95 per minute without updates
- **Blending FRET's estimate with peer reports** (`getNetworkSizeEstimate`) uses two *different* weightings, and the distinction is load-bearing. The size is weighted by recency × confidence, so a recent, confident observation dominates. The reported confidence is weighted by recency **only** — dividing a recency-weighted numerator by an unweighted observation count instead makes every observation older than "now" drag the average toward zero even when all observations agree perfectly (four agreeing observations at 0.5, spread over the 5-minute window, reported 0.23). The local FRET estimate is always the first observation, so the observation list is never empty; the reachable degenerate case is every observation carrying confidence 0, and both denominators guard it.
- Usage:
  - Operations require min confidence (e.g., 0.3) to proceed
  - Cluster span estimate = k * (2^B / n_est)
  - Near-radius r_near = β * cluster_span where β ∈ [1.5, 3]

### libp2p integration
- **`Libp2pFretService` is a thin facade over the core service, and it takes its node from either of two places**: the explicit `setLibp2p(node)` injection (which wins, because it is always available) or the `libp2p` component the host passes to the constructor. Only the injection used to be read, so a service registered the ordinary libp2p way — `libp2p({ services: { fret: fretService() } })` — threw "node not injected" on `start()` despite having been handed a node. Neither source present is still a loud throw, from `ensure()` alone rather than restated at `start()`.
  - The facade re-exposes a **subset** of the public `FretService` surface as hand-written pass-throughs, so the two are tied structurally (`implements Pick<FretService, …>`) rather than by convention. Without the tie they drift silently — which is how the facade kept handing callers `Record<string, any>` metadata after the interface itself had been tightened to `unknown`. Widening the facade means naming the method in that `Pick`; a signature that no longer matches is a compile error.
- Discovery: implement a libp2p peerDiscovery-compatible interface backed by FRET's Digitree. Emits peers from S/P/F (pruned, debounced).
  - **`FretPeerDiscovery` is the single emission path.** It is built once by `Libp2pFretService` and exposed through `peerDiscoverySymbol`, which is how libp2p itself picks a discovery mechanism up: the node reads that symbol off each configured service during construction and subscribes to the returned object's `peer` event, merging what it hears into its own peerStore. Dispatching a `peer:discovery` event straight at the node object instead — which two now-deleted paths did (`seedDiscovery`, `FretService.emitDiscovered`) — only reaches application code that added a listener to the node; libp2p's event forwarding runs internal → node, never node → internal, so the peerStore never saw those announcements at all.
    - **What the peerStore merge actually buys, precisely.** libp2p v3 has no auto-dialer (only a reconnect queue for peers tagged `KEEP_ALIVE`), and the emitted `PeerInfo` carries no multiaddrs, so a discovery emission does *not* cause a dial. What it does: creates the peerStore entry for a peer libp2p had never heard of, and — because a first-time `peerStore.merge` fires `peer:update` with no previous value — makes libp2p re-dispatch `peer:discovery` on the node, so application listeners still see it. The gain over the deleted paths is the peerStore entry plus the member/non-dead/non-self filtering, not reachability; reachability needs address hints on the wire.
  - Because the symbol is read *during node construction*, the discovery object must exist before the node does — and the FRET store hangs off the node. So `FretPeerDiscovery` takes its store as a **lazily resolved source** (`DiscoverySnapshotSource`, a `{ store, selfId }` thunk) rather than a captured reference; a thunk returning `null` means "not ready", and the scan tick is a no-op that leaves the interval armed. A bare `DigitreeStore` is still accepted and means "no self id known". libp2p only registers the listener, so `Libp2pFretService.start()`/`stop()` still drive the scan loop — started after `core.start()`, so the first scan sees a peerStore-seeded table.
  - **Member-only, non-dead, never self.** Each tick (`scanOnce`) resumes a *paged sweep* of the store and emits up to `batchSize` peers, so a peer is emitted on the lap after the probe pass classifies it `member`, and a foreign or unclassified peer is never surfaced to libp2p's discovery pipeline (which would re-seed it into selection upstream). Self is excluded explicitly: it is seeded `member` and lives in the store like any other peer, and libp2p logs an error when a discovery mechanism reports self. One debounce map bounds re-emission; the emission rate is `batchSize / emissionIntervalMs` (20 per 5 s = 4/s by default), which is why no separate token bucket is needed. That debounce map is capacity-bounded and profile-tuned (`maxTracked`, Core 4096 / Edge 1024) with a lifetime of `debounceMs`, and it is swept on every scan tick, so its memory ceiling is stated at construction rather than emerging from the debounce window.
    - **The sweep resumes; it does not restart.** The tick asks the store for one page of a resumable ring walk (`DigitreeStore.walkFrom`) beginning **strictly after** the last peer emitted, wrapping past the end of the ring. The cursor is an opaque token minted by the store, because the position it names is the store's private tree key (`hex(coord)|id`) and a second copy of that key rule outside its owner is how ordered reads silently break. Strictly-after rather than at-the-cursor is load-bearing: resuming *at* it re-emits that peer whenever its debounce has lapsed, spending a slot every page and — at `batchSize` 1 — never advancing at all. The wrap is what keeps strictly-after correct on a one-peer ring, where "strictly after X, wrapping" is X itself.
    - **Consequences.** The whole table drains in `ceil(N / batchSize)` ticks for any population N and any `maxTracked`, so `batchSize` costs latency, never coverage. `maxTracked` is therefore a pure memory bound; its only remaining effect is to shorten the effective debounce to ≈ `maxTracked / (batchSize / emissionIntervalMs)` once the live-member population exceeds it, i.e. a peer is re-announced once per lap rather than once per `debounceMs`. That is harmless — re-announcement is idempotent in libp2p's peerStore and the outbound rate is hard-capped at `batchSize / emissionIntervalMs` regardless — which is why the Core 4096 / Edge 1024 split is kept: it is a profile-scaled memory ceiling, and an edge node should hold fewer entries. The debounce map is still needed: on a small ring a lap completes in a single tick, so without it the same few peers would be re-announced every 5 s. `stop()` clears the cursor alongside the map, since a start→stop→start cycle is a fresh run. Coverage is pinned by a `fast-check` property over (population, `maxTracked`, `batchSize`) in `test/peer-discovery.spec.ts`, which asserts on its own generated distribution so the population > capacity region is provably exercised; the tick is a directly-callable method so the property drives it without the scheduler.
  - **Emitted `PeerInfo`s carry no multiaddrs — FRET discovery is peerStore-relative by design.** FRET's wire format carries no addresses at all (see *Dialability*), so the only addresses available locally are the ones libp2p's peerStore already holds; filling them in would merge a peerStore's contents into itself. Changing this needs address hints on the wire.
- Protocol IDs and message formats (length-prefixed UTF-8 JSON):
  - /fret/1.0.0/neighbors - JSON-encoded NeighborSnapshot
  - /fret/1.0.0/maybeAct - JSON-encoded RouteAndMaybeAct
  - /fret/1.0.0/leave - JSON-encoded LeaveNotice
  - /fret/1.0.0/ping - JSON-encoded PingLite
- Stream management:
  - Stream caps: FRET passes no `maxInboundStreams` / `maxOutboundStreams` to any `node.handle`, so every protocol runs at libp2p's defaults — 32 inbound / 64 outbound streams *per protocol per connection* — regardless of profile. A profile split (Edge 32/64, Core 128/256) was stated intent here but never implemented; see `tickets/backlog/debt-inbound-stream-caps-unimplemented` for the gap.
  - Stream read deadline: one overall budget per **whole outbound RPC** — dial + stream open + write + read, not the read alone (`RPC_TIMEOUT_MS`, 5s default, exported from `src/rpc/protocols.ts` so the four outbound RPC families cannot drift apart). Per-call-site overrides: `MAINTENANCE_RPC_TIMEOUT_MS` (2000ms, `fret-service.ts`) on maintenance pings and announces; `sendMaybeAct` is deliberately left at the 5s default because it is a *route* budget rather than a link one — the call returns only once the entire remaining route has completed downstream, so tightening it truncates healthy long routes (`src/rpc/maybe-act.ts`); `SHUTDOWN_BUDGET_MS` (3000ms, `fret-service.ts`) bounds the whole leave fan-out, with `LEAVE_NOTICE_TIMEOUT_MS` (1500ms) per notice so one stalled peer cannot eat it whole — that fan-out cannot reuse the run signal, since it runs *after* that aborts, by design. There is deliberately **no** per-chunk idle timer — a gap between chunks is a slow link, not end-of-stream, and an idle timer truncated healthy transfers into malformed JSON and failure-scored the (healthy) sender. libp2p v3's `close()` half-closes, so `iter.next()` resolves `{ done: true }` on genuine EOF; the overall deadline is what bounds a peer that stalls mid-payload. Exceeding it throws a read-timeout error rather than returning the partial buffer, so a timeout is never mistaken for a short-but-valid message.
  - **A reply that fails partway through is never an answer, and its stream is always released.** Three failure shapes reach a sender — the reply resets mid-stream, the peer closes tidily mid-JSON, or bytes arrive and then stop — and none of them may surface a partially-parsed message or leak the outbound stream. `test/rpc.stream-errors.spec.ts` drives all three against every sender that can meet them, and pins release-exactly-once: `abort()` once a signal has fired (a stalled remote must not be cleaned up with the unbounded `close()`), `close()` otherwise. **Which arm runs is not deterministic when the read ends on the RPC's own budget** — `releaseRpcStream` aborts only if the deadline signal has already fired, and `readAllBounded`'s own `Date.now()`-based expiry can beat that `setTimeout` — so only the count is an invariant there; the arm itself is pinned where a caller's signal is the sole clock.
    The senders deliberately still disagree about *what* such a reply means — ping returns `ok: false`, `fetchNeighbors` fabricates an empty snapshot, `sendMaybeAct` throws — and the service consequently books a contact strike on the maybeAct path and none on the ping path for identical evidence. That divergence is pinned as today's contract, not endorsed; the discriminated result type in `tickets/plan/15-rpc-shared-helper` is what retires it.
  - **Inbound handlers release their stream on every path** — the receive-side mirror of the sender rule above. All five handlers register through one seam (`registerRpcHandler`, `src/rpc/protocols.ts`) that wraps the handler body: on success it closes the stream (`close()` early-returns once our write end is already closing or closed, so a handler that replied and closed for itself is not released twice), and on error it logs and `abort()`s — synchronous, so a stalled remote cannot hold the cleanup, the same reasoning as the sender-side `releaseRpcStream`. The error arm is skipped for a stream that already left `open` (reset by the remote — usually how the error arrived) and for one whose write end the handler already closed, since that reply is committed and a reset would destroy it. **`status` alone cannot answer "did the handler already release this?"**: libp2p streams are half-closable, so a stream stays `open` until the *remote* also closes its write end, which for every FRET sender happens only after it has read the reply — the write-end status is the load-bearing one. Before the seam a handler that threw mid-message logged and returned, leaving the inbound stream open forever; since streams are counted per protocol per connection (32, see the cap note above), ~32 unparseable messages permanently poisoned that protocol on that connection — version skew or an encoder bug on an honest peer silently broke its own link. The identity-mismatch drops on leave/announce close (a normal outcome), never abort. Pinned by `test/rpc.handler-fuzz.spec.ts`.
  - **The per-message byte cap bounds what the receiver *consumes*, not merely what it returns.** `readAllBounded` compares the cumulative length after each chunk and throws the moment it crosses `maxBytes`, so the source is abandoned rather than drained: a 4 MB body against a 256 KB cap is pulled `ceil(maxBytes / chunkSize) + 1` times and the rest is never asked for. That is the difference between a cap that costs an attacker one over-sized send and one that lets them push a whole payload through the receiver's memory before being refused, and it is *measured* (by counting pulls on a source that reports them) rather than inferred from the absence of a crash — see `test/rpc.codec-properties.spec.ts`. The wire caps themselves are per protocol and per profile: maybeAct 512 KB Core / 256 KB Edge, neighbors 128 KB Core / 64 KB Edge, leave a fixed 4096. **The maybeAct wire cap and the service's own activity cap disagree by 4× on Core** — the wire admits 512 KB while `handleMaybeAct` refuses an `activity` over a fixed 128 KB, *after* the whole body has been buffered. Pinned as today's behavior; tightening each RPC's cap to its real ceiling is an open arm of `tickets/plan/15-rpc-shared-helper`.
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

- **Classification probe pass.** `unknown` entries arrive from every network-agnostic seed (peerStore, `peer:connect`, bootstraps), from inbound snapshot merges, and from the replacement lists on leave notices (see *Leave*) — which is why this pass, not the leave handler, is what vets them. Because the member-only ring views (below) exclude `unknown` peers, a bounded pass on each stabilization tick pings up to N `unknown` peers directly from the store (preferring connected / has-addresses ones — see *Dialability* below) so an unclassified same-network peer is resolved within ~1 tick rather than starved. It reads the store directly, *not* the gated ring views, which is how it still sees unknowns. The pass runs only while unknowns exist; in single-network steady state every peer becomes `member` and it is a no-op.
- **Re-probe passes (foreign and dead).** A smaller companion pass re-probes peers the ring views exclude, so an exclusion is never a one-way door. It runs two arms over the same mechanics — off-backoff and reachable candidates only, ascending backoff factor first, a small per-tick budget, one namespaced ping each — differing only in which peers they select and how many per tick: `foreign` (Core 2 / Edge 1) and `dead` (Core 2 / Edge 1). The budgets are **separate rather than one merged candidate list** so a large foreign population cannot starve dead recovery; by the saturation arithmetic below the foreign arm is already near its ceiling at roughly 42 foreign peers, and a merged list would queue every dead peer behind that. The arms are disjoint — a peer that is both `foreign` and `dead` belongs to the dead arm alone, and a successful ping there fixes both labels at once, since the success path applies the membership signal and clears the contact-failure run together. The classification pass over `unknown` peers skips `dead` candidates for the same reason.
  - The **dead arm** exists because a dead peer is out of every ring view, so stabilization (which draws its probe targets from the successor/predecessor windows) never touches it again — see *Recovery* under Stabilization for why nothing else brings it back.
  - The **foreign arm** re-probes a couple of `foreign` peers per tick. Before the member-only ring views landed, a same-network peer that was *mislabeled* `foreign` (e.g. `identify` completed before it had registered our handlers) self-healed for free — `probeNeighborLatency` pinged near ring peers regardless of label. Gating excludes foreign peers from the ring, closing that path, so this RPC backstop replaces it: a successful namespaced ping re-admits a mislabeled peer to `member`. It is bounded — only a couple of off-backoff foreign peers per tick, and a confirmed-foreign probe records an exponentially-growing backoff (doubling each window, capped at 32×) so a *genuinely* foreign peer is probed at most ~once per window and tapers toward ~once/32s in steady state. Within the per-tick budget, candidates are ordered by **ascending backoff factor** — the factor is a proxy for how many times we already confirmed a peer foreign, so a freshly-demoted peer (the one most likely to be mislabeled) is serviced before a long-confirmed foreign one rather than queueing behind it. That ordering matters because the pass's throughput is small: with F genuinely-foreign peers in steady state, peers come off backoff at ≈ F/32 per second while the pass services ≈ 2 per 1.5 s tick ≈ 1.33 per second in passive mode, so above roughly F ≈ 42 the pass is saturated. (Arithmetic from those constants, not a measurement — and the reason mislabelling is fixed at the labelling site, per the evidence-strength ordering above, rather than in this recovery budget.) (The `peer:update` identify path above also re-admits, but it is not guaranteed — it depends on the remote pushing an identify update — so the re-probe is the dependable path.)

**Why the run must be spread over time.** A "run" of failures only distinguishes *persistently absent* from *momentarily absent* if the observations are independent. Concurrent callers — several inbound `maybeAct` requests forwarding to the same restarting hop, say — all fail in the same instant against the same blip; that is one observation, not three. So a failure landing within 500 ms of the last counted one is ignored rather than counted, which makes a burst unable to reach the threshold on its own. The spacing sits well under the shortest interval at which the probe passes can legitimately re-observe a peer (the 1 s first backoff window), so genuine sequential failures are never swallowed and the ~7 s time-to-label for a genuinely foreign peer is unchanged.

`negotiateFailures` lives on the routing-table entry (rather than a service-local map) so it is evicted with its entry for free. It is exported in `SerializedPeerEntry` for diagnostics but **reset to 0 on import**, for the same reason `state` is forced to `disconnected`: handshake history cannot survive a restart. Its companion `lastNegotiateFailureAt` (the spacing timestamp) is not serialized at all — unlike the count it carries no diagnostic value across a restart. The store stays network-agnostic — it stores and exposes both fields and never branches on them, exactly as it already does for `membership`.

Labels are durable across the network-agnostic re-seeds (`upsert` preserves an existing entry's full mutable state — relevance, health counters, state, membership, and metadata — refreshing only coord and lastAccess; defaults are applied only for a genuinely new peer) and reversible in both directions (no state is permanent). Foreign peers are tagged and retained rather than evicted — an evicted foreign peer is just re-added by the next connect/seed and re-probed in a loop.

#### Network-scoped admission (member-only ring views)

Every ring-shaped read is **live-member-only**: a peer participates in this network's ring only once its `membership` is `member`, and only while its `state` is not `dead`. Concretely, a peer that is `foreign`, still `unknown`, or marked `dead` (see *Stabilization and churn handling*) is never a neighbor, cohort member, routing candidate, size-estimate contributor, snapshot sample entry, or discovery emission for this network. Self is seeded `member` and is never marked dead, so it always participates; a single-node ring still self-reports a size estimate of 1.

The two exclusions are **one predicate** (`isLiveMember`: `e.membership === 'member' && e.state !== 'dead'`) rather than a second guard added to each reader, so every ring-shaped read inherits both at once and a reader added later cannot forget one. It lives in its own module (`src/service/live-member.ts`) rather than inside `FretService`, because `FretPeerDiscovery` is a ring-shaped reader too and sits outside that class; while it held its own copy of the two conditions the invariant was a convention rather than a fact. The store stays network-agnostic — it never names `membership` — so the predicate is passed *into* its walks. Both exclusions are recoverable and independent: a peer can be `foreign` while perfectly alive, or `dead` while still labelled `member`, and each has its own way back (`identify` / a successful namespaced ping for membership, any proof of life for liveness).

The gate is applied **inside the ordered ring walk**, not by post-filtering the result. `DigitreeStore`'s `neighborsRight` / `neighborsLeft` / `successorOfCoord` / `predecessorOfCoord` take an optional `filter` predicate; on a miss they **skip and keep advancing** rather than stopping, so a cluster of foreign peers sitting nearest a key cannot starve the cohort (the alternating walk over-fetches `wants * 2` and still collects `wants` members). A bounded-scan guard caps a filtered walk at one full traversal (`size()` entries) so a ring with zero matching entries terminates instead of spinning on the wrap-around. The store itself stays network-agnostic — it never names `membership`; the callers pass `isLiveMember` in. With no filter (the default) behavior is byte-for-byte unchanged, so direct store users (e.g. the design simulator) and the exported `assembleCohort` / `estimateSizeAndConfidence` / `selectDiverseSample` standalones are unaffected.

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
- **"Avoid serial dial chains" is now literally true of the warm-up passes themselves, including the one at start-up.** Both warm-up passes — the one-shot pass at `start()` (up to `min(6, m)` peers per side, so up to 12) and the active-mode tick (Core 6 / Edge 3 per second) — used to walk their targets one ping at a time, so a pass was the *sum* of its round trips and three unreachable neighbors cost three chained 2 s `MAINTENANCE_RPC_TIMEOUT_MS` timeouts before the reachable ones behind them were warmed at all. That is exactly the shape active mode exists to prevent, and the start-up pass had it worst (widest target list, and it runs when nothing is warm yet). Both now share one pooled fan-out (`pingWarmupTargets`) at the same `maintenanceConcurrency` cap the stabilization tick uses — Core 6 / Edge 2 — so a pass costs about its slowest single ping rather than their sum. Two differences from the tick, both deliberate: the pool's signal is the **run signal**, not a tick deadline (neither pass runs inside `stabilizeOnce`, so there is no tick budget to inherit; the per-ping timeout bounds each task and `stop()` collapses the whole fan-out at once), and `isDialable` is filtered *before* both the task list and the active tick's per-second budget, so neither a pool slot nor a budget slot goes to a peer that can only fail to dial — filtering after the budget slice let a run of undialable near peers consume the whole budget and warm nobody. Neither pass scored anything against a peer before and neither does now: `pingsSent` counts only a completed ping, a task that fails under an aborted run logs nothing, and a task the pool never started is `skipped`, so a cancelled run issues no dial at all — including a `stop()` that lands *while* tasks are in flight, where the started pings abort and the unstarted ones are never dialed. `test/preconnect-concurrency.spec.ts` pins the cap (high-water mark *equals* it), the dialable-first filter on both the pool and the budget, mid-pass cancellation, and the headline case: three unresponsive neighbors cost the pass one timeout, not three.

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
- deadAfterFailures (consecutive failed *contacts* before a peer is marked dead): 3, spaced ≥ 500ms apart

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
- **The pre-dial concurrency above (Core 6 / Edge 2) is one number, and it governs every pooled outbound maintenance RPC, not only warm-up dialing**: the stabilization tick's two phases, the start-up warm-up pass, and the active-mode warm-up tick all draw from the same cap (`maintenanceConcurrency`). It was reused rather than re-invented because these are the same resource — a burst of outbound streams from one node — and a second knob would only drift from this one. Edge's 2 is deliberately conservative: an Edge tick truncates on its budget more often, which is this profile's stated "fewer probes per window" posture rather than an oversight. The per-pass *budgets* stay separate and profile-tuned (how many peers a pass may target); the cap is only how many of them may be in flight at once.

### Security and abuse considerations

See [threat-analysis.md](threat-analysis.md) for comprehensive threat modeling and [threat-rir-mitigated.md](threat-rir-mitigated.md) for residual posture with Right-is-Right.

#### Current state
- Timestamp bounds (±30s) for message freshness, deliberately equal to the dedup TTL below. Any slack between the two is a replay window — a captured message whose dedup entry has expired but whose timestamp still passes is accepted and re-performed — so the two constants move together (`DEDUP_TTL_MS`). A deployment with poor clock sync can pass a wider window per call, at the cost of re-opening that gap.
- Correlation ID + phase dedup cache (30s TTL; capacity 2048 Core / 512 Edge) for maybeAct — the key is the correlation ID paired with whether the message carries an activity, so a digest probe and the activity resend sharing that ID get separate cache slots, and only a terminal answer is stored (see the routing rule above). Capacity is profile-derived because an entry evicted before its TTL is a replay hole: Core carries the higher inbound rate and so is given 4× the slots, while Edge's tighter inbound maybeAct rate limit already caps how fast its cache can be churned. Eviction at capacity drops the oldest-inserted entry, which under the single constant TTL is also the entry nearest to expiry — so a live entry is only ever the victim once no expired one remains, and no expiry scan is needed to find it. Re-storing an answer under a key already cached is a refresh, not an insert: it never evicts, and it moves that key to the back of the eviction queue.
- Correlation IDs are minted from the WebCrypto RNG (`crypto.randomUUID`, falling back to `crypto.getRandomValues` where `randomUUID` is unavailable — React Native, older browsers). `Math.random` was predictable from observed outputs, which let an attacker pre-fill a peer's dedup cache with answers for requests not yet sent. The self-id and timestamp prefixes are traceability only and need not be secret.
- Rate limiting via global token buckets (per-protocol, profile-tuned Edge/Core), including the inbound announce handler (gated before any merge work; on rejection the message is dropped and `diag.rejected.rateLimited` increments). Each bucket is taken **before** the handler's own validity checks, so invalid messages are metered too — see *Cheap-guard rejections* under the maybeAct routing rule for why that ordering is load-bearing.
- Inbound snapshot-merge caps: both the neighbor-fetch merge and the announce merge slice remote successors/predecessors/sample to the same per-profile bounds (Core 16/16/8, Edge 8/8/6) before iterating, so one crafted message cannot force thousands of parse+hash+upsert ops regardless of the 128 KB byte limit
- The service's two internal bookkeeping maps carry explicit profile-tuned capacities and a periodic sweep, so neither can grow without a stated ceiling: the per-peer probe **backoff map** (capacity: Core the routing-table capacity of 2048, Edge `min(capacity, 512)`) and the **departure-announce debounce map** (Core 512 / Edge 128, lifetime 2 s). The backoff map's retention lifetime is deliberately *not* its backoff window — an entry whose window has passed is kept so the next failure doubles the factor rather than restarting at 1, and it is forgotten only after `BACKOFF_RETAIN_MS` (5 min) without a further failure, which must comfortably exceed the longest backoff window (1 s × 32 = 32 s) or a peer probed at the slowest cadence would silently reset to factor 1. Both are swept at the top of each stabilization tick, alongside the store-membership prune that drops entries for peers no longer in the routing table (orthogonal to expiry — no lifetime can see that a peer left the store). Both are cleared by `stop()`: a start→stop→start cycle is a fresh run, and carrying a peer's escalation across it is the same mistake as carrying `negotiateFailures` across a restart.
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
  - (Treating suggested replacements as untrusted hints is **done** — see *Leave* above.)
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
  - The run-scoped `AbortController` (`runAbort`) is minted alongside `runGen` on `start()` and
    aborted on `stop()` right after the loop timers are cleared and before the leave fan-out —
    which carries its own budget (`SHUTDOWN_BUDGET_MS`), which is why aborting `runAbort` does not
    silence it. The aborted controller is deliberately kept rather than nulled, so a late read from
    an interrupted tick still reports "cancelled" instead of "no signal at all".
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
  - **Every stored coordinate is exactly `COORD_BYTES` (32) wide,** enforced at that same write
    seam. Because the tree key is `hex(coord)|id`, a short or long coordinate yields a
    wrong-length key that sorts into an arbitrary ring position — every ordered read then
    silently returns the wrong peers, with no error anywhere. Checking once at the seam makes
    the bad state unrepresentable in the store no matter which decode path produced the bytes,
    rather than relying on each decoder to validate. The decoders validate too
    (`base64urlToCoord` rejects a wrong decoded length, `hexToCoord` rejects anything that is
    not exactly 64 hex characters — previously `parseInt` on a non-hex pair returned `NaN`,
    which coerces to `0` when assigned into a `Uint8Array`, so garbage decoded to a plausible
    near-zero coordinate), so a malformed wire value is rejected at the boundary it entered by
    and the seam is the backstop.
  - Bounded capacity with victim selection; S/P protected by the protection set described under *Relevance scoring and table management*, not by a score.
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
  - **`exhausted` covers cancellation, not only a used-up ring.** `RouteProgress` (`src/index.ts`)
    has no `cancelled` variant — it is part of the public `FretService` interface, and adding one
    is an API change every consumer would have to learn — so a lookup whose run signal aborted
    mid-walk yields the same `{ type: 'exhausted' }` as one that genuinely ran out of hops. On the
    activity-resend arm this means the activity was never delivered. A caller cannot tell the two
    apart from the event alone and must re-check service state before concluding the ring was
    exhausted; in particular, an undelivered activity is a possible outcome of `exhausted`, not
    only of an explicit error.
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
- **Unmeasured latency is `null`, not `0`, and scores neutrally.** `avgLatencyMs` is `number | null`; `null` means no round trip to that peer has ever been timed, and it takes the midpoint latency penalty (0.5) — so an unmeasured peer sits strictly between one measured at 0 ms (penalty 0, the best possible link) and one measured at 1000 ms or worse (penalty 1). The distinction is load-bearing rather than cosmetic: pings are timed with `Date.now()`, whose granularity is ~15 ms on Windows, so a localhost or same-process peer routinely measures 0 ms. While `0` doubled as the "no data" sentinel, such a peer scored *below* one measured at 300 ms (relevance 1.389 vs 1.461 on otherwise identical entries) — and relevance drives both next-hop preference and capacity eviction, so the faster peer was preferred less and evicted sooner. The nullable also makes "I have no measurement" unwritable as a number, which is what stops a caller with nothing to report from fabricating a 0 ms sample.
- **Only a measured round trip to *that peer alone* is a latency sample.** `recordSuccess` takes an optional `latencyMs`; a caller that completed an RPC but timed nothing one-hop omits it, and the peer's average is left exactly as it was. The forwarded-`maybeAct` path is the case in point — it returns only once the entire remaining route has completed downstream, so its wall time is the cost of the whole subtree, not of the link to the next hop, and recording it would penalize a healthy adjacent peer for a long path behind it. Latency belongs to the ping paths (`probeNeighborLatency`, `probeMembership`), which measure one hop.

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

All five wire messages — and every reply — are JSON **objects**. `decodeJson` (`src/rpc/protocols.ts`) rejects any non-object top-level value (the literal `null`, an array, a number, a string, a boolean) at the decode boundary, so no handler body ever null-checks what it decoded. It also trims NUL/tab/LF/CR/space from both ends before parsing, so a muxer that pads a short frame does not surface as a JSON syntax error inside a handler; a body of nothing but padding is refused rather than parsed.

**The codec is lossless on everything these formats admit, with three stated exceptions.** `encodeJson` → `decodeJson` is the identity on every field below — lone surrogates included, since `JSON.stringify` has been well-formed since ES2019 and escapes an unpaired code unit rather than letting UTF-8 mangle it. What does not survive: `-0` arrives as `0` (no FRET field distinguishes the two — relevance, latency and estimates are all magnitudes); `NaN` and `±Infinity` arrive as `null` (unreachable from routing logic, which rejects a non-finite `ttl` / `want_k` / `min_sigs` / `timestamp` in `validateRouteAndMaybeAct`); and an own property whose value is `undefined` is dropped, so `undefined` can only mean *absent* on the wire and `null` is the value that round-trips. All three are pinned as contract — not endorsed — by `test/rpc.codec-properties.spec.ts`, which also proves the round trip over generated instances of all five wire types plus `SerializedTable`, and proves both halves of the coordinate codecs (`base64urlToCoord` / `hexToCoord` accept exactly a 32-byte coordinate and reject everything else).

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
  metadata?: Record<string, unknown>;  // sender's own application metadata (setMetadata); the
                                       // receiver stores it against the sender's routing-table
                                       // entry only after checking it is a non-array object,
                                       // since wire JSON cannot be trusted to match the type
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
  contactFailures?: number;     // consecutive failed contact attempts; exported for diagnostics, reset to 0 on import
                                // (so an imported table never carries a `dead` peer — `state` is forced to
                                // 'disconnected' and the counter that would re-kill it is cleared alongside)
  accessCount: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number | null;  // EMA of measured RTT; null = never measured. A field absent
                                // in a pre-nullable snapshot reads back as null.
  metadata?: Record<string, unknown>;
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
- **Import**: `importTable(table)` deserializes entries back into the Digitree. All imported entries have their state forced to `'disconnected'` since connection liveness cannot survive a restart. Membership labels are preserved (a persisted table is same-network by construction); a missing `membership` field in an older snapshot defaults to `'unknown'`. Capacity enforcement runs after import, so importing a table larger than the local capacity evicts lowest-relevance entries as usual. `importTable` is `async` — capacity enforcement needs the self ring coordinate (a SHA-256 hash of the peer id), and import is commonly called before `start()` has cached it, so enforcement awaits the hash rather than skipping it. Callers must `await` the call; a fire-and-forget `importTable(...)` races enforcement against whatever runs next.
  - **A malformed coordinate rejects the whole snapshot, and nothing is written.** A corrupted persisted table is better refused loudly than admitted as ring state, so `importEntries` decodes every record's coordinate before it writes any of them — a mid-loop throw would otherwise leave a half-imported table behind *and* skip the capacity enforcement that runs after the call. Callers restoring an untrusted file should wrap `importTable` and fall back to a cold bootstrap. (Snapshot *sample* entries arriving over the wire are handled differently: those merge loops already skip-and-log per entry, so one bad sample drops that entry, not the message.)
  - **Replace by id.** Import is public and nothing stops a caller invoking it after `start()`, at which point self and any peer-store-seeded peers are already in the table. A snapshot record for an id already present therefore *replaces* that entry outright, including a coordinate move — the snapshot is the more recent view of that peer, and the alternative (leaving the existing entry in place) both discards the restored data and, on a coordinate move, strands the old entry in the tree unreachable by id.
  - **Returns the number of distinct ids stored**, not the number of input records, so a snapshot carrying an id twice reports 1.
  - **A snapshot never speaks for self.** Because replacement is unconditional, `importTable` drops the record whose id is the importing node's own before handing the rest to the store; the count therefore excludes self. Both fields that make self's entry authoritative come from the snapshot and both would be wrong: `membership` (absent in a pre-membership snapshot, `unknown` in one taken by another peer — either drops self out of every member-only ring view) and `coord` (a tampered one moves self off its own ring position, so capacity enforcement no longer protects it). Each would heal on the next stabilization tick's peer-store re-seed, but the local entry is better information than any snapshot's view of it, so there is nothing to import. Coordinate verification for *other* peers' records is a separate, still-open concern (see `tickets/`).
- **Persistence layer is external**: FRET only handles serialization/deserialization. The caller decides where and how to store the JSON (filesystem, IndexedDB, database, etc.).
- **JSON-safe**: The `SerializedTable` structure is fully JSON-serializable and survives `JSON.stringify` / `JSON.parse` round-trips.

Typical usage:
```
// Before shutdown
const table = fret.exportTable();
await fs.writeFile('fret-table.json', JSON.stringify(table));

// On startup
const saved = JSON.parse(await fs.readFile('fret-table.json', 'utf-8'));
const count = await fret.importTable(saved);
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
- Simulation: Large-scale churn patterns, partition/merge behavior. The deterministic harness
  (`test/simulation/fret-sim.ts`) splits the ring into mutually unreachable groups with
  `partition(groups)` and rejoins them with `heal()`:
  - Every cross-peer contact consults one reachability predicate. Pool-filtering sites (candidate
    lists, coverage math) use it silently; sites that model a real contact attempt count the
    refusal, so `crossPartitionBlocked()` reads as "contacts refused", not "ids filtered".
  - A peer learns about the cut only from its own failed contacts: an unreachable entry escalates
    through `contactFailures` to `dead` and then drops out of every ring-shaped read. Nothing
    consults the partition map on a peer's behalf, so "the neighbor sets went side-pure" is
    evidence of escalation rather than of the oracle.
  - A bounded dead-entry re-probe (ascending `lastAccess`, mirroring production's dead arm) is the
    path back after the heal; a merge never resurrects a locally-dead entry.
  - Coverage is measured against each peer's *reachable* alive population, so a healed ring reads
    as healed rather than as half of one. With no partition active the arithmetic is unchanged.
  - Pinned by `test/simulation.partition.spec.ts`: two-way, singleton and three-way splits;
    a leave during a cut reaching only the leaver's own side; in-flight messages dropped at the
    cut; a bus-mode run of the whole cut/escalate/heal lifecycle; mid-split joins; and
    deterministic replay of a full partition/heal schedule.
- Benchmarks: Routing latency, memory usage, message overhead

### Open questions / next steps
- Exact relevance weight tuning based on network simulations
- Optimal CBOR vs protobuf tradeoffs for different message types
- Identity cost mechanism for open-path Sybil resistance (PoW difficulty, stake, or hybrid)
- End-to-end payload encryption scheme compatible with progressive routing (cluster key agreement, onion encryption, or coordinator-targeted encryption with re-encryption on redirect)
- VRF-based ring coordinate rotation (epoch nonce rotates positions, preventing permanent ID grinding)
- Integration timeline with existing KadDHT-dependent code
