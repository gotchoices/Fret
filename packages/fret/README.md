# @optimystic/fret

FRET: Finger Ring Ensemble Topology — a Chord-style ring overlay for libp2p with JSON RPCs and a Digitree-backed cache.

## Features

- **Chord-style Ring**: Distributed hash table with finger table routing
- **Digitree Cache**: Efficient peer storage and lookup
- **Network Size Estimation**: Real-time tracking of network size with confidence metrics
- **Partition Detection**: Monitors for sudden network changes and potential partitions
- **Neighbor Discovery**: Automatic peer discovery and announcement
- **Route Optimization**: Intelligent next-hop selection for DHT operations

## Development

- Build

```
yarn workspace @optimystic/fret build
```

- Test (node only for now)

```
yarn workspace @optimystic/fret test
```

## Network Size Estimation

FRET provides real-time network size estimation by aggregating observations from multiple sources:

### Observation Sources

1. **FRET Digitree**: Primary estimation based on finger table and neighbor cache
2. **Ping Responses**: Peers share their size estimates in ping messages
3. **Neighbor Announcements**: Size hints included in neighbor snapshots
4. **External Reports**: Upper layers (e.g., cluster messages) can report observations

### API

```typescript
interface FretService {
  // Report an external network size observation
  reportNetworkSize(estimate: number, confidence: number, source?: string): void;
  
  // Get current size estimate with confidence
  getNetworkSizeEstimate(): { 
    size_estimate: number; 
    confidence: number; 
    sources: number 
  };
  
  // Calculate rate of network size change (peers/minute)
  getNetworkChurn(): number;
  
  // Detect potential network partition
  detectPartition(): boolean;
}
```

### Size Estimation Algorithm

FRET uses **exponential decay weighting** to favor recent observations:

- Recent observations get higher weight
- Confidence multiplied into weight calculation
- Rolling 5-minute window (configurable)
- Maximum 100 observations stored

### Partition Detection

FRET detects potential partitions using multiple signals:

- **Sudden size drop**: >50% reduction indicates potential partition
- **High churn rate**: >10% peers/minute is suspicious
- **Confidence tracking**: Low confidence suggests instability

### Integration Example

```typescript
// FRET automatically includes size estimates in ping responses
registerPing(node, PROTOCOL_PING, () => {
  return fretService.getNetworkSizeEstimate();
});

// Upper layers can report observations back to FRET
fretService.reportNetworkSize(observedSize, 0.8, 'cluster-message');

// Check network health
if (fretService.detectPartition()) {
  console.warn('Potential network partition detected!');
}
```

## Routing Table Persistence

FRET's routing table is in-memory by default. The `exportTable` / `importTable` API lets you snapshot and restore it across restarts, avoiding cold-start bootstrap latency.

### API

```typescript
interface FretService {
  // Export the full routing table as a JSON-serializable snapshot
  exportTable(): SerializedTable;

  // Import a previously exported snapshot; returns number of entries loaded
  importTable(table: SerializedTable): number;
}

interface SerializedTable {
  v: 1;
  peerId: string;               // exporter's PeerId
  timestamp: number;            // unix ms at export time
  entries: SerializedPeerEntry[];
}

interface SerializedPeerEntry {
  id: string;                   // PeerId
  coord: string;                // base64url ring coordinate
  relevance: number;
  lastAccess: number;
  state: PeerState;
  accessCount: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  metadata?: Record<string, any>;
}
```

### Usage

```typescript
import { createFret, type SerializedTable } from 'p2p-fret';
import fs from 'node:fs/promises';

const fret = createFret(libp2pNode, { capacity: 2048 });

// Save before shutdown
const table = fret.exportTable();
await fs.writeFile('fret-table.json', JSON.stringify(table));

// Restore on startup (before or after start())
const saved: SerializedTable = JSON.parse(
  await fs.readFile('fret-table.json', 'utf-8')
);
const count = fret.importTable(saved);
console.log(`Restored ${count} routing entries`);

await fret.start();
```

### Behavior

- **State reset**: All imported entries get `state: 'disconnected'` regardless of their exported state — connection liveness must be re-established through pings and stabilization.
- **Capacity enforcement**: `importTable` enforces the configured capacity after loading. A table exported from a node with a larger capacity won't exceed the importer's limit.
- **Stale data safety**: After import, the normal stabilization loop probes peers to update connection states and relevance scores. Unreachable peers are decayed and eventually evicted.
- **JSON round-trip safe**: `SerializedTable` survives `JSON.stringify` / `JSON.parse`.

## Test harness (local meshes)

A minimal harness will spin up a small libp2p mesh in-process and exercise:
- Join/bootstrap seeding
- Neighbor snapshots and discovery emissions
- Routing (routeAct) hop counts and anchors
- Diagnostics counters (pings, snapshots, announcements)
- Network size estimation accuracy

The harness will live under `test/` and use profile-tuned configs for edge/core.

