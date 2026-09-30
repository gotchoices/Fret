description: Peers learn each other through FRET by identity only, so a peer reachable only through a relay can be a ring member that nobody but its relay can dial. Make each neighbour snapshot carry the named peers' signed address records, and have the receiver verify them and hand them to libp2p so dialing by peer id just works.
architecture: docs/fret.md#dialability-can-we-reach-this-peer-at-all
files: packages/fret/src/index.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/rpc/validate.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/service/address-records.ts (new), packages/fret/src/service/fret-service.ts, packages/fret/src/service/libp2p-fret-service.ts, packages/fret/src/service/peer-discovery.ts (comments only), packages/fret/package.json, packages/fret/test/helpers/relay.ts, packages/fret/test/address-hints.relay.spec.ts (new), packages/fret/test/address-hints.ingest.spec.ts (new), packages/fret/test/rpc.codec-properties.spec.ts, docs/fret.md
difficulty: hard
----
# Signed address hints in the neighbour exchange (live half)

Maintainer decision (2026-09-28, recorded in the plan ticket this replaces): carry **libp2p signed peer records** in the neighbour exchange. Fixes gotchoices/Optimystic#11 — a NAT-only peer reachable only via a circuit relay becomes a ring member, but no third party learns its `/p2p-circuit` address, so every sibling-initiated dial fails with `NoValidAddressesError`. The persisted-table half (restart, gotchoices/sereus#18) is the follow-on ticket `address-hints-persisted-table`; it depends on the per-entry field this ticket adds.

## What libp2p already gives us (researched, libp2p 3.1.3 / @libp2p/peer-record 9.0.5)

- `RecordEnvelope` over `PeerRecord` (domain `PeerRecord.DOMAIN`) is the signed, replay-protected address record. `PeerRecord` carries `peerId`, `multiaddrs`, `seqNumber` (bigint; libp2p convention `BigInt(Date.now())`).
- `peerStore.consumePeerRecord(bytes, { expectedPeer })` verifies the signature, checks the **signer** equals `expectedPeer`, rejects a `seqNumber` ≤ the stored one, then **replaces** the peer's addresses with the record's (marked certified) and stores the envelope as `Peer.peerRecordEnvelope`. It throws on an undecodable/badly-signed envelope and returns `false` on signer mismatch or stale seq.
  - **It does NOT check that the record's payload `peerId` equals the signer** (identify does; `consumePeerRecord` patches `peerRecord.peerId` blindly). FRET must check `payload.peerId === signer === hint id` itself before calling it, or a peer could sign a record that rewrites *another* peer's addresses.
- libp2p does **not** keep a signed record for *self* in the peerStore; identify seals one on demand from `addressManager` and throws it away. So FRET seals its own, which needs the node's private key. The `Libp2p` interface does not expose it; libp2p hands it to services as the `privateKey` component.
- `node.getMultiaddrs()` reports the bare `/p2p-circuit` listen placeholder from start-up and the real `/ip4/…/p2p/<relay>/p2p-circuit/p2p/<self>` once a reservation lands (see `test/helpers/relay.ts`).
- The peerStore needs no `start()` (`PersistentPeerStore` is not Startable), so writing it is safe at any time.

## Design

### Types

- `FretConfig.privateKey?: PrivateKey` (`import type` from `@libp2p/interface`). This is the same field `tickets/backlog/21-feat-message-signatures.md` plans; landing it here means that ticket reuses it. The core constructor throws if `peerIdFromPrivateKey(privateKey)` does not equal `node.peerId` (caller bug). Absent → this node emits no hint for itself (logged once at `start()`); everything else — forwarding others' records, consuming hints — still works.
- `Libp2pFretService`: `Components` becomes `{ libp2p?: Libp2p; privateKey?: PrivateKey }`; the core gets `cfg.privateKey ?? components.privateKey`, so the ordinary `libp2p({ services: { fret: fretService() } })` registration signs with no extra wiring.
- Wire: `NeighborSnapshotV1.hints?: AddressHintV1[]`, exported `interface AddressHintV1 { id: string; record: string }` — `record` is the base64url of the marshaled envelope. **No version bump**: `v` stays `1`; the field is optional and older readers drop or ignore it (the parsers never check `v`). An array, not an id-keyed object, so it truncates like the other lists and has no `__proto__`-key hazards.
- Store: `PeerEntry.addressRecord?: { envelope: Uint8Array; confirmedAt: number }` — opaque bytes plus the local-clock time the record was accepted. The store stays network- and libp2p-agnostic: it never parses the bytes. `upsert` preserves it (spread), `update` patches it. Not serialized in this ticket (`exportEntries` lists fields explicitly, so nothing to change there); the follow-on ticket serializes it.

### New module `src/service/address-records.ts`

Small, pure where possible:
- `peekPeerRecord(bytes): { signer: string; peerId: string; seq: bigint } | undefined` — `RecordEnvelope.createFromProtobuf` + `PeerRecord.createFromProtobuf` + signer from `envelope.publicKey`. **Structural only, no signature check, never throws.** Used for the cheap pre-checks below.
- `selfRecordAddrs(node): Multiaddr[]` — `getMultiaddrs()` projected the way identify does (`decapsulateCode(CODE_P2P)` to strip the trailing `/p2p/<self>`), deduped, **dropping a circuit address with no relay hop** (the bare `/p2p-circuit` placeholder is not dialable) and **ordering reserved circuit addresses first**, then capped at `MAX_SELF_RECORD_ADDRS = 8`. Nothing else is filtered — no public/private test, since for a relay-only peer the circuit address is the only useful one and the address manager already applied the host's announce/noAnnounce config.
- A small `SelfAddressRecord` holder: `current(node, privateKey): Promise<string | undefined>` returns the cached base64url record, **re-sealing lazily** when the projected address list differs from the one last sealed (no event listener, so nothing to detach on `stop()`). Seq is `max(BigInt(Date.now()), lastSeq + 1n)` so two seals in one millisecond still order. A record whose encoding exceeds `MAX_ADDRESS_RECORD_CHARS` is logged and omitted.

### Constants (put the size ones in `src/rpc/validate.ts` beside the metadata budgets — they are part of the same frame invariant)

| Constant | Value | Why |
|---|---|---|
| `MAX_NEIGHBORS_BYTES` | 16 KiB → **64 KiB** | Frame cap must admit any profile's largest legal emission; Sereus used 64 KiB for the same payload |
| `MAX_ADDRESS_RECORD_CHARS` | 2048 | One base64url record. Ed25519 + a few addrs is ~300–700 chars; leaves room for RSA keys and 8 addresses |
| `MAX_SNAPSHOT_HINT_BYTES_CORE` / `_EDGE` | 48 KiB / 16 KiB | Emission budget for the whole `hints` array, profile-split like the metadata allowance. Core worst case: 11,575 (today's worst) + 49,152 + field overhead < 65,536 |
| `MAX_SELF_RECORD_ADDRS` | 8 | Bounds the self record's size |
| `ADDRESS_HINT_FORWARD_MAX_AGE_MS` | 1 h | How long we keep advertising a record for a peer we are not connected to |

The invariant becomes `largest emission of any profile (fixed fields + metadata allowance + hint budget) <= MAX_NEIGHBORS_BYTES`; update the NOTE in `snapshot()` and the `rpc.codec-properties.spec.ts` worst-case encoding case to include a full hint budget.

### Sending (`snapshot()`)

Candidates, in priority order: self (from `SelfAddressRecord`), then successors and predecessors **interleaved in ring order** (nearest first — these are what let third parties reach a NAT'd neighbour), then sample ids. For each non-self candidate, emit `entry.addressRecord` only if the peer is connected now (`isConnected`) **or** `now - confirmedAt < ADDRESS_HINT_FORWARD_MAX_AGE_MS`. Budget accounting counts each hint's full encoded bytes (`JSON.stringify(hint).length + 1` for the separator); a hint that does not fit is skipped and the loop continues. Omit the field when empty.

Freshness has no remote timestamps in it: `confirmedAt` is our clock, and ordering between records is the envelope seq only. A stale record cannot be refreshed by gossip either — re-hearing the same seq is rejected — so a record keeps being forwarded only while some node is connected to its subject or the subject re-seals.

### Receiving

**Parser** (`makeSnapshotParser`): after the id lists and sample are truncated, parse `hints` against the **named set** = `{from} ∪ successors ∪ predecessors ∪ sample ids` (post-truncation). Keep an entry only if it is a plain object, `id` is a string in the named set and not already seen, and `record` is a string of length ≤ `MAX_ADDRESS_RECORD_CHARS` that base64url-decodes. Count capped at the named set's size. Drop bad entries individually (skip-and-log, as the sample does); delete the field when nothing survives. O(size), no crypto, never throws. Tying hints to the named set is what makes the existing merge caps bound the verify work too.

**Ingestion** — one method, `ingestAddressHints(snap)`, called at the end of **both** `mergeAnnounceSnapshot` and `fetchAndMergeSnapshot` (after the id merges, so the named ids have entries). Per hint, sequentially:
1. Skip `id === self`, and skip ids with no store entry (never create one — see edge cases).
2. `peekPeerRecord`: undecodable, or `signer !== id`, or `peerId !== id` → reject (`diag.rejected.addressHint++`, debug log).
3. If the entry holds a record whose peeked seq ≥ the hint's → skip. **No crypto on the common path**: neighbours resend the same records every tick, and this check is what keeps that free.
4. `consumePeerRecord(bytes, { expectedPeer: peerIdFromString(id) })` in try/catch. Throw → reject counter (bad signature). `false` → peerStore already holds an equal-or-newer record (steps 2–3 already ruled out a signer mismatch); not a rejection, nothing to do.
5. `true` → `store.update(id, { addressRecord: { envelope, confirmedAt: Date.now() } })` and `setAddressKnown(id, true)`, so the dialability predicates see the address before the next tick.

**Mirroring libp2p's own records**: identify stores a verified record in the peerStore for every directly-connected peer. Adopt it onto the entry (same seq rule as step 3, `confirmedAt = now`) in the existing `peer:update` listener (it carries `peer.peerRecordEnvelope`) and, for entries holding no record yet, in the `seedFromPeerStore` walk (covers peers identified before `start()`). This is what lets a relay or neighbour forward a peer's record even when that peer runs no FRET self-sealing. Our own `consumePeerRecord` also fires `peer:update`; the seq rule makes that a no-op.

### Protections (from Sereus's review of its own version)

- **A hint never pushes out a peer we contacted ourselves.** FRET keeps no separate address book: a record rides on a routing-table entry, and ingestion never creates, touches or scores one — it only writes `addressRecord` through `store.update`. Entry admission and eviction stay governed by the hearsay rule already pinned in `test/relevance.eviction.spec.ts`. Verified by inspection; no new eviction test, because there is no new capacity for a hint to compete for.
- **Per-sender inbound rate**: the announce path is behind the global announce bucket; the fetch path is self-initiated (≤ 4 per tick). Crypto per message is bounded by the named set (Core ≤ 41 ids) and only runs for records newer than held. Per-sender buckets are parked in `tickets/backlog/20-debt-per-peer-rate-limiting.md` (an arm for this path has been appended there).
- **Clock skew**: nothing time-stamped by a remote is trusted for age; seq only orders.
- **Stale addresses**: 1 h forwarding window above; the 14-day persisted limit belongs to the follow-on ticket.
- **Message size**: per-record cap, per-snapshot budget, 64 KiB frame cap above.

## Edge cases & interactions

- **Payload peerId ≠ signer** (a record signed by C describing B, labelled either B or C): rejected at step 2, never reaches the peerStore. *Test* (`address-hints.ingest.spec.ts`).
- **Tampered signature** (one byte flipped in a genuine record): passes peek, `consumePeerRecord` throws, counter increments, peerStore unchanged. *Test*, same spec — one `it` with three arms: tampered bytes, signer≠payload, genuine C record under hint id B. Assert the peerStore holds no addresses for B/C and `diag.rejected.addressHint` rose by 3.
- **Replayed older record**: step 3 skips; if the entry held nothing but the peerStore holds newer, `consumePeerRecord` returns `false`. Inspection.
- **Bare `/p2p-circuit` placeholder**: excluded from the self record; before a reservation lands a relay-only node has **no** addresses → no self hint (not an empty-address record). Inspection plus the relay test (which asserts the forwarded addresses contain the reserved circuit address).
- **Reservation lands after start**: the next snapshot re-seals with a higher seq; receivers accept it over the earlier one. Covered by the relay test's ordering.
- **Clock went backwards on a peer's restart**: its new seq is lower than records others hold, so its new addresses are refused until its clock passes the old seq — the same limitation libp2p identify has. Leave a `NOTE:` tripwire at the seq computation in `SelfAddressRecord`.
- **Hint for an id not in the store** (evicted between merge and ingestion, or the merge's `noteDiscovered` declined it): skipped, nothing created. Inspection.
- **Hint for self**: skipped — our own addresses come from our address manager, never from gossip. Inspection.
- **`consumePeerRecord` replaces addresses** (e.g. a bootstrap-configured address for that peer): only the subject can sign a newer record, so this is the peer's own statement of its addresses — same behaviour as identify. Accepted; state it in the doc.
- **Concurrent merges ingesting the same id**: both may consume; libp2p's seq check and identical bytes make the second a no-op. No lock needed.
- **Edge node receiving a Core snapshot**: frame cap is shared (64 KiB); the Edge's smaller merge caps shrink the named set, and hints for truncated ids are dropped by the parser. Covered by the codec property tests' generators.
- **Older peer (no `hints`)**: field is optional; existing parse and round-trip properties already cover absence once the generators make `hints` optional. No dedicated test.
- **No `privateKey`**: no self hint, forwarding and ingestion unaffected. Inspection plus one log line.
- **Key/peer mismatch at construction**: throw. Inspection.
- **Discovery emission** (`FretPeerDiscovery`) stays address-less: addresses now reach the peerStore directly through `consumePeerRecord`, so filling `PeerInfo.multiaddrs` would merge the peerStore into itself. Update its comments and the doc bullet that said "changing this needs address hints on the wire".

## Tests (what pays for itself)

- `test/address-hints.relay.spec.ts` — **the reproduction of Optimystic#11**. Extend `test/helpers/relay.ts` with a variant where the relay node also runs FRET and two relay-only nodes A and B (each `listen: ['/p2p-circuit']`, identify on, FRET on with its private key — generate with `@libp2p/crypto`'s `generateKeyPair('Ed25519')` and pass to `createLibp2p({ privateKey })`) each connect only to the relay and obtain reservations. A and B never connect to each other.
  - Negative control first: `A.dial(B.peerId)` rejects with `NoValidAddressesError`.
  - Drive the exchange (a stabilization tick, or a direct fetch of the relay's snapshot) until A's peerStore holds a `/p2p/<relay>/p2p-circuit` address for B; then `A.dial(B.peerId)` succeeds and the resulting connection is limited. And the same in the other direction.
  - Record in the spec header which mutation reddens it (e.g. disabling ingestion), as `rpc.relay-limited-connection.spec.ts` does.
- `test/address-hints.ingest.spec.ts` — the tamper/forgery contract above.
- `test/rpc.codec-properties.spec.ts` — update, don't add: generators produce optional `hints` (legal records for named ids); the worst-case encoding case includes the full Core hint budget against the new 64 KiB cap; never-throws property covers junk `hints`.
- Existing snapshot-merge-cap and neighbour specs must stay green; `MAX_NEIGHBORS_BYTES` is referenced by several — update expectations that hard-code 16 KiB.

## TODO

- Add `@libp2p/peer-record` (match the installed 9.0.5) to `dependencies` and `@libp2p/crypto` (installed version) to `devDependencies`; confirm with `yarn why @libp2p/interface` that no second copy is pulled (see the pin note in `test/helpers/relay.ts`).
- `FretConfig.privateKey`, key/peer check in the core constructor, `Libp2pFretService` component plumbing, one-time "no key" log at `start()`.
- `PeerEntry.addressRecord` in the store (field + doc comment; no serialization yet).
- `src/service/address-records.ts`: `peekPeerRecord`, `selfRecordAddrs`, `SelfAddressRecord` (with the clock-backwards `NOTE:`).
- Constants in `validate.ts`; raise `MAX_NEIGHBORS_BYTES`; hint parsing in `makeSnapshotParser`; `AddressHintV1` + `hints` on `NeighborSnapshotV1` in `src/index.ts` (export the type).
- `snapshot()`: build `hints` under the profile budget; update its size NOTE.
- `ingestAddressHints` wired into both merge paths; `diag.rejected.addressHint` counter.
- Mirror identify-stored records in the `peer:update` listener and the seed walk.
- Update stale comments that say FRET carries no addresses: `hasAddresses`, `announceNeighbors` (neighbors.ts), `mergeAnnounceSnapshot`'s "128 KB" remark, `peer-discovery.ts`.
- Tests above; run the full suite (`cd packages/fret && yarn test`) and `npx tsc --noEmit`.
- `docs/fret.md`: *Dialability* (FRET now propagates signed records; "has addresses" can now come from FRET), *libp2p integration* discovery bullets, *Stream management* frame cap numbers and the emission invariant, *Wire formats* (`NeighborSnapshotV1.hints`, `AddressHintV1`, the parser table row), *Security* current state (hint verification rules, what is and is not rate-bounded).
