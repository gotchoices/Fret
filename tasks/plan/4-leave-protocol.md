description: Graceful leave protocol with replacement suggestions
dependencies: FRET core (S/P sets, Digitree, neighbor management)
----

Implement the graceful departure protocol so peers can leave cleanly.

### Behavior

1. Send leave notification to all S(p) ∪ P(p) with suggested replacements from Digitree.
2. Optionally expand notification to a bounded set of additional peers beyond immediate S/P.
3. Recipients immediately remove departing peer and probe suggested replacements.
4. Announce replacement candidates to affected neighbors.

### Wire format

Uses `/fret/1.0.0/leave` protocol with LeaveNotice message containing:
- Departing peer ID
- Suggested replacement peer IDs (bounded list)
- Timestamp and signature

### Considerations

- Bounded expansion: don't notify the entire network, just affected neighbors + small fan-out.
- If departing peer can't reach all S/P (partial connectivity), best-effort delivery.
- Integrate with stabilization: stabilization detects the gap if leave notification was missed.

See [fret.md](../docs/fret.md) — Leave protocol, Stabilization and churn handling.
