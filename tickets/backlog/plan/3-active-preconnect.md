description: Active preconnect mode for pre-dialing anchor/neighbor peers
dependencies: FRET core (active/passive state, connection management)
----

Pre-dial a small set of anchor and neighbor peers during active mode to avoid serial dial chains during routing.

### Behavior

- When entering active mode (refcount > 0), pre-dial a bounded set of hot peers: route-critical successors, near-h nodes, recent routing nodes.
- Back off on dial failures with exponential backoff and jitter.
- Budget is profile-tuned: Edge 2–4 peers/sec max 2 concurrent; Core 6–12 peers/sec max 4–6 concurrent.
- Exit active when all refcounts drop to zero; stop pre-dialing.

### Design

- Pre-dial list refreshed each active cycle from routing table relevance + predicted utility.
- Dial attempts don't block routing; they warm connections opportunistically.
- Track dial success/failure for backoff and relevance updates.

See [fret.md](../docs/fret.md) — Active vs passive state, Operating profiles.
