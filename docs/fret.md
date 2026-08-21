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
  - Access recency (EMA decay) and frequency (log-slowing). **Frequency counts proven contact, not hearsay.** `accessCount` is incremented only by a completed RPC or a direct interaction with the peer; being *named* by some other peer — in a merged neighbor snapshot, a leave notice's replacement list, or the configured bootstrap list — accrues none. Those paths go through one seam, `FretService.noteDiscovered`, which creates a missing entry and scores it **once** from its own empty counters (`initialRelevance`) and leaves an id we already hold completely untouched. So an id has the same score after a thousand mentions as after one, and mention count is not a lever an attacker (or a chatty honest peer) can pull. Without this a peer we had actually contacted hundreds of times could be evicted before one we had only ever been told about.

    The scoring helpers themselves (`applyTouch`, `applySuccess`, `applyFailure`,
    `applyContactFailure`) never create an entry — scoring a peer not already in the routing table
    is a silent no-op. Creation belongs to `noteDiscovered` and the explicit insert sites
    (`peer:connect`, bootstrap seeding, `importTable`); a peer only reaches scoring after one of
    those has already placed it.
    - The baseline exists rather than "gossip scores nothing at all" because stored relevance is only ever written by a scoring call: a never-scored entry sits at 0, and eviction takes the lowest unprotected entry — so on a full table every newly discovered peer would be evicted before the classification pass could probe it, and the table could never learn a new peer again. A fixed baseline avoids that starvation while staying flat in mention count.
    - An id already held is left alone rather than given a bare `upsert`, because `upsert` refreshes `lastAccess` — which is both the recency input *and* the ordering key for the unknown-classification probe rotation (ascending `lastAccess`), so refreshing it on gossip would sink a heavily-gossiped unknown peer to the back of its own probe queue.
  - Health: success/failure ratio and average RTT.
  - Sparsity bonus over distances: maintain a smooth blend of distances without hard buckets.
    - Compute normalized log-distance x ∈ [0,1] from self to peer (1 = far, 0 = near).
    - Maintain a tiny KDE over x with m fixed centers and EMA occupancy.
    - Sparsity bonus S(x) = clamp(((ideal(x)+ε)/(density(x)+ε))^β, sMin, sMax).
    - This increases score for underrepresented distances and tapers overrepresented ones.
  - Neighbors: entries in S(p) ∪ P(p) are retained regardless of score, unless excluded from the ring view.
- Victim selection: lowest score first, **skipping a protection set** — `FretService.enforceCapacity` walks the live members immediately around self (`ringNeighborsBothSides(store, self, max(2, m), selfId, { filter: isLiveMember })`, plus self's own id) and never evicts one, however low it scores. Two consequences that are behavior, not wording:
  - **The protected set is `2·max(2, m) + 1` ids** — self plus `max(2, m)` live members on each side. `ringNeighborsBothSides` (`src/ring/ring-walk.ts`) asks each side for `count + 1 + |exclude|` and trims back, so its `count` means *peers besides self*; without that over-fetch a walk anchored exactly on self spends a slot on self and protects only `m − 1` per side, leaving the m-th successor and m-th predecessor evictable. Self is added to the set explicitly rather than drawn from the walk, so a ring of exactly one peer (self) still protects it. Every self-anchored copy of the idiom now goes through the helper: the leave path (`sendLeaveToNeighbors` targets and `computeReplacements`), both announce fan-outs, the warm-up target gather, the near-neighbor test, and the size estimator's window walk. The one two-sided walk deliberately left outside it is the public `getNeighbors`, which is key-anchored rather than self-anchored and whose `wants` is both the per-side count and the total cap — a different contract, not a copy of this one; see the `NOTE:` at that method.
  - **Protection outranks the cap.** With `capacity < 2m + 1` the eviction loop runs out of unprotected candidates and the table stays over capacity. Unreachable at the shipped numbers (m 8, capacity 2048) and only reachable by misconfiguration; see the `NOTE:` at `enforceCapacity`.
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
  - **Two phases, with phase 2 holding a reserved slice of every tick.** Phase 1 pools the near peers, chaining ping → fetch **per peer** (`probeAndFetch`): `fetchNeighbors` is connection-only and it is usually the preceding ping that opens the connection, so the dependency is per peer, not "all pings, then all fetches". `enforceCapacity` runs once after phase 1 drains and the ids the merges saw for the first time are announced once — neither runs inside a pooled task (concurrent capacity enforcement would over-evict; a per-task announce would announce a peer per task). That one call is the tick's *only* capacity enforcement: `seedFromPeerStore` and `seedFromBootstraps` no longer trim for themselves, so the caller of an insert sequence owns its enforcement. `start()` therefore calls `enforceCapacity` explicitly after its own seed rather than leaving the bound to the first tick, which would couple a capacity bound to a timer being armed. Phase 2 pools the classification and re-probe *targets* together, but each list is still **selected** under its own budget and ordering (`classifyTargets`, `reprobeExcludedTargets`) — only execution is pooled; merging the candidate lists would repeal the separate-budgets rule. **Selecting them costs zero store walks in steady state and at most one otherwise.** The three arms' predicates each narrow one single-field label — `membership === 'unknown'`, `membership === 'foreign'`, `state === 'dead'` — so the O(1) per-label counts the store maintains at its write seam (see *Routing store (Digitree) & indices (A2)*) prove an arm empty without looking: `phaseTwoTargets` reads the three counts, returns immediately when all are zero (the single-network steady state, where every peer is a live `member`), and otherwise takes **one** `store.list()` and hands the same array to all three arms. Sharing the walk is not merging the lists — each arm keeps its own predicate, budget and ordering, so the candidate sets stay disjoint.
    - **Phase 1 has its own sub-budget, so it cannot starve phase 2.** Phase 1 runs under `STABILIZE_PHASE_ONE_BUDGET_MS` (3000 ms), a *child* of the tick deadline, and phase 2 runs against the tick signal. What is left of `STABILIZE_TICK_BUDGET_MS` after phase 1's slice is phase 2's reserve — 5000 − 3000 = 2000 ms, exactly one `MAINTENANCE_RPC_TIMEOUT_MS` ping — so even a phase 1 that runs to its own deadline leaves phase 2 able to complete a probe against a peer that is genuinely alive, which is the whole point of the classification and re-probe arms. This matters because phase 2 is the *only* path by which a `dead` peer is ever contacted again or an `unknown` one is classified, and the starvation was not self-limiting: a peer that answers the cheap ping but stalls the snapshot fetch never accrues contact failures, so it is never marked `dead`, so it stays in the near list and repeats the stall on every tick. `enforceCapacity` and the announce stay above phase 2's early return, so a phase 1 cut off by its **own** budget still enforces. The reserve alone is not sufficient — see the per-request arithmetic under *Stream management* — and the two changes compose.
    - **A near peer whose ping did not answer is not snapshot-fetched.** `probeNeighborLatency` reports whether the peer answered, by the round-trip rule under *Evidence strength* (`ok` / `busy` / `decode-error` answered; `unreachable` / `timeout` / `foreign-protocol` did not), and `probeAndFetch` skips the fetch when it did not — the fetch could only fail too, and it would spend up to `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` of phase-1 wall time doing so. This removes an RPC that could not have succeeded; it scores nothing and changes no verdict. The existing `wasCancelled` check stays *ahead* of that gate, so our own cancellation and "did not answer" can never disagree.
    - **The invariant these numbers must keep**, pinned as a test over the declared defaults in `test/stabilize-budget-invariants.spec.ts` rather than asserted at runtime (the test rigs mutate these statics down to tens of milliseconds, so a runtime assert would throw in them): `MAINTENANCE_RPC_TIMEOUT_MS + MAINTENANCE_SNAPSHOT_TIMEOUT_MS <= STABILIZE_PHASE_ONE_BUDGET_MS`, and `STABILIZE_PHASE_ONE_BUDGET_MS + MAINTENANCE_RPC_TIMEOUT_MS <= STABILIZE_TICK_BUDGET_MS`.
  - **Disjoint by construction, asserted not trusted.** The four candidate sets a tick pools — near = live member; classify = `unknown` non-dead; foreign arm = `foreign` non-dead; dead arm = `dead` — cannot name the same peer twice, which is what makes pooling safe against the lost-increment race on the score/strike counters (`applySuccess` / `applyFailure`). `test/stabilize-concurrency.spec.ts` pins the disjointness, the pool cap (high-water mark *equals* the cap, so the tick provably overlaps), the per-peer ping-before-fetch order, and the headline case: one hung near peer costs the tick its budget, not the other peers their probe and fetch.
  - **Truncation is not evidence.** Every pooled task compares against the tick signal it was handed (`wasCancelled`), so a budget expiry records no strike, no backoff, no relevance decay, no `pingsFail`, exactly like a `stop()` — see the cancellation bullet below.
  - **Candidate lists rotate, so a truncated tick never re-derives the same head.** Unknowns are ordered by ascending `lastAccess` before the budget slice (a probed one is bumped by `applySuccess` or backed off, so it rotates to the back with no bookkeeping); each re-probe arm orders by ascending backoff factor. The near list is the exception, kept in **ring order** (closest first) on purpose: those are the peers ring correctness depends on most, so a truncated tick should skip the 4th-closest and never the immediate successor.
- Failure detection and recovery:
  - Soft failure (timeout): decay relevance score by factor δ (e.g., 0.7). **Escalation is staged, not per-failure, and the near pass does not back off — except on a `busy` reply, which records backoff.** `probeNeighborLatency` — the pass that verifies the successor/predecessor windows — decays relevance and counts one contact strike on a failed contact, and records no backoff for it; `nearProbeTargets` has no backoff filter either, so a live member is re-verified on *every* tick (at most 4 near peers per tick) for at most `deadAfterFailures` (3) spaced strikes. The `busy` exception is deliberate new behavior from the sender migration: a peer answering busy has said it is overloaded, so the probe records backoff for it (`recordBackoff`, counted as `pingsSent` + `pingsFail`; no relevance decay, no strike). It *is* an answer on our namespaced protocol, so it still confirms membership and clears any contact-failure run — see the round-trip-not-reply-body rule under *Evidence strength*. The window is FRET's own escalating schedule (`BACKOFF_BASE_MS` × factor), **not** the `retry_after_ms` the reply carries — `RpcOutcome`'s `busy` variant exposes that hint but no caller reads it yet — the backoff is consulted by the routing path's cost penalty and by the off-ring passes should the peer later drop out of the ring. Exponential backoff otherwise belongs to the off-ring probe passes (`probeMembership`, used by the classify / foreign / dead arms) and to the routing path — which is where a peer lands once the strikes exclude it from the ring. Pinned by `test/failure-recovery.spec.ts`.
  - Hard failure: `deadAfterFailures` (3) consecutive **failed contacts** mark the peer `dead` in the Digitree. A failed contact is a failure to reach the peer *at all* — the outbound RPC threw because the dial, stream, or read failed. Deliberately **not** a failed contact: a peer that answered and refused to negotiate this network's protocol (that is membership evidence — see *Evidence strength* — and proves the peer is alive), a peer that answered `ok: false` (keeps its relevance decay), a `busy` reply (no decay either — it records backoff instead, see the escalation bullet above), and an idle `peer:disconnect`. None contributes a strike.
    - Like the negotiate-failure run, the contacts must be **spread over time** to be independent observations: a failure landing within 500 ms of the last counted one is ignored, so a burst of concurrent calls failing against one restarting peer cannot reach the threshold on its own. The count lives on the routing-table entry (`PeerEntry.contactFailures`, with `lastContactFailureAt` as the spacing stamp) so it is evicted with its entry, and is clamped at the threshold so it stays bounded for a peer we keep re-probing. Self is never marked dead — a dead self would drop out of every ring view with no path back short of a restart.
    - **Removal from S/P is ring-view exclusion, not a separate step.** FRET keeps no standalone successor/predecessor *set* — those windows **are** the filtered ring walk (see *Network-scoped admission*), whose predicate is `membership === 'member' && state !== 'dead'`. So marking a peer `dead` removes it from the successor/predecessor windows, cohorts, routing candidates, the size estimate, and the outgoing snapshot's neighbor lists and sample, all at once. It also drops out of capacity protection — `enforceCapacity` protects only the peers that same predicate returns around self — so a dead peer with a decayed relevance becomes a preferred eviction victim with no eviction-specific code. The maintenance fan-outs that walk the store *unfiltered* (announce targets, leave notices) carry their own dead skip for the same reason they skip `foreign` and undialable peers: the dial can only fail, and the leave fan-out runs inside `stop()`, where a stack of doomed dials also delays shutdown. That skip is **one shared predicate** (`isDoomedDial` — undialable, `foreign`, or `dead`; `unknown` is deliberately still a target), not a guard restated per fan-out, because restating it is how the two drifted apart in the first place. Re-probing a dead peer belongs to the budgeted dead arm below, which backs off; a fan-out would retry every dead peer every tick.
  - Recovery: any proof of life clears the run and restores a `dead` peer to `connected` (if a connection exists) or `disconnected` — a completed outbound RPC, an inbound RPC (which is what re-admits a peer we struggle to dial but that reaches us), or a fresh `peer:connect`. Relevance is deliberately **not** reset to a baseline: the ordinary success scoring already up-ranks the peer, and wiping the health counters would erase the record of one that flaps. Conversely a `peer:disconnect` never clears `dead` — a closing connection is not proof of life, and it is precisely the event that follows a run of failed contacts, so clearing the label there would re-admit the peer with its counter still clamped at the threshold and have the next failure re-kill it.
    - Proof of life has to be able to *arrive*, and once excluded from the ring nothing dials the peer: stabilization draws its probe targets from the successor/predecessor windows. The dead arm of the re-probe pass (see *Re-probe passes* under Ring membership) is therefore the path back for a peer that recovers but never dials us and never forms a connection — without it such a peer stays dead until evicted at capacity, since `upsert` preserves `state` and a peerStore re-seed does not resurrect it either.
- **Our own cancellation is not evidence about the peer.** A run-signal abort (`stop()`) or a tick-budget expiry (`STABILIZE_TICK_BUDGET_MS`, whose signal is a child of the run signal) records no contact failure, no backoff, and no ping-failure diagnostic; only the RPC's own timeout does. The caller's signal is the discriminator because the sender builds its deadline as a *child* of the caller's signal, so the child fires in both cases while the caller's own signal fires only on a cancellation — which is also why no new error type was needed: the caller already holds the discriminating fact. Every maintenance task and routing loop that catches an RPC failure re-checks the signal it was handed before scoring anything (in the pooled tick each task is handed the *tick* signal explicitly, never defaulted from the run signal, so no task can escape the budget). Tasks the pool had not yet started when the signal fired are `skipped` — a distinct pool status, not a rejection, so nothing is scored for a peer never contacted. The fetched-snapshot diagnostic used to overcount here: `fetchNeighbors` swallowed its own errors into a fabricated empty snapshot, so a fetch cancelled mid-flight — one that never opened a stream — was counted like one that returned empty. `RpcOutcome` ended that by making the two expressible apart: `fetchAndMergeSnapshot` returns early on `cancelled` and on `skipped`, and increments `snapshotsFetched` only for `ok`. Pinned by `test/dead-state.spec.ts`.
- Symmetry: maintain |S(p)| = |P(p)| = m by filling gaps from Digitree candidates

## Leave
- Graceful departure protocol:
  1. Send leave notification to all S(p) ∪ P(p) with suggested replacements from Digitree. **All of them, and both sides** — the target list is one `ringNeighborsBothSides` walk at `m` per side (2m = 16 ids at the shipped k of 15), with no target cap. There used to be a `.slice(0, 8)` over the concatenation of a side-major walk, which at m = 8 left the list successors-only: the predecessor side received no notice at all. The fan-out is bounded by the clock instead — `SHUTDOWN_BUDGET_MS` (3 s) over the whole fan-out and `LEAVE_NOTICE_TIMEOUT_MS` (1.5 s) per notice — which is what the cap was standing in for and never actually did. The replacement list is **live-member-scoped** — the same transitive-propagation guard the outgoing snapshot's neighbor lists and sample carry (see *Network-scoped admission*). The recipient records these ids and its own classification pass probes them, so advertising a peer we already marked `foreign` or `dead` spends someone else's probe budget on peers we gave up on and re-seeds a foreign peer into a same-network view. The *targets* of the notice stay unfiltered by contrast: that walk defines the S(p) ∪ P(p) set the replacement list excludes, and it is not a list we advertise. **That set is one array with three readers** — who we notify, what `computeReplacements` excludes as "inside our own window", and what the beyond-S/P fan-out in step 3 filters out — because deriving one from a truncated copy of the other is exactly how they diverged: with the old cap, six genuine predecessors read as *outside* our window and were advertised to our own neighbors as replacements for us. Widening the set correctly **shrinks** the step-3 fan-out, since those peers now receive a notice as S/P members instead. The replacement walk passes that set as the ring helper's `exclude` rather than filtering the walk's result, so its `+ |exclude|` over-fetch keeps the blanketed side from starving.
  2. Transfer hot transactions and pending state to successors
  3. Notify any connected peers outside S/P before disconnecting
- **Recipients remove the departing peer and treat its suggested replacements as untrusted hints, not as commands.** Each sanitized replacement id (≤ 12, capped in `src/rpc/leave.ts`) is deduped, dropped unless dialable, skipped if it is self or the departing peer, and otherwise recorded through `noteDiscovered` — landing `membership: 'unknown'` with the one-off hearsay baseline score, or left completely untouched if we already hold it. This is **not a leave-path exception**: it is the same general rule every hearsay path takes (see *Relevance scoring and table management*), and the two snapshot-merge paths now take it too. Deliberately no `applyTouch`: frequency credit for being named would let an attacker-named id be pumped past a genuine peer at eviction time, and a name we were handed is not a peer we contacted. Probing is left to the passes that are already budgeted and backed off — `classifyTargets` selects exactly this set on the next stabilization tick, and a locally `foreign` or `dead` replacement falls to the matching `reprobeOffRingTargets` arm (see *Re-probe passes*).
- **A rate-limited leave is indistinguishable from an accepted one on the wire.** The inbound leave bucket is taken inside `handleLeave`, which returns `void` either way, while the handler around it (`registerLeave`) has already committed to replying `{ok: true}`. So a notice dropped by the rate limit is answered exactly like one that was acted on: the departing peer will not retry, and the recipient keeps a routing-table entry for a peer that has gone — until the ordinary contact-failure escalation marks it `dead`. The only local signal is `diag.rejected.rateLimited`. Recorded as today's contract, not endorsed. `RpcOutcome` now makes busy *expressible* (a `busy` variant carrying the peer's `retry_after_ms`), but expressing it is not the hard part: reporting busy means `sendLeave` actually *reading* a reply, which adds a round trip inside the 3 s `SHUTDOWN_BUDGET_MS` the whole leave fan-out shares, and it needs a wire-behavior change on the receive side too — `registerLeave` commits to `{ok: true}` before `handleLeave` takes the bucket, so today there is no busy answer to read. Both halves are departure-protocol changes rather than sender plumbing, so this is parked with the leave authentication / dedup work, not with the sender migration. Pinned by `test/rpc.codec-properties.spec.ts`.
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
- **A structural validator runs immediately after the bucket and before every other guard** (`parseRouteAndMaybeAct`, `src/rpc/validate.ts`): field types, finite numbers, a base64url-decodable `key` (decoded once in the handler and handed down to `routeAct`/`nearAnchorOnly`, so neither can throw on the field again), and caps on `key` / `correlation_id` / `breadcrumbs` sizes. All O(message size) — no hashing, no ring walks. A failure returns the same static reject as the other guards and increments `diag.rejected.malformed`. The position is load-bearing both ways: after the bucket so a malformed flood is metered like any other, before the remaining guards so none of them can throw on a field of the wrong type (a thrown guard used to leak the inbound stream). It is one of the parsers in `src/rpc/validate.ts`, which gathers the wire-shape rule for **every** inbound message and reply in one module — see *Wire-shape parsers* below. maybeAct is still the only handler that parses inside its own handler body — its rate-limit bucket must be taken before any per-message work, which the shared seam below cannot do. The other four handlers sit on the shared `registerJsonHandler` seam (see *Stream management* below): the reply-only overload (no request body, so no parser at all) serves ping and the neighbors *request* handler; the request overload (decode → parser → serve) serves the neighbors *announce* handler (`makeSnapshotParser(caps)`) and leave (`parseLeaveNotice`).
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
- **The gap population is the S/P window, not the whole store.** The same options bag carries `self` — the local node's ring coordinate **and** its peer id as one field — and supplying it is what selects the intended arc-length method: gaps are taken between adjacent members of the successor/predecessor window around self (self plus the shared `ringNeighborsBothSides` walk under the same filter, de-duplicated in a `Set`). The helper's `count` already means *peers besides self*, so asking it for `m` returns m successors and m predecessors with the anchor entry dropped, and the estimator seeds self as offset 0 itself — making the window the full self + m successors + m predecessors, i.e. G = 2m = 16 gaps at the default m = 8. The local `m + 1` this used to hand-roll went with the migration; `test/size-estimator.spec.ts` pins G = 2m through the closed form the confidence formula takes on an evenly spaced ring. Coordinates are re-centred on self as *signed* offsets so a window straddling coordinate 0 stays one contiguous run rather than splitting into two and manufacturing an interior gap the size of the ring. The coordinate and the id travel as **one** field rather than two optionals because the walk drops the anchor entry by *id* while self is seeded as offset 0 explicitly: a coordinate supplied without its id costs the window one gap per side, silently, so pairing them makes that half-specified anchor unrepresentable instead of defaulted away.
  - **Omitting `self` is a documented degradation, not an equivalent path.** It falls back to consecutive gaps over every known coordinate and takes their median. A node's knowledge is deliberately non-uniform — it knows *every* peer adjacent to itself but only a sparsity-weighted scattering of far ones (see `selectDiverseSample`) — so whole-store gaps mix ~2m near-true spacings with a long tail of huge far-peer gaps. Once far peers outnumber near ones, which is the normal steady state, even the median lands in that tail and `n_est` collapses by one to two orders of magnitude, inflating cluster span by the same factor until every node believes it is near-cluster. Measured on a uniform-random ring with a node knowing self + 8 successors + 8 predecessors + 32 far peers: whole-store median returned 97 for a 2000-peer ring (−95%) where the S/P window returned 2462 (+23%). The four in-service call sites all pass `self`; `getNetworkSizeEstimate` is public and synchronous, so it passes the cached coordinate paired with the local id and falls through to the whole-store path when called before `start()` has hashed that coordinate.
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
- **The observation array and the blend/decay maths live in `SizeObserver`** (`src/service/size-observer.ts`), not in `FretService` — it reads nothing but its own observations and an injectable clock, so the local FRET estimate is passed **in** per call rather than reached out for, and the four public service methods (`reportNetworkSize`, `getNetworkSizeEstimate`, `getNetworkChurn`, `detectPartition`) are one-line delegations. `report` refuses a non-finite estimate or confidence outright, and a `confidence` outside `[0, 1]` with it: the class is the boundary now, and a single `NaN` in the array makes every subsequent blend `NaN` while slipping past the `totalWeight === 0` guard. The range refusal is there for a second reason — `confidence` is a *weight* in the blend, not merely a reported number, so an out-of-range value re-scales every **other** observation's contribution: a confidence of 5 lets one report outvote five honest ones, and a negative one subtracts from `totalWeight`, which can cancel it to zero (returning the degenerate answer) or drive it negative (inverting the blend). The two wire paths are range-checked in their parsers; refusing here closes the same class for `reportNetworkSize`, which is public API and passes straight through. A negative `estimate` is deliberately still accepted — the `> 0` gate for that lives at the caller (`calibrateSizeFromSnapshot`), and a second, differently-placed gate is how the two drift apart. Observation state is **cleared by `stop()`**, alongside the backoff and departure-debounce maps and for the same reason: a start→stop→start cycle is a fresh run, and peer-reported sizes are a run's view of the ring.
- **Blending FRET's estimate with peer reports** (`getNetworkSizeEstimate`) uses two *different* weightings, and the distinction is load-bearing. The size is weighted by recency × confidence, so a recent, confident observation dominates. The reported confidence is weighted by recency **only** — dividing a recency-weighted numerator by an unweighted observation count instead makes every observation older than "now" drag the average toward zero even when all observations agree perfectly (four agreeing observations at 0.5, spread over the 5-minute window, reported 0.23). The local FRET estimate is always the first observation, so the observation list is never empty; the reachable degenerate case is every observation carrying confidence 0, and both denominators guard it.
- Usage:
  - Operations require min confidence (e.g., 0.3) to proceed
  - Cluster span estimate = k * (2^B / n_est)
  - Near-radius r_near = β * cluster_span where β ∈ [1.5, 3]

### libp2p integration
- **`Libp2pFretService` is a thin facade over the core service, and it takes its node from either of two places**: the explicit `setLibp2p(node)` injection (which wins, because it is always available) or the `libp2p` component the host passes to the constructor. Only the injection used to be read, so a service registered the ordinary libp2p way — `libp2p({ services: { fret: fretService() } })` — threw "node not injected" on `start()` despite having been handed a node. Neither source present is still a loud throw, from `ensure()` alone rather than restated at `start()`.
  - The facade re-exposes the **whole** public `FretService` surface as hand-written pass-throughs, and is tied to it structurally (`implements Startable, FretService`) rather than by convention. The tie has to cover two independent drift directions. A named key list (`Pick<FretService, …>`) covers only one: it flags a *signature* that no longer matches — which is how the facade was caught handing callers `Record<string, any>` metadata after the interface had been tightened to `unknown` — but it keeps compiling when the *interface grows*, since `Pick` over an explicit list never asks whether the list is complete. That blind spot is what let six members (network-size reporting, churn, partition detection, activity handler, iterative lookup) sit unreachable through the wrapper until someone read the two surfaces side by side. Implementing the interface outright makes a forgotten member a compile error at the class, so widening `FretService` forces the pass-through to be written rather than merely inviting it. One facade method sits outside the `Pick` by necessity: `getDiagnostics` is not on the public `FretService` interface at all, so it is tied to the core the other available way — `ensure()` is typed as the concrete `FretService` class, and the facade declares its return as `ReturnType<CoreFretService['getDiagnostics']>`. Casting the receiver to `any` and calling it optionally is the same untied-drift bug in a second dress: it compiles whether or not the core still has the method, and it hands callers an untyped result.
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
  - Stream read deadline: one overall budget per **whole outbound RPC** — dial + stream open + write + read, not the read alone (`RPC_TIMEOUT_MS`, 5s default, exported from `src/rpc/protocols.ts` so the four outbound RPC families cannot drift apart). Per-call-site overrides: `MAINTENANCE_RPC_TIMEOUT_MS` (2000ms, `fret-service.ts`) on maintenance pings and announces; `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` (1000ms, `fret-service.ts`) on the neighbor-snapshot fetch in `fetchAndMergeSnapshot`, which is **not** left at the route-sized default even though a snapshot is a real payload rather than a ~50-byte ping — `fetchNeighbors` is `dial: 'never'`, so no dial cost sits inside that budget: it is a stream open on an already-multiplexed connection, one write, and a read the wire cap bounds at `MAX_NEIGHBORS_BYTES` (16 KiB), and 1s is orders of magnitude above what that costs on any link that is not already broken, so exceeding it is a stall verdict. It must also fit inside a tick's phase-1 sub-budget (see *Stabilization and churn handling*); at the route-sized 5s one stalled peer consumed the whole phase. `sendMaybeAct` is the one sender deliberately left at the 5s default because it is a *route* budget rather than a link one — the call returns only once the entire remaining route has completed downstream, so tightening it truncates healthy long routes (`src/rpc/maybe-act.ts`); `SHUTDOWN_BUDGET_MS` (3000ms, `fret-service.ts`) bounds the whole leave fan-out, with `LEAVE_NOTICE_TIMEOUT_MS` (1500ms) per notice so one stalled peer cannot eat it whole — that fan-out cannot reuse the run signal, since it runs *after* that aborts, by design. There is deliberately **no** per-chunk idle timer — a gap between chunks is a slow link, not end-of-stream, and an idle timer truncated healthy transfers into malformed JSON and failure-scored the (healthy) sender. End-of-message travels in the length prefix (`sendFramed`/`readFramed`), so the reader is authoritative about when a message is complete and never waits on EOF to delimit one; the overall deadline is what bounds a peer that stalls mid-payload. Recognising end-of-*stream* is a separate job from delimiting a message. `readFramed` now has two implementations behind one signature, dispatched by `isMessageStream` (`src/rpc/protocols.ts`): a real libp2p stream is read through `@libp2p/utils`'s `byteStream` (`readFramedFromStream`), whose read rejects with `UnexpectedEOFError` the instant the stream ends without the bytes it was promised — the frame is read at the same layer as the stream's own EOF state, no timer, no poll. A plain async iterable (test stubs, non-libp2p sources) ends on iterator EOF alone (`readFramedFromIterable`), raising `FrameTruncationError`. Both names are matched by `isFrameTruncationError`, so either surfaces as `decode-error`, and a stream that genuinely ends mid-frame fails at once instead of sitting out the read deadline. **Invariant: a frame the remote actually wrote is never reported as truncated** — the 20 ms `EOF_POLL_MS` poll that used to stand in for stream-layer EOF detection is deleted; there is no poll interval anywhere in `readFramed` now. A merely-slow stream ends nothing, so nothing here truncates a healthy transfer; it is not the per-chunk idle timer above by another name. Both directions are pinned: `test/rpc.stream-errors.spec.ts` bounds an ended-stream read at an order of magnitude inside the RPC budget, and `test/rpc.two-node-framed.spec.ts` drives real framed replies between two nodes across a spread of reply timings (immediate, several microtask depths, and one deferred past a macrotask) and requires that a reply really written is never reported cut off. Exceeding it throws a read-timeout error rather than returning the partial frame, so a timeout is never mistaken for a short-but-valid message. Over-cap is raised as a `PayloadTooLargeError` with a stable `name` (matched by `isPayloadTooLargeError`, beside `isFrameTruncationError`) rather than a bare `Error`, so a classifier recognises the condition by identity instead of by message prefix — the message text is unchanged and is still what the assertions pin. `readFramed` also accepts `timeoutMs = Infinity`, meaning "no independent clock — bounded by `opts.signal` alone"; a signal is then mandatory and its absence throws at entry rather than hanging. That mode exists because a caller that arms a whole-RPC `deadline()` and *also* hands `readFramed` the same `timeoutMs` has two timers expiring a tick apart, making which error surfaces — and which release arm runs — a race. Every sender now reads in that mode through `rpcRequest` (next bullet), so the RPC deadline is the only clock: a stall is a deterministic `timeout`, and because the deadline signal has fired before the `finally` releases the stream, the release arm is deterministically `abort()`.
  - **A reply that fails partway through is never an answer, and its stream is always released.** Three failure shapes reach a sender — the reply resets mid-stream, the peer closes tidily mid-JSON, or bytes arrive and then stop — and none of them may surface a partially-parsed message or leak the outbound stream. `test/rpc.stream-errors.spec.ts` drives all three against every sender that can meet them, and pins release-exactly-once: `abort()` once a signal has fired (a stalled remote must not be cleaned up with the unbounded `close()`), `close()` otherwise. **The arm is deterministic on every path** now that the RPC deadline is the sole clock: a read that ends on the budget has, by construction, a fired deadline signal when `releaseRpcStream` runs, so timeout and cancellation both release by `abort()`, and only a completed or cleanly-failed read releases by the bounded `close()` — the spec pins the arm as well as the count.
    The senders all agree about *what* such a reply means, because none of them owns the sequence any more: every sender — `sendPing`, `fetchNeighbors`, `sendMaybeAct`, and the write-only `announceNeighbors` / `sendLeave` — is a thin wrapper over `rpcRequest` (`src/rpc/request.ts`), the one owner of open/write/read/close, and each returns `RpcOutcome<T>` (`src/rpc/outcome.ts`) rather than throwing, fabricating an empty reply, or coercing to `ok: false`. The variants give every failure mode its own name — `ok {value, rttMs}`, `skipped`, `cancelled`, `timeout`, `unreachable`, `foreign-protocol`, `decode-error`, `busy {retryAfterMs?}` — each documented by what it proves about the peer, so a caller decides on evidence rather than on error identity, and identical evidence is scored identically at the service (`noteRpcFailure`: `decode-error` → relevance decay only, no contact strike; `unreachable` / `timeout` → contact strike). `rpcRequest` never throws for a network outcome — only a caller bug throws (malformed peer id; `if-addressed` mode without dialability), before any timer is armed. It checks the caller's signal before dialing (`cancelled`, no dial), returns `skipped` when the dial mode yields no stream, reads on the single clock (`readFramed` in `Infinity` mode, bounded by the RPC deadline alone), and releases the stream through `releaseRpcStream` before cancelling that deadline so the bounded `close()` is still bounded. Its `decode` validator selects the reply type *and* the overload: with no `decode` the helper is write-only and `T` is pinned to `undefined`, so an explicit type argument cannot reach that signature and a forgotten validator is a compile error rather than an `ok` carrying `undefined` dressed as the reply. A write-only request consequently can never observe `foreign-protocol` — `openRpcStream` pins `negotiateFully: false`, deferring an unsupported-protocol failure to the first read, and this path returns `ok` right after the write without ever reading — so `sendLeave`'s and `announceNeighbors`'s `ok` means "written", not "received": a stated gap at the seam, parked with the leave-authentication work. `sendMaybeAct` half-closes its write end before reading (`halfCloseBeforeRead`), so its non-abort read paths see a flush close before the release's close — harmless, and pinned. Pinned by `test/rpc.request.spec.ts`, which drives every failure shape, both cancellation-vs-timeout arms, the dial modes, and the backpressure drain wait against stub streams, asserting the release *arm* (not merely the count) on each — deterministic precisely because the single clock removes the two-timer race — and by `test/rpc.stream-errors.spec.ts`, which drives the same failure shapes through the real senders and pins that one undecodable reply reads the same way across all of them.
  - **Inbound handlers release their stream on every path** — the receive-side mirror of the sender rule above. All five handlers register through one seam (`registerRpcHandler`, `src/rpc/protocols.ts`) that wraps the handler body: on success it closes the stream under its own `RPC_TIMEOUT_MS` deadline, and on error it logs and `abort()`s — synchronous, so a stalled remote cannot hold the cleanup, the same reasoning as the sender-side `releaseRpcStream`. The error arm is skipped for a stream that already left `open` (reset by the remote — usually how the error arrived) and for one whose write end the handler already closed, since that reply is committed and a reset would destroy it. **`status` alone cannot answer "did the handler already release this?"**: libp2p streams are half-closable, so a stream stays `open` until the *remote* also closes its write end, which for every FRET sender happens only after it has read the reply — the write-end status is the load-bearing one. Before the seam a handler that threw mid-message logged and returned, leaving the inbound stream open forever; since streams are counted per protocol per connection (32, see the cap note above), ~32 unparseable messages permanently poisoned that protocol on that connection — version skew or an encoder bug on an honest peer silently broke its own link. The identity-mismatch drops on leave/announce close (a normal outcome), never abort. **The success-path close is budgeted, not bare**: `close()` resolves only once the reply reached the transport, so a remote that accepts the stream and then stops reading would hold the handler and its stream slot open forever. The seam gives that close its own deadline; when it expires the close rejects into the error arm with the write end at `closing` rather than `closed`, so the abort runs and the slot is reclaimed. Reclaiming destroys the undelivered reply, which is correct — the close never completed, so nothing was committed, and the remote was not reading. **The budget only binds because no handler body closes for itself.** All five FRET handlers reply and return; the seam owns the close on every path, and the identity-mismatch drops on leave/announce simply return without replying (the seam's close is what makes the drop a close rather than an abort). A bare `close()` in a body would run *before* the seam's budgeted one and block on exactly the stalled remote the budget exists for, pre-empting it — so `close()`'s early-return on an already-closing write end is now the *external*-consumer case: `registerRpcHandler` is exported from the package root — with `registerJsonHandler` and both option interfaces beside it, the receive-side mirror of the outbound seam below — and a consumer wrapping its own protocol may still close in its body without being released twice. A close that exhausts its budget and a handler body that threw both land in the same catch arm but log distinctly — "the remote stopped reading" is a remote-behavior signal, "the handler threw" is ours — discriminated on the budget's own signal rather than the error's identity, since libp2p's `close()` rejects with whatever its internal `pEvent` turns the abort into. `registerRpcHandler` takes an internal `closeBudgetMs` override so a test need not spend the full 5s per case; no production caller sets it. Pinned by `test/rpc.handler-fuzz.spec.ts` (release accounting on stub streams, plus `handleMaybeAct`'s structural validator) and `test/rpc.handler-fuzz.wire.spec.ts` (the same rules driven over a real transport: the malformed matrix over memory, and batch-then-recover over TCP + noise + yamux).
  - **The per-message byte cap refuses an over-sized message at the length prefix, before any body byte.** Both of `readFramed`'s implementations enforce the cap the moment the unsigned-varint prefix has been decoded and declares the frame's size, so an over-cap message costs the receiver only the prefix — the body is never pulled. The iterable path enforces it in the decoder's `onLength` hook; the stream path reads the prefix one byte at a time and checks the decoded length itself (nine prefix bytes without a decodable varint already declare ≥ 2^56, over every FRET cap, so it fails there rather than reading on). That is the difference between a cap that costs an attacker one over-sized send and one that lets them push a whole payload through the receiver's memory before being refused, and it is *measured* (by counting pulls on a source that reports them) rather than inferred from the absence of a crash — see `test/rpc.codec-properties.spec.ts`. The wire caps are now each derived from the largest legal message of that protocol rather than picked. maybeAct's cap is `MAX_ACTIVITY_BYTES` (128 KiB) + `MAYBE_ACT_OVERHEAD_BYTES` (16 KiB) = 144 KiB, one number for both profiles, so `handleMaybeAct`'s own activity-size refusal and the wire cap are the same arithmetic and cannot disagree. Neighbors is `MAX_NEIGHBORS_BYTES` (16 KiB), **one number for both profiles**: an inbound cap bounds the largest message a *peer* may legitimately send, and Edge and Core nodes talk to each other, so it is derived from the largest snapshot **any** profile can emit (Core worst legal case 11,575 bytes at the merge caps — 16/16/8 ids, an 8 KiB metadata allowance and 256 bytes reserved for the unimplemented `sig`), not from the local profile's own output. Sizing it per profile was a defect: a Core node with more than ~5.1 KiB of `setMetadata` JSON overflowed the 8 KiB Edge cap and could no longer announce to, or answer a neighbors request from, any Edge peer — silently, and one-directionally. The **emission** budgets stay profile-split (snapshot id caps 12/12/8 Core, 6/6/6 Edge; metadata allowance 8 KiB Core / 4 KiB Edge); the invariant they must keep is `largest emission of any profile <= MAX_NEIGHBORS_BYTES`, pinned by `test/rpc.codec-properties.spec.ts`. Leave stays a fixed 4096.
  - **`registerJsonHandler`, stacked on top of `registerRpcHandler`, splits inbound failure into two tiers by where it happens, not by what it is.** A *frame-level* failure — truncation, over-cap, a reset — means the stream is already broken or the remote is misbehaving at the framing layer; it propagates into `registerRpcHandler`'s error arm, which `abort()`s and tears the connection down. A *body-level* failure — undecodable JSON, a non-object top level, a parser rejection, an identity mismatch (`serve` returning `undefined`) — means the peer framed correctly and is alive but sent something worthless; the handler returns normally without replying, so the seam's ordinary budgeted `close()` runs instead — a polite drop, not a teardown. `onMalformed` (`'decode'` or `'parse'`) counts the drop before the handler returns. Four of the five FRET handlers sit on this seam — see the *Cheap-guard rejections* paragraph above for which.
  - Multiplexing: reuse streams for multiple requests where possible
  - Snapshot *emission* caps: the successors/predecessors/sample lists this node puts into a snapshot it sends are profile-bounded (Edge ≤ 6/6/6, Core ≤ 12/12/8). Distinct from both the acceptance counts a receiver truncates an inbound snapshot to (Core 16/16/8, Edge 8/8/6, see *Security and abuse considerations*) and the single `MAX_NEIGHBORS_BYTES` byte cap above, which is not profile-split.

### Dialability (can we reach this peer at all?)

Every FRET outbound RPC funnels through one seam, `openRpcStream`: reuse an open connection if there is one, otherwise `dialProtocol` with a **bare peer id**. FRET never learns or stores multiaddrs — its wire messages carry peer-id strings only — so a bare-id dial succeeds only when libp2p's own peerStore already holds an address for that peer, learned by libp2p (identify over a direct connection, a bootstrap entry, a transport's discovery) and never by FRET. For a peer known only through FRET gossip it does not, and the dial fails with `NoValidAddressesError`.

**The seam is part of the public surface**, not FRET-internal: `openRpcStream` and its mandatory partner `releaseRpcStream` are re-exported from the package root (`src/index.ts`) alongside `sendFramed`/`readFramed` and the `Stream` type, because a consumer opening its own protocol streams over the same libp2p node otherwise hand-copies the connection selection — and the copies drift (the known instance: three copies downstream, one omitting `runOnLimitedConnection`, so a relay-only peer silently never answered). The two are exported together deliberately: a lone opener invites a hand-rolled releaser, and the release rule is the half that gets it wrong: abort once the caller's signal has fired, otherwise `close({ signal })` — bounded by that same signal, since a bare `close()` against a stalled remote is unbounded — and abort again if that bounded close rejects, because a close that never completed has not released the stream. Passing the signal is only meaningful because every sender releases from a `finally` *before* `d.cancel()`, so the deadline is still live at that point; cancel first and the bound is silently gone. One consumer-visible caveat: `openRpcStream` fixes `negotiateFully: false`, which defers an unsupported-protocol failure to the first read — every FRET sender reads a reply, so a caller that does *not* read must treat "opened" as "not yet negotiated". Reachability is pinned by `test/package-exports.spec.ts`, which asserts the `exports` map, the build's `src/index.ts` → `dist/src/index.js` mapping, and the exported surface — the outbound seam and `rpcRequest`, the wire-shape parsers, and the inbound `registerRpcHandler` / `registerJsonHandler` pair — deliberately without importing through `dist/`, since `yarn check` type-checks before it builds.

So "**has addresses**" throughout this document means precisely: *the libp2p peerStore holds at least one multiaddr for this peer*. A peer is **dialable** when it is either currently connected or has addresses. Fixing dialability makes the *skip decision* correct; it does not by itself make more peers reachable (that is address-hint propagation, which FRET does not do today).

- The service answers `hasAddresses` from a local id set rather than reading `peerStore.get` per call, because every caller is a synchronous filter predicate while the peerStore API is async. The set is rebuilt wholesale from the `peerStore.all()` walk the stabilization tick already performs (so it is bounded by peerStore size and prunes itself), and refreshed per-peer on `peer:identify` / `peer:update` so a freshly-learned address is usable before the next tick.
- **Maintenance paths skip an undialable peer** — leave notices, replacement warm-up, announces, probe passes. Attempting the dial can only end in `NoValidAddressesError`, and on the `stop()` path a stack of them also delays shutdown.
- **Routing paths filter into the walk, never out of the result.** `routeAct` and `iterativeLookup` build their candidate list with dialability composed into the ring walk's own predicate alongside the member gate (`e => isMember(e) && isDialable(e.id)`), so the selector picks the best *reachable* hop instead of dead-ending a route that still had usable hops behind it — the same rule as the breadcrumb/cohort exclusions. Post-filtering the assembled cohort instead would shrink it below the requested count, and to empty when the peers nearest the key happen to be unreachable. (Anchor ids returned in a `NearAnchor` reply are a plain list rather than a sized walk, so those *are* filtered directly; an emptied anchor list falls back to the local cohort.) Only a genuinely empty candidate set falls through to the existing `NearAnchor` / `exhausted` outcomes. A hop skipped for unreachability is **not** a negotiate-failure strike: an unreachable peer is not evidence of a foreign one.
- **The announce target list is a two-sided window, sliced.** `announceTargetsAround` walks `ringNeighborsBothSides` at `m` per side around the announce coordinate (self, or a departed peer's coordinate), sorts non-connected-but-addressable peers ahead of connected ones, and then slices to `announceFanout` (Core 8 / Edge 4). The slice runs over the helper's **interleaved** union, so it bounds *who we contact* without collapsing the window to one side: over a side-major concatenation a Core fanout of 8 against m = 8 was successors-only and the predecessor side received no announce at all. The excluded ids (self, plus the departed peer on the departure path) are passed into the helper rather than filtered off its result, so the over-fetch pays for them instead of the walk coming up short.
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
  - **"Completed" is about the round trip, not the reply body.** A reply saying `ok: false`, a `busy` refusal, and a framed reply whose bytes will not decode are all answers that arrived over `/optimystic/${networkName}/fret/...` — a protocol only this network's peers serve — so each is the same strong membership evidence, and each proves the peer reachable (clearing any contact-failure run). Reply *contents* are evidence about the peer's load or its encoder, never about which network it belongs to; treating an unusable reply as no evidence left a mislabeled-`foreign` peer that answers `busy`, or a version-skewed peer whose replies never decode, stuck outside the ring with the re-probe arm unable to recover it. The probe passes therefore raise the membership signal from those arms too (`noteAnsweredOnProtocol`) while withholding the relevance credit and latency sample an unusable answer has not earned — `applySuccess` remains the good-reply path.
  - The table says a completed RPC *may* set `member`, not that every site must. Two passes deliberately score nothing at all against a peer and are unchanged: the pooled warm-up fan-out (see *Active vs passive state*) and `fetchAndMergeSnapshot`'s answered-badly arm, which preserves the old fabricated-empty-snapshot path's silence.
- **Inbound namespaced RPC → `member`.** All four inbound handlers (ping, neighbors request, maybeAct, announce) receive the transport-authenticated `connection.remotePeer` and promote the sender. Reaching one of them at all means the remote dialed a protocol only this network's peers speak. This re-admits a peer we struggle to dial but that reaches us (e.g. behind NAT) immediately and with no extra probe traffic.
- **Unsupported-protocol error → evidence, not a verdict.** libp2p throws `UnsupportedProtocolError` when the remote doesn't support the dialed protocol — but a same-network peer that has not yet run `registerRpcHandlers()`, or that is restarting (`stop()` unhandles all five protocols), produces exactly the same error as a genuinely foreign peer. Each such failure increments a per-peer consecutive-failure counter (`PeerEntry.negotiateFailures`); only at a threshold of **3** does the peer demote to `foreign`. Any positive proof — a successful RPC in either direction, or an identify list containing one of ours — resets the counter to 0. A timeout / transient failure is not even counted; it leaves the label untouched for a later retry. Two of the three call sites (the neighbor-latency probe and the maybeAct forward path) draw their targets from member-gated views, so *every* demotion there would otherwise be a confirmed member being demoted on one blip. Delaying the `unknown → foreign` demotion costs nothing in correctness — `unknown` is already excluded from every ring view — so the whole price is ~2 extra pings per genuinely-foreign peer, once, spread across the existing backoff schedule (1 s + 2 s + 4 s ≈ 7 s to a settled label).
- **peerStore protocols (when `identify` has run).** On `peer:identify` / `peer:update`, the peer's negotiated-protocol list is checked: contains one of ours → `member`; non-empty but contains none → `foreign` **but only from `unknown`**; empty → left `unknown`. The negative arm is deliberately weak because the list may have been captured before this service registered its handlers — a stale `peer:update` must not overturn a peer confirmed by RPC. The same check also runs over the start-time / per-tick seed poll: `seedFromPeerStore` enumerates `peerStore.all()` and classifies each entry off its protocol list, so a peer whose `identify` completed before this service started is labelled at `start()` without waiting for an event or an outbound probe. (This poll used to carry its own `unknown`-only guard; that rule is now general and lives in the guard.) This also delivers re-admission — a peer that later starts serving this network re-identifies and is re-evaluated `foreign → member`.

- **Classification probe pass.** `unknown` entries arrive from every network-agnostic seed (peerStore, `peer:connect`, bootstraps), from inbound snapshot merges, and from the replacement lists on leave notices (see *Leave*) — which is why this pass, not the leave handler, is what vets them. Every one of those hearsay sources creates its entry through the single `noteDiscovered` seam, so none of them accrues frequency credit for the peer it names; only the probe that follows, or a later real RPC, does. Because the member-only ring views (below) exclude `unknown` peers, a bounded pass on each stabilization tick pings up to N `unknown` peers directly from the store (preferring connected / has-addresses ones — see *Dialability* below) so an unclassified same-network peer is resolved within ~1 tick rather than starved. It reads the store directly, *not* the gated ring views, which is how it still sees unknowns. The pass runs only while unknowns exist; in single-network steady state every peer becomes `member` and it is a no-op.
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

`unknown` peers are excluded from the ring because they are not yet confirmed same-network. They are not starved: the classification probe pass (above) reads the store **directly** — not the gated ring views — so it still resolves them, typically promoting a same-network peer to `member` within ~1 tick, after which it appears in the ring. The outgoing snapshot's neighbor lists and sparsity sample are also member-scoped, so neighbor-exchange never re-introduces a foreign peer to same-network peers (the transitive-propagation guard); inbound merges still record received ids as `unknown` (through `noteDiscovered`, so a repeated mention buys the named peer nothing) and let classification vet them before any ring use. Capacity eviction protects only member neighbors around self, so a foreign peer (relevance ~0) becomes a preferred eviction victim rather than squatting in a protected slot.

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
  - Higher inbound concurrency; an over-cap message is refused outright with `busy` — buffered
    backpressure with bounded queues was stated intent here and is not implemented (there is no
    queue anywhere in the service), so the concurrency cap below is the whole mechanism
- **The inbound `maybeAct` concurrency cap is a stated number: Core 16 / Edge 4.** `handleMaybeAct`
  counts the messages it is working on at once and answers `{busy: true, retry_after_ms: 500}` —
  the fixed inflight sentinel, distinct from the token bucket's own computed `retry_after_ms` —
  once the count reaches the cap; a refused message returns *before* the increment, so a busy
  reply never occupies a slot. The counter is decremented in a `finally`, so it returns to zero on
  the error path too: an activity handler that throws propagates out of `routeAct`, is caught, and
  is answered with a `NearAnchor` from `nearAnchorOnly` — the slot is released either way, which is
  what stops the counter drifting upward until the service answers busy forever. Note the cap sits
  *behind* the per-protocol token bucket (Core 32 / Edge 8), so a bucket rejection and an inflight
  rejection both increment `diag.rejected.rateLimited` and differ only in `retry_after_ms`. Pinned
  by `test/inflight-concurrency.spec.ts`, which drives real calls into a gated activity handler and
  asserts the high-water mark *equals* the cap rather than writing the counter.
- **The pre-dial concurrency above (Core 6 / Edge 2) is one number, and it governs every pooled outbound maintenance RPC, not only warm-up dialing**: the stabilization tick's two phases, the start-up warm-up pass, and the active-mode warm-up tick all draw from the same cap (`maintenanceConcurrency`). It was reused rather than re-invented because these are the same resource — a burst of outbound streams from one node — and a second knob would only drift from this one. Edge's 2 is deliberately conservative: an Edge tick truncates on its budget more often, which is this profile's stated "fewer probes per window" posture rather than an oversight. The per-pass *budgets* stay separate and profile-tuned (how many peers a pass may target); the cap is only how many of them may be in flight at once.

### Security and abuse considerations

See [threat-analysis.md](threat-analysis.md) for comprehensive threat modeling and [threat-rir-mitigated.md](threat-rir-mitigated.md) for residual posture with Right-is-Right.

#### Current state
- Timestamp bounds (±30s) for message freshness, deliberately equal to the dedup TTL below. Any slack between the two is a replay window — a captured message whose dedup entry has expired but whose timestamp still passes is accepted and re-performed — so the two constants move together (`DEDUP_TTL_MS`). A deployment with poor clock sync can pass a wider window per call, at the cost of re-opening that gap.
- Correlation ID + phase dedup cache (30s TTL; capacity 2048 Core / 512 Edge) for maybeAct — the key is the correlation ID paired with whether the message carries an activity, so a digest probe and the activity resend sharing that ID get separate cache slots, and only a terminal answer is stored (see the routing rule above). Capacity is profile-derived because an entry evicted before its TTL is a replay hole: Core carries the higher inbound rate and so is given 4× the slots, while Edge's tighter inbound maybeAct rate limit already caps how fast its cache can be churned. Eviction at capacity drops the oldest-inserted entry, which under the single constant TTL is also the entry nearest to expiry — so a live entry is only ever the victim once no expired one remains, and no expiry scan is needed to find it. Re-storing an answer under a key already cached is a refresh, not an insert: it never evicts, and it moves that key to the back of the eviction queue.
- Correlation IDs are minted from the WebCrypto RNG (`crypto.randomUUID`, falling back to `crypto.getRandomValues` where `randomUUID` is unavailable — React Native, older browsers). `Math.random` was predictable from observed outputs, which let an attacker pre-fill a peer's dedup cache with answers for requests not yet sent. The self-id and timestamp prefixes are traceability only and need not be secret.
- Rate limiting via global token buckets (per-protocol, profile-tuned Edge/Core), including the inbound announce handler (gated before any merge work; on rejection the message is dropped and `diag.rejected.rateLimited` increments). Each bucket is taken **before** the handler's own validity checks, so invalid messages are metered too — see *Cheap-guard rejections* under the maybeAct routing rule for why that ordering is load-bearing. **One exception, bounded by design: the two handlers on the `registerJsonHandler` seam (leave, neighbors-announce) parse before their bucket**, because the seam parses in the handler body and the bucket is taken inside the service method the seam calls. What runs unmetered there is only the wire-shape parser — O(message size), no hashing, no ring walk, and already bounded by that protocol's byte cap (leave 4096; announce truncates the id lists and sample to the merge caps before vetting them). maybeAct, whose parse is the expensive one, keeps its bucket strictly first.
- Inbound snapshot-merge caps: remote successors/predecessors/sample are bounded to the same per-profile numbers (Core 16/16/8, Edge 8/8/6) on both inbound paths, so one crafted message cannot force thousands of parse+hash+upsert ops regardless of the protocol's 16 KiB byte cap (`MAX_NEIGHBORS_BYTES`). Note these are the *acceptance* counts, and they are still profile-split even though the byte cap is not: the byte cap bounds one message's cost on the wire and so must admit any profile's largest legal emission, while these counts bound how much per-entry work the local node will do and so are the local node's own choice. **The bound is enforced in exactly one place — the snapshot parser** (`makeSnapshotParser`), which `FretService` builds from `mergeSnapshotCaps()` at both call sites: `registerNeighbors`' `snapshotParser` on the announce path and `fetchNeighbors`' `parse` option on the fetch path. Neither merge loop slices; both once did, and two copies of one bound is how the two drift apart. The loops keep a per-entry `try/catch`, which is a different guard (a peer id or coordinate that fails to decode), not a cap. Pinned by `test/rpc.snapshot-merge-cap.spec.ts`, which counts the receiver's `store.upsert` calls on both the announce and fetch paths rather than inferring the bound from an absence of failure.
- The service's two internal bookkeeping maps carry explicit profile-tuned capacities and a periodic sweep, so neither can grow without a stated ceiling: the per-peer probe **backoff map** (capacity: Core the routing-table capacity of 2048, Edge `min(capacity, 512)`) and the **departure-announce debounce map** (Core 512 / Edge 128, lifetime 2 s). The backoff map's retention lifetime is deliberately *not* its backoff window — an entry whose window has passed is kept so the next failure doubles the factor rather than restarting at 1, and it is forgotten only after `BACKOFF_RETAIN_MS` (5 min) without a further failure, which must comfortably exceed the longest backoff window (1 s × 32 = 32 s) or a peer probed at the slowest cadence would silently reset to factor 1. Both are swept at the top of each stabilization tick, alongside the store-membership prune that drops entries for peers no longer in the routing table (orthogonal to expiry — no lifetime can see that a peer left the store). Both are cleared by `stop()`: a start→stop→start cycle is a fresh run, and carrying a peer's escalation across it is the same mistake as carrying `negotiateFailures` across a restart.
- Breadcrumb loop detection and TTL limits on routing
- Capacity-bounded routing table (C=2048) with relevance-based eviction
- Transport identity verification: every RPC handler receives `(stream, connection)`; any message carrying a `from` field (leave notice, announce snapshot) is dropped unless `from` equals the transport-authenticated `connection.remotePeer`, and mismatches are counted (`diag.rejected.identityMismatch`). Handlers without a `from` (neighbors request, maybeAct, ping) still adopt the two-argument signature so the authenticated sender is available (threaded to the maybeAct handler for future per-peer rate limiting).

#### Not yet implemented (planned — see tickets/)
- Message authentication:
  - Sign all messages with sender's private key; verify on receipt
  - (Re-hashing a sample entry's ring coordinate from its id rather than trusting the wire
    field is **done** — both merge loops derive `coord` from `s.id`, so `s.coord` is a wire-shape
    field the parser width-checks and nothing reads. A sample entry whose id will not parse is
    therefore skipped by the merge loop's per-entry `try/catch`, which is that guard's remaining
    arm.)
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
  - **Per-label counts are maintained at that same write seam, not derived by walking.**
    The store keeps an O(1) tally of how many entries carry each `membership` label and each
    `state` (`countByMembership` / `countByState`), bumped only by `put` (outgoing prior entry
    down, incoming entry up — so an insert, a re-key and a replace are all one rule) and by
    `remove`. They ride the seam the tree/id-index invariant already depends on, so anything
    that would desync those two would desync the counts identically, and the same property test
    covers all three. Counting rather than branching keeps the store network-agnostic: it tallies
    fields it already owns and still never asks what a label *means*. A zero count is a sound
    proof that any compound predicate narrowing that label matches nothing, which is what lets a
    caller skip a full-table walk outright — which is what the stabilization tick's
    phase-2 target selection does (see the *Two phases* bullet under *Stabilization and
    churn handling*).
  - **A tree key is built once per entry object, not once per tree probe.** `digitree` derives
    keys from entries on demand rather than storing them, and calls the extractor once per
    binary-search probe inside a leaf — measured 5 calls per `find`, 6 per seek — so every
    `getById` / `remove` / `update` / `put` and the seek that starts every ring walk rebuilt a
    64-character hex string five or six times over. Measured at ~83% of a `find` (20 000 `find`s
    over a 2048-entry store: 39.0 ms rebuilding, 4.4 ms cached). The cache is a module-level
    `WeakMap` keyed on **entry object identity**, populated inside the key builder itself.
    Identity rather than peer id is the whole point: every write path builds its new entry by
    spreading the old one, so a key stored *on* the entry would be carried across a coordinate
    change and be silently stale — the exact re-key case the write seam exists to handle — while
    a re-keyed entry is a different object and simply misses the cache. Staleness is therefore
    unrepresentable rather than merely unlikely, entries leave the cache with the garbage
    collector, and there is no eviction path or ceiling to state. It rests on one invariant that
    is **already load-bearing at HEAD**: an entry's `id` and `coord` are never mutated in place
    while it sits in the tree. Because keys are re-derived on demand, in-place mutation already
    scrambles tree order without the cache, so the cache is exactly as safe as the status quo.
    `test/digitree.invariants.spec.ts` now asserts tree order agrees with the coordinates the
    entries carry, which is the assertion a stale key fails.
  - **A ring walk exits on the first repeated id, because a repeat proves it lapped.**
    `neighborsRight` / `neighborsLeft` collect straight into a `Set` and return the moment they
    see an id already in it. Unfiltered, `maxScan` is `Infinity`, so before this a walk on a ring
    smaller than `count` kept circling and re-collecting the same ids until it had pushed `count`
    of them, with the trailing dedup hiding it — cost O(`count`), not O(ring size). Measured on a
    4-entry ring, 2000 walks: 3.5 ms at `count` 4 rising to 98.9 ms at `count` 2000, all returning
    the same 4 ids; now flat at ~1.6–2.1 ms across that whole range. Production `count` reaches
    ~30 (`assembleCohort` asks for `wants * 2 + excludeSet.size`), so it was a bounded ~7× lap
    factor on a young ring rather than a catastrophe — but bounded only by an accident of today's
    callers. Sets are insertion-ordered, so the returned ordering is byte-for-byte what the old
    trailing `Array.from(new Set(out))` produced: this changes cost, not results. Two conditions
    make it sound, both recorded at the site: **one tree entry per peer id** (above) is what makes
    a repeat mean "lapped", and a supplied `filter` must be **pure**, since the exit fires only on
    a matching entry and relies on the first match re-matching after a lap. The existing
    bounded-scan `maxScan` guard stays and is not redundant — it is the guard for the *filtered
    zero-match* walk, where nothing is ever collected so no repeat is ever seen. Neither subsumes
    the other; deleting either reopens a spin.
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
- **`accessCount` counts proven contact only.** It is incremented by `touch` and by `recordSuccess`, both of which follow a real interaction with that peer; `recordFailure` accrues none, so a peer stuck in the dead re-probe arm does not climb. A peer we were merely told about is scored once at creation by `initialRelevance` — same formula, no counter incremented, and the KDE deliberately not observed, since a name we were handed is not a distance we accessed. See *Relevance scoring and table management* for why that is a one-off baseline rather than nothing.
- **Health is deliberately a pure rate, and frequency is deliberately the volume term.** `healthScore` saturates after the first success (it is a success/failure *ratio* plus a latency penalty); volume lives in `frequencyScore` alone. Putting volume in both would double-count it and force every weight to be re-tuned. Recorded at the site as an accepted tradeoff; revisit only if the frequency term is removed or re-weighted to near zero.
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

All five wire messages — and every reply — travel as one length-prefixed frame per direction per stream: an unsigned-varint byte count (`it-length-prefixed`) followed by that many bytes of UTF-8 JSON. Trailing bytes after the frame are handled differently by `readFramed`'s two implementations (see *Stream management*): on the plain-async-iterable path they are ignored, never pulled past the frame boundary; on the real-libp2p-stream path they **are** pulled, since message events deliver whatever arrives — a real stream is never asked to stop delivering mid-message — but they are not swallowed: `readFramedFromStream` calls `byteStream.unwrap()` in a `finally`, which pushes any unread bytes back onto the stream for the next reader. Every body is a JSON **object**. `decodeJson` (`src/rpc/protocols.ts`) rejects any non-object top-level value (the literal `null`, an array, a number, a string, a boolean) at the decode boundary, so no handler body ever null-checks what it decoded. It also trims NUL/tab/LF/CR/space from both ends before parsing — interop-defensive only: with framing the reader hands over exactly the counted body, so padding can only come from a sender that framed it *inside* the count (e.g. `JSON + "\n"`); a body of nothing but padding is refused rather than parsed. Stripping a **NUL** specifically is reported: the trim counts the NULs it removed and, when the count is non-zero, writes one debug line naming it, since no correct sender emits NUL padding and a non-zero count therefore points at a framing bug rather than at a lenient encoder. Ordinary whitespace padding stays silent. The line is namespace-gated like every other FRET log (`optimystic:fret:rpc:handler:error`), so it writes nothing with `DEBUG` unset — which is what keeps it from being an amplification path, given that `decodeJson` runs ahead of the maybeAct token bucket and a peer can therefore drive one per message it sends.

**The codec is lossless on everything these formats admit, with three stated exceptions.** `encodeJson` → `decodeJson` is the identity on every field below — lone surrogates included, since `JSON.stringify` has been well-formed since ES2019 and escapes an unpaired code unit rather than letting UTF-8 mangle it. What does not survive: `-0` arrives as `0` (no FRET field distinguishes the two — relevance, latency and estimates are all magnitudes); `NaN` and `±Infinity` arrive as `null` (unreachable from routing logic, which rejects a non-finite `ttl` / `want_k` / `min_sigs` / `timestamp` in `parseRouteAndMaybeAct`); and an own property whose value is `undefined` is dropped, so `undefined` can only mean *absent* on the wire and `null` is the value that round-trips. All three are pinned as contract — not endorsed — by `test/rpc.codec-properties.spec.ts`, which also proves the round trip over generated instances of all five wire types plus `SerializedTable`, and proves both halves of the coordinate codecs (`base64urlToCoord` / `hexToCoord` accept exactly a 32-byte coordinate and reject everything else).

#### Wire-shape parsers

Every shape rule these formats imply lives in one module, `src/rpc/validate.ts`, so a reader finds
the rule for any inbound message in one place rather than in whichever handler happens to check it.

**They are parsers, not type guards.** One signature throughout — `Parser<T> = (msg: unknown) => T |
undefined`, where `undefined` means "reject this message" and anything else is the message *as
normalized*. Two of the shapes must normalize while they check (truncate an over-long id list, drop
a malformed sample entry, drop an advisory field of the wrong type), and a `msg is T` guard cannot
express that without mutating its argument — so returning the normalized value makes narrowing and
normalization one step, and no caller can consume an un-normalized message. Mixing the two forms
inside one module is the drift the module exists to end, so `parseRouteAndMaybeAct` keeps the parser
signature even though it normalizes nothing.

All are pure and O(message size) — no hashing, no ring walks, no dialing — and **none throws** on
any input, which is what makes them safe to run before the guards that used to throw on a field of
the wrong type. `v` is deliberately unchecked on every message: nothing negotiates versions today,
and a hard reject on an unexpected `v` would make a future v2 rollout fail closed at exactly the
peers that have not upgraded yet. The snapshot's `sig` is unchecked for a different reason —
message signing is unimplemented, so nothing reads the field — and it is carried through
untouched rather than dropped, so a signing rollout finds it already arriving.

| Parser | Rejects the message when | Normalizes |
|---|---|---|
| `parseRouteAndMaybeAct` | any of the checks under *Cheap-guard rejections*, plus `digest` over 4096 chars | nothing |
| `parseLeaveNotice` | `from` is not a parseable peer id, or `timestamp` is not finite | `replacements` → `sanitizeReplacements` (≤ 12, parse-checked, `undefined` when empty). The cap is applied **before** the parse check, so a parseable id sitting past the 12th entry is dropped along with the entries that displaced it — an over-long list of junk cannot smuggle real ids in behind it. |
| `makeSnapshotParser(caps)` | `from` is not a parseable peer id, or `timestamp` is not finite | `successors` / `predecessors` truncated to `caps` then non-strings dropped; `sample` truncated then vetted per entry (id string, `coord` decodes to exactly 32 bytes, `relevance` finite) with a skip-and-log per drop; `size_estimate` / `confidence` / `metadata` dropped individually when the wrong type, and the two numerics also when **out of range** — `size_estimate` below 0, `confidence` outside `[0, 1]` |
| `parsePingResponse` | `ok` is not a boolean | projects to `{ ok, size_estimate?, confidence? }`, dropping either numeric when not finite or out of range (the same `[0, Infinity]` / `[0, 1]` bounds as the snapshot) |
| `parseNearAnchor` | `estimated_cluster_size` or `confidence` is not finite | `anchors` ≤ 8, `cohort_hint` ≤ 16, missing → `[]` |
| `parseMaybeActReply` | neither reply shape matches | discriminates on `commitCertificate` being a string, else parses as a NearAnchor |

Three rules in that table are decisions rather than mechanics:

- **Truncate, don't reject, for the snapshot's id lists.** Truncating costs an honest peer running a
  larger profile only the entries past the cap; rejecting the whole message would cost it every
  entry. The receiver's bound is met either way, because truncation happens ahead of the
  parse-and-hash loop rather than inside it. `makeSnapshotParser` is a factory over
  `{successors, predecessors, sample}` precisely so that this — the *only* site where the caps are
  enforced — takes its numbers from `mergeSnapshotCaps()` and from nowhere else.
- **Skip-and-log per `sample` entry**, which is today's merge-loop rule kept deliberately. A `coord`
  is vetted by *decoding* it, so a wrong-width coordinate is dropped here instead of reaching the
  store's write seam, where it throws — and a throw inside a merge loop is exactly the leak the
  parsers exist to stop. (`importTable`'s all-or-nothing rule is the other case and is untouched: a
  corrupt persisted table is better refused whole.)
- **`ok` must be a boolean** on a ping reply. A legal value always encodes as one, so the
  `Boolean(r.ok)` coercion it replaced could only ever have hidden a malformed peer.

The reply caps are set so a cap can never refuse this node's own legal output: `pickAnchors` yields
at most 2 anchors and the cohort hint is built from at most 8 ids, so 8 / 16 are 4× and 2× the
largest lists the producers can emit.

**Every reply parser is wired into its sender, through one adapter.** `rpcRequest`'s decode phase
has no `undefined` check — a throw becomes `decode-error`, but a *returned* `undefined` becomes
`{kind: 'ok', value: undefined}`, exactly the "an `ok` carrying `undefined` dressed as the reply"
failure its two overloads exist to prevent, and it type-checks silently (`T` infers as
`Reply | undefined`). So a `Parser` is never passed in as `decode`; it goes through
`parseOrThrow(parse, msg)` (`src/rpc/validate.ts`), which raises a named `ReplyRejectedError`
(matched by `isReplyRejectedError`, the house rule the `isFrameTruncationError` /
`isPayloadTooLargeError` pair already follows) when the parser rejects. The alternative — teaching
`rpcRequest` to read a returned `undefined` as `decode-error` — is simpler at the three call sites
but makes `undefined` unreturnable as a legitimate reply for every consumer of a publicly exported
helper, so `rpcRequest` is left untouched. The adapter, the error class and the predicate are
exported from the package root beside the parsers, since passing a parser in raw is a silent bug
rather than a compile error for a consumer too.

| Sender | Reply parser |
|---|---|
| `sendPing` | `parsePingResponse` — this *is* the removed `Boolean(r.ok)` coercion's replacement |
| `sendMaybeAct` | `parseMaybeActReply` |
| `fetchNeighbors` | a snapshot parser **supplied by the caller** on the options bag (`opts.parse`), because only the caller knows its profile's merge caps. `FretService` passes `makeSnapshotParser(this.mergeSnapshotCaps())` — the same one method the announce path's `snapshotParser` takes its numbers from, so the parser truncates ahead of the parse-and-hash loop and the loop itself never slices. It carries the same `Infinity`-caps default `registerNeighbors`' `snapshotParser` does ("validate the shape, truncate nothing"), reachable only from tests |
| `announceNeighbors`, `sendLeave` | write-only — no `decode`, so no parser |

A rejection is therefore `decode-error`, which is proof of life and never a contact strike
(`noteRpcFailure` decays relevance only) — the right classification, since a reply that arrived
over this network's namespaced protocol is membership evidence whatever its body says. A `busy`
reply is unaffected: `rpcRequest` tests the busy shape on the parsed body *before* `decode` runs,
so a validator never sees one. Pinned by the wired-path phase of
`test/rpc.codec-properties.spec.ts`, which drives all three senders against a served frame and
asserts on the `ok` *value* rather than merely on `kind` — written against a raw parser the
malformed-reply property fails, and a kind-only assertion would pass vacuously.

Because `encodeJson` drops an own property whose value is `undefined`, an optional field can only
ever arrive *absent* — so a parser that demanded `null`, or rejected a missing optional, would
refuse a message its own encoder produced. `test/rpc.codec-properties.spec.ts` pins that as a
round-trip property over generated **legal** instances (real peer ids, real coordinates), alongside
a never-throws property over deliberately illegal ones.

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
- Integration tests: Join/leave scenarios, stabilization convergence, and real two-node RPC over
  a live libp2p stream (`test/rpc.two-node-framed.spec.ts`) — a reply actually written is never
  reported as cut off, across a spread of reply timings.
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
    deterministic replay of a full partition/heal schedule. A route across a *fresh* cut is a
    separate case from a route across an escalated one: after escalation the cross entries are
    already `dead` and the pool is empty, an outcome an oracle filter would also produce, so the
    proof that routing is local is a route fired in the window between the cut and escalation —
    it must fail *and* book refused contacts *and* leave a strike behind.
  - **The sim routes the way a node does.** Each hop is chosen by the shipped `chooseNextHop`
    (cost path) over the deciding peer's own store; the candidate pool reads neither the global
    `alive` flag nor the partition map, so a peer learns a hop is unreachable only when its own
    contact attempt fails — and that failure strikes the entry through the same escalation the
    per-tick contact sweep uses (one shared `recordContactFailure`). A chosen hop is an attempt,
    not a delivery: a refusal costs attempt budget and the selector runs again over what is
    left, so only delivered hops count toward path length. `selfCoord` is supplied from the
    second hop onward only, matching production's originator/forwarder split, and the near
    radius derives from `store.size()` rather than the harness's alive count. Churn is
    scheduled lazily and pairs a join with every leave, so a non-zero rate measures behavior
    under churn rather than population collapse.
  - **Routing itself is guarded, within a stated limit** (`test/simulation.routing.spec.ts`):
    success rate and p90 hop count over successful routes only, on a dense 200-peer ring, a
    sparser 1000-peer all-edge ring, and that ring under churn, plus a direct assertion on the
    selector — not on a route outcome — that a peer already nearest the key has no
    strictly-improving first hop, which is *why* `selfCoord` is withheld when originating. That
    case cannot be driven through a route: a peer nearest a coordinate is that coordinate's
    anchor in its own store, so the route completes at hop 0 without the selector ever running.
    The sim's own from-hop-2 split is therefore unpinned by any route in that spec; it can bite
    only when every entry nearer the key in the originator's store is `dead`, which is a
    partition-shaped case rather than a routing one. The thresholds are set from measured runs across four seeds
    (95–100% success, p90 2 hops) and shown to bite: inverting the selector's preference moves
    p90 from 2 to ~19. **The hop bound is the sensitive measure, not the success rate** — the
    attempt budget absorbs a bad route until it stumbles onto the target. The spec deliberately
    does not claim to discriminate one plausible ring metric from another: substituting
    clockwise-only distance, or XOR, for `minDistance` moves neither number, because the sim's
    stores are unbounded and its gossip merges every neighbor's window each tick, leaving each
    peer a large near-uniform slice of the ring (63% at n=200, 19% at n=1000) over which greedy
    routing arrives in one or two hops under any roughly-monotone metric. Making metric quality
    measurable needs sparse, finger-shaped stores, which needs the sim's eviction to stop being
    degenerate (every entry ties at relevance 0, so it collapses to ring order) — until then
    `capacity` is left unset in that spec, since setting it would measure eviction instead.
- Benchmarks: Routing latency, memory usage, message overhead

### Open questions / next steps
- Exact relevance weight tuning based on network simulations
- Optimal CBOR vs protobuf tradeoffs for different message types
- Identity cost mechanism for open-path Sybil resistance (PoW difficulty, stake, or hybrid)
- End-to-end payload encryption scheme compatible with progressive routing (cluster key agreement, onion encryption, or coordinator-targeted encryption with re-encryption on redirect)
- VRF-based ring coordinate rotation (epoch nonce rotates positions, preventing permanent ID grinding)
- Integration timeline with existing KadDHT-dependent code
