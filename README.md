# FRET

**Finger Ring Ensemble Topology** — A Chord-style ring overlay for libp2p with JSON RPCs and a Digitree-backed cache.

FRET provides discovery and routing for libp2p services without proof-by-exhaustion queries, enabling deterministic cluster construction, efficient routing, and robust operation under churn.  As a result, FRET is designed to work efficiently (mobile friendly) under any size of DHT, from 2 nodes, to 2M.

## Overview

FRET replaces traditional KadDHT-based routing with a Chord-style ring overlay optimized for:

- **Fast discovery** with symmetric successor/predecessor neighbor sets
- **Logarithmic routing** via distance-balanced caching (emergent finger tables)
- **Low chatter** through profile-tuned rate limiting and backpressure
- **Churn resilience** with relevance-based peer scoring and stabilization

### Key Concepts

- **Ring Topology**: Peers are mapped to a 256-bit ring via SHA-256 hashing. Routing proceeds by greedy forwarding toward the target coordinate.
- **Symmetric Neighbors**: Each peer maintains balanced successor and predecessor sets for routing resilience and fast convergence.
- **Digitree Store**: A B+Tree-based cache with relevance scoring that self-organizes into a distance-balanced structure, providing finger-table-like routing efficiency without explicit finger maintenance.
- **Two-Sided Cohorts**: Cluster membership is determined by alternating walks from successor and predecessor anchors, enabling local membership tests and adaptive quorum sizing.

## Features

- **Chord-style Ring**: Distributed hash table with logarithmic routing
- **Digitree Cache**: Efficient peer storage with relevance-weighted eviction
- **Network Size Estimation**: Real-time tracking with confidence metrics and partition detection
- **Neighbor Discovery**: libp2p-compatible peer discovery interface
- **Route Optimization**: Connected-first bias with distance/quality/backoff weighting
- **Operating Profiles**: Edge (mobile/lightweight) and Core (server-grade) configurations

## Installation

```bash
yarn add p2p-fret
```

## Quick Start

```typescript
import { createLibp2p } from 'libp2p'
import { FretService } from 'p2p-fret'

// Create a libp2p node with FRET
const node = await createLibp2p({
  // ... libp2p config
})

// FRET integrates as a libp2p service providing:
// - Peer discovery via S/P/F sets
// - Network size estimation
// - Cohort assembly for cluster operations
```

## Protocols

FRET communicates via length-prefixed UTF-8 JSON messages:

| Protocol | Purpose |
|----------|---------|
| `/fret/1.0.0/ping` | Lightweight liveness checks with size estimates |
| `/fret/1.0.0/neighbors` | Neighbor snapshot exchange for stabilization |
| `/fret/1.0.0/maybeAct` | Unified find + action pipeline |
| `/fret/1.0.0/leave` | Graceful departure notifications |

## Network Size Estimation

FRET provides real-time network size estimation by aggregating observations from multiple sources:

- **Digitree Analysis**: Primary estimation from finger table and neighbor cache
- **Ping Responses**: Peers share size estimates in ping messages
- **Neighbor Announcements**: Size hints in neighbor snapshots
- **External Reports**: Upper layers can contribute observations

```typescript
// Get current estimate with confidence
const { size_estimate, confidence, sources } = fretService.getNetworkSizeEstimate()

// Calculate churn rate (peers/minute)
const churn = fretService.getNetworkChurn()

// Check for potential partition
if (fretService.detectPartition()) {
  console.warn('Potential network partition detected!')
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Application                          │
├─────────────────────────────────────────────────────────────┤
│  FretService                                                │
│  ├── Cohort Assembly (two-sided alternating walk)          │
│  ├── RouteAndMaybeAct (unified discovery + action)         │
│  └── Size Estimation (weighted aggregation)                │
├─────────────────────────────────────────────────────────────┤
│  Digitree Store                                             │
│  ├── B+Tree by ring coordinate                             │
│  ├── Relevance index (recency, frequency, health, sparsity)│
│  └── S/P neighbor sets (infinite relevance)                │
├─────────────────────────────────────────────────────────────┤
│  RPC Layer                                                  │
│  ├── Ping, Neighbors, MaybeAct, Leave handlers             │
│  └── Token bucket rate limiting per peer                   │
├─────────────────────────────────────────────────────────────┤
│                        libp2p                               │
└─────────────────────────────────────────────────────────────┘
```

## Configuration

Default values (tunable per deployment):

| Parameter | Default | Description |
|-----------|---------|-------------|
| k | 15 | Cluster size target |
| m | 8 | Successor/predecessor set size |
| C | 2048 | Routing table capacity |
| Ts (passive) | 1–3s | Stabilization period |
| Ts (active) | 250–500ms | Active mode stabilization |

### Operating Profiles

**Edge** (mobile/lightweight):
- Lower rate limits and smaller snapshots
- Conservative pre-dial budget
- Longer stabilization cadence

**Core** (server-grade):
- Higher throughput limits
- Aggressive pre-dial during active operations
- Faster stabilization for rapid topology healing

## Development

```bash
# Build
yarn build

# Test
yarn test

# Lint
yarn lint

# Format
yarn format
```

## Project Structure

```
packages/fret/
├── src/
│   ├── estimate/       # Network size estimation
│   ├── ring/           # Ring arithmetic (distance, hashing)
│   ├── rpc/            # Protocol handlers (ping, neighbors, leave, maybeAct)
│   ├── selector/       # Next-hop selection
│   ├── service/        # FretService and libp2p integration
│   ├── store/          # Digitree store and relevance scoring
│   └── utils/          # Token bucket, helpers
└── test/
    ├── simulation/     # Deterministic simulation harness
    └── *.spec.ts       # Unit and integration tests
```

## Documentation

- [Design Document](docs/fret.md) — Full specification including wire formats, algorithms, and security considerations
- [Package README](packages/fret/README.md) — API details and integration examples

## License

MIT
