description: Anti-eclipse measures: random walk discovery, multi-path bootstrap verification, S/P change alerts
dependencies: none — design exploration ticket
files: src/service/fret-service.ts (stabilizeOnce ~line 715-722, seedFromBootstraps ~line 686-713), docs/fret.md
----

### Problem

A full eclipse attack places Sybil nodes at ring coordinates immediately surrounding a target. Since `stabilizeOnce` only probes up to 4 near neighbors and merges their snapshots, if all near neighbors are attacker-controlled, the target receives only attacker-curated views. The target cannot discover honest peers through any current mechanism.

The design doc mentions three mitigations that are not implemented:

1. **Mandatory bootstrap verification through multiple paths** — `seedFromBootstraps` trusts bootstrap peers from config without cross-verification.
2. **Periodic random walks to discover new peers** — no random walk mechanism exists. Discovery is entirely through neighbor snapshots and stabilization.
3. **Alert on sudden S/P set changes** — no monitoring of S/P set composition changes.

Eclipse attacks are particularly damaging with Right-is-Right: an eclipsed node's dispute escalation messages route through the attacker, who can suppress or redirect them. The defense mechanism is neutralized.

### Expected behavior

1. **Random walk discovery**: Periodically initiate routing queries for random ring coordinates to discover peers outside the immediate neighborhood. Merge discovered peers into the routing table to maintain topological diversity.
2. **Multi-path bootstrap verification**: On initial join and periodically thereafter, verify neighbor sets through multiple independent bootstrap paths. Flag inconsistencies.
3. **S/P set change monitoring**: Track the composition of S/P sets over time. Alert (emit event to higher layers) when a large fraction of S/P entries change in a short window, which is a strong signal of an eclipse in progress.

### Threat references

- threat-analysis.md §2.1 (Critical): Full eclipse via S/P set control
- threat-analysis.md §7.5 (High): Bootstrap poisoning
- threat-rir-mitigated.md §2.1: Unchanged by RiR — eclipsed nodes can't reach honest dispute participants
