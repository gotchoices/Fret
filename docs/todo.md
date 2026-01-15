* FRET overlay validation and testing
  * Build a deterministic simulation harness (headless) for FRET
    * Deterministic RNG + seeded topology generator (N peers on 256-bit ring)
    * Event scheduler for joins/leaves/link-latency; bounded queues to emulate backpressure
    * Metrics: stabilization convergence time, neighbor coverage, path length, drop rates
  * Property-based tests (fast-check)
    * Ring invariants: symmetric m predecessors/successors, wrap-around, no duplicates
    * Cohort assembly: two-sided alternation correctness, monotonic expansion
    * Anchor selection: connected-first preference within tolerance; depends on size estimate/confidence
  * RPC codec fuzzing (JSON)
    * Round-trip encode/ decode; malformed/truncated payloads do not crash handlers
    * Backpressure signals honored; token-bucket limits enforced per-peer and global
  * Size estimator evaluation
    * Synthetic rings with gaps/skew; assert n within tolerance and confidence monotonic with sample size
  * Relevance scoring and eviction
    * Down-rank on failures/timeouts; neighbors have infinite eviction score; verify decay bounds
  * Churn scenarios (simulation)
    * Batched leave/join; proactive neighbor announcements maintain coverage; routeAct still finds anchors
  * Libp2p in-memory integration tests
    * Use memory transport to spin up 3–10 nodes; verify neighbor exchange, routeAct anchors, stabilization without real network
  * Profiles and rate limits
    * Edge vs Core: ensure limits, queue depths, and act concurrency honored
  * CI matrix
    * Run simulation across N∈{5,25,100}, churn∈{0,1,5}%/s, profiles∈{edge,core}; export JSON metrics artifacts

* FRET implementation (remaining)
  * Add round-trip timing into peer cache; given this a relevance score so that "nearer" peers get preference.  How to score?  Maybe incrementally maintain the distribution of timings and gaussian score relatively.
  * Register FRET as a libp2p PeerDiscovery module that emits discovered peers from neighbor snapshots
  * Proactive announcements on start and after topology change (bounded fanout, non-connected only)
  * Iterative anchor lookup and forwarding (maybeAct): TTL, breadcrumbs, connected-first next-hop
  * Seed new peers quickly: include bounded snapshot samples and size/confidence; exchange on first contact
  * Active preconnect mode: pre-dial small anchor/neighbors set; back off on failures
  * Enforce payload bounds and TTL checks in all RPCs; explicit backpressure signals
  * Leave protocol usage: sendLeave to S/P (+bounded expansion) and neighbor announce replacements
  * Optional fingers: maintain small long-range finger set; refresh probabilistically
  * Diagnostics: counters for RPCs, hop counts, convergence; debug toggle in README

* Documentation
  * Expand docs/fret.md with simulator design, invariants, and test methodology
  * Document JSON schemas for RPCs and expected responses with examples
