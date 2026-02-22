description: Proactive neighbor announcements on start and topology change
dependencies: FRET core (neighbor management, stabilization)
----

Announce presence proactively to accelerate topology convergence.

### Behavior

- On join (after initial stabilization): announce self to discovered S/P peers.
- On topology change (peer departure detected, new peers discovered): announce to affected neighbors with bounded fanout.
- Only announce to non-connected peers (already-connected peers learn via normal exchange).
- Bounded: limit announcement rate and fan-out to prevent storms.

### Design

- Announcement is a lightweight message (self ID + coordinate + compact neighbor hint).
- Recipients merge into their table and may reciprocate.
- Rate-limit announcements per profile (Edge conservative, Core aggressive).

See [fret.md](../docs/fret.md) — Stabilization and churn handling, Neighbor management & snapshots (A3).
