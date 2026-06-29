description: When several separate networks run on the same physical machines, a node can end up treating peers that actually belong to a *different* network as if they were its own neighbors. Later operations that try to contact those peers fail, because the peers don't speak this network's protocols. A node should only admit a peer into its neighbor ring if that peer actually participates in the same network.
prereq:
files:
  - packages/fret/src/rpc/protocols.ts (protocol strings are already namespaced: `/optimystic/${networkName}/fret/1.0.0`)
  - packages/fret/src/service/fret-service.ts (networkName resolved at L145; this.protocols at L148; ring/neighbor bookkeeping)
  - packages/fret/src/service/discovery.ts (peer admission into the ring)
  - packages/fret/src/service/peer-discovery.ts (libp2p-driven peer discovery feed)
  - packages/fret/src/rpc/neighbors.ts (neighbor-exchange — can propagate a foreign peer transitively)
  - packages/fret/src/index.ts (FretConfig.networkName)
  - docs/fret.md (Discovery / Ring membership sections)
difficulty: medium
----

# Scope FRET ring admission to peers that serve this network

## The problem in plain terms

FRET already *talks* in a network-scoped way: every wire RPC uses a protocol string namespaced by
`networkName` — `/optimystic/${networkName}/fret/1.0.0` (`rpc/protocols.ts`). Two FRET services with
different `networkName`s therefore cannot exchange FRET RPCs with each other.

But **ring membership is not scoped the same way.** When two distinct networks (say `control-A` and
`control-B`) run on the **same machines / shared bootstraps**, the FRET service for `control-A`
admits a `control-B` peer into its neighbor ring anyway — admission is driven by network-agnostic
libp2p peer discovery / connected peers, not by whether the peer participates in *this* FRET network.
The `control-B` peer never registered `control-A`'s namespaced protocols, so:

- it sits in `control-A`'s ring as a routing candidate (counted by neighbor/cohort assembly and size
  estimation), yet
- any attempt to actually use it for `control-A` — a FRET RPC, or a downstream coordinator dial —
  cannot negotiate the protocol.

## Why this matters (downstream symptom)

This was found from the consuming side (Optimystic → Sereus). Optimystic's coordinator/cohort
selection derives members from FRET's neighbor/cohort output. When a write needs a small cohort and a
foreign peer is sitting in the ring near the key, the write selects it as a co-coordinator, dials its
per-network repo protocol, and fails:

```
Failed to get super-majority: 1/2 approvals (needed 2)
  cause = could not negotiate /optimystic/control-<other>/repo/1.0.0
```

Optimystic has already shipped a *selection-layer* mitigation
(`multi-coordinator-cross-network-coordinator-selection`, complete): it filters peers it can prove are
foreign (non-empty protocol list with none for this network) out of selection. But it cannot reliably
distinguish a *permanently foreign* peer from a *freshly-discovered same-network* peer, because a
cross-network peer's namespaced `identify` never completes and its peerStore protocol list stays
**empty** — the same "unknown" state a brand-new same-network peer is in for a moment. The robust
cure is to **not admit the foreign peer into the ring in the first place**, which only FRET can do.

## What FRET should guarantee

A peer is admitted to (and retained in) network N's neighbor ring only if it actually participates in
network N — i.e. it serves / responds on network N's namespaced FRET protocol. A peer that belongs
only to another network must never appear as a neighbor, cohort member, or routing candidate for
network N, and must not be counted in network N's size estimate.

## Design surface to resolve (pick one; document the tradeoff)

- **Admission-time probe.** On discovery, before adding a peer to the ring, confirm it speaks this
  network's FRET protocol (e.g. a lightweight ping/neighbors handshake on
  `/optimystic/${networkName}/fret/1.0.0`, or a peerStore protocol check once `identify` completes).
  Only then admit it. Cleanest, but adds a gate on the discovery hot path.
- **Lazy demotion / eviction.** Admit optimistically, but evict (and stop counting) a peer once a
  FRET RPC to it fails protocol negotiation, or once `identify` completes and shows it does not serve
  this network. Cheaper on discovery; a foreign peer can transiently pollute the ring until first
  contact.
- **Source-scoped seeding.** Seed the ring only from peers learned through *this network's* FRET
  channels (neighbor-exchange over the namespaced protocol), rather than from the libp2p peerStore /
  connected-peer set at large. Foreign peers never enter because they are never a seed source.

Whichever is chosen, **neighbor-exchange must not re-introduce foreign peers** transitively — a
neighbor list received from a same-network peer should still be membership-checked before its entries
are admitted.

## Edge cases & interactions

- **Fresh same-network peer (not yet identified)** must not be permanently excluded — it should be
  admitted (possibly after the probe completes), not treated as foreign. Distinguishing "not yet
  confirmed" from "confirmed foreign" is the crux.
- **Single-network deployments** (the overwhelmingly common case) must see no behavior change and no
  added latency beyond the chosen gate.
- **Size estimation** (`estimate/size-estimator.ts`) must count only same-network peers, or the
  estimate (and `d_max`) skews when foreign peers linger.
- **Self** is always a member.
- **Churn / reconnection**: a peer that legitimately joins this network later (e.g. starts serving
  the protocol after a profile change) must be (re)admittable — eviction must not be permanent.
- **Relayed / limited connections**: membership determination must work over the same connection
  types FRET already supports (see completed `fix(rpc): run FRET wire RPCs over limited connections`).

## Reproduction available

The Sereus integration suite reproduces the downstream failure today:
`packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts` Phase 2 (both parties
`profile: 'storage'`, i.e. two coordinator-eligible nodes on separate control networks sharing the
mesh) and `strand-membership-closed-strand-e2e.integration.ts` — 4 fail / 13 pass with the signature
above. A FRET-local reproduction (two `fretService` instances with different `networkName`s sharing a
bootstrap; assert network-A's ring never contains the network-B peer) should be built first when this
ticket is promoted.

## Acceptance

- Two FRET services with different `networkName`s sharing a bootstrap: each one's ring, neighbor set,
  cohort output, and size estimate contain only same-network peers (+ self). A foreign peer is never
  admitted (or is promptly evicted, per the chosen approach).
- A fresh same-network peer is admitted once confirmed and is never starved out by the membership gate.
- Single-network behavior and discovery latency are unchanged (regression guard).
- `docs/fret.md` Discovery / Ring-membership sections describe the network-scoped admission rule.
