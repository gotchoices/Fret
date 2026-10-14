description: Every stabilization pass pinged each nearby neighbour and downloaded its full neighbour list even when we heard from that neighbour a moment ago and its list had not changed. The ping is now skipped when recent traffic already proves the neighbour is alive, and the download is skipped when a short fingerprint of the neighbour's list says it is unchanged.
prereq: maintenance-redial-off-the-tick
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/near-exchange.ts, packages/fret/src/service/fret-service.ts (stabilizeOnce, probeAndFetch, probeNeighborLatency, fetchAndMergeSnapshot, noteRpcEvidence, noteInboundEvidence, mergeAnnounceSnapshot, handlePingRequest, snapshot, calibrateSizeFromPeer, sweepBoundedMaps, stop, diag), packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/validate.ts, packages/fret/src/index.ts, packages/fret/test/near-exchange.spec.ts, packages/fret/test/dead-state.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/test/rpc.codec-properties.spec.ts, docs/fret.md, AGENTS.md
difficulty: hard
----
Reported as gotchoices/Fret#2 (two idle Android phones on one strand pinging and re-downloading each other's unchanged neighbour lists ~20 times a minute each). Implemented in `ticket(implement): stabilize-skip-redundant-near-exchange`; reviewed here.

## What shipped

- **`src/service/near-exchange.ts`** — `NearExchange`, a per-peer memory keyed by stabilization *pass number* (never the clock): the pass in which RPC evidence of life last arrived, and the fingerprint of the snapshot content this node last merged from the peer plus the pass it was last confirmed in. `canSkipProbe` answers rules 2 and 3 (heard during or after the previous pass; digest confirmed within `NEAR_PROBE_MAX_SKIPS` = 3 passes); the caller supplies rule 1 (connected now). `snapshotDigest` is SHA-256 over canonical JSON of the id lists, the sample's sorted ids, metadata and sorted hint pairs, 16 bytes base64url (22 characters).
- **Wire, no version bump.** `NeighborSnapshotV1.digest?` on every snapshot build; `PingResponseV1.snapshot_digest?` on every good pong. Both parsers keep the field only as a non-empty string of at most `MAX_SNAPSHOT_DIGEST_CHARS` (64) characters and drop it otherwise, never rejecting. An older peer sends neither and is fetched every pass as before.
- **Service.** `stabilizeOnce` opens a pass first. `probeAndFetch` skips the whole probe (nothing recorded, `diag.nearExchangeSkipped.probes++`) when connected and `canSkipProbe`, and skips the fetch (`fetches++`) when the pong's digest equals the cached one. One seam, `noteRpcEvidence`, stamps "heard" beside `noteProofOfLife` from every RPC proof-of-life site; `peer:connect` keeps the bare proof of life. An inbound **announce** is now proof of life (it used to apply only the membership signal). Size calibration moved from the fetched snapshot to the pong and the announce, so a skipped fetch cannot starve it and a pass never reports one neighbour twice. The ping handler builds a snapshot to answer with the raw estimate and the digest.
- **Docs.** `docs/fret.md` *Stabilization and churn handling* (first bullet, a near-exchange sub-bullet under *Two phases*, *Soft failure*, *Recovery*), *Eviction sticks*, *Network size estimation*, *Stream management* byte numbers, the wire formats and parser table, A6 marked done. `AGENTS.md` lists the new module.

## Review findings

**Read first:** the implement commit's full diff, with fresh eyes, before the handoff summary. Then every file the change touched and the ones it should have, plus the docs sections it names.

**Checked, and sound:**
- *The cache invariant under list truncation.* An Edge receiver truncates a Core sender's 12/12/8 lists to 8/8/6 before merging, so it merges *less* than the sender's digest describes. Still correct: equality means the sender's content is unchanged, so a refetch would yield the same truncation. A dishonest sender gains nothing it could not already do by sending any snapshot it likes.
- *Pass counter cannot double-bump.* `stabilizeOnce` has one caller (the loop) besides tests, and the loop awaits each tick.
- *The announce behaviour change is real, not a duplicate.* `registerNeighbors` fires `onInbound` only from the neighbors *request* handler (read `src/rpc/neighbors.ts`), so the merge's `noteInboundEvidence` is the announce path's only proof of life. Confirmed by reading, then pinned (below).
- *Moving calibration off the fetch loses nothing.* `fetchAndMergeSnapshot` has exactly one caller, `probeAndFetch`, which always pings first.
- *Boundedness.* `noteHeard` writes only for an id the store holds, and `sweepBoundedMaps` prunes the map to store membership each pass; `stop()` clears it. Map iteration with deletion in `prune` is safe in JS.
- *Pre-first-pass evidence* (an announce merged before pass 1 lets pass 1 skip that connected peer): harmless by the invariant — the content was merged — and the implementer stated it. No change.
- *Error paths.* A failed or cancelled fetch leaves the cache untouched (confirm is last); an `ok: false` pong carries no trusted digest and fetches; a snapshot build that throws inside the ping handler degrades to a plain pong by the existing provider `try`.
- Build: `npx tsc --noEmit` clean. Tests: `yarn test` 1323 passing, 0 failing (one added), run after the test and source edits below; the final tripwire comment was type-checked afterwards. No pre-existing failures surfaced.

**Minor, fixed in this pass:**
- *Layering.* `rpc/validate.ts` imported `MAX_SNAPSHOT_DIGEST_CHARS` from `service/near-exchange.ts` — the only `rpc → service` import in the tree. The constant is a wire-acceptance width like `MAX_ADDRESS_RECORD_CHARS`, so it now lives beside it in `validate.ts`; `near-exchange.ts` keeps the emitted width (`SNAPSHOT_DIGEST_CHARS`) and points at the parser constant in prose. The codec spec's import follows.
- *DRY.* The per-peer record shape was spelled out twice in `NearExchange`; it is now one `NearPeerMemory` interface.
- *Stale doc.* *Soft failure* still said a live member is "re-verified on *every* tick"; it now states the skip and its bound.
- *Test time.* The strike-accounting case spent ~6 s on three real 2 s ping timeouts. The implementer's reason for not shrinking it ("a rig-shrunk timeout would pin a different arm") does not hold: `rpcRequest` classifies a hang as `timeout` whatever the deadline's length, and only a shrunk *tick* budget would reclassify it `cancelled`. The spec now shrinks `MAINTENANCE_RPC_TIMEOUT_MS` to 100 ms the way `fetch-snapshot-failure-arms.spec.ts` shrinks the snapshot timeout, restored in `afterEach`; the case runs in ~0.4 s instead of ~8 s and still pins strikes 1, 2, 3 and `dead` on the usual schedule.
- *Unverified contract, now pinned.* The implementer flagged that nothing tested the announce path. `test/dead-state.spec.ts` ("liveness seam") gains one row: a `dead` sender's announce clears its contact-failure run, restores it to `disconnected`, and leaves the announce's digest cached for the next pass. One behaviour, one test, at the seam the rest of that block already drives.

**Tests cut:** none. The three new cases each earn their place — the digest coverage table pins a contract with real branching, the two-node strand is the reproduction, and the strike case guards the one way the skip could hide a dead peer.

**Major:** none. No finding needed a ticket: nothing here reaches a type-level or boundary-invariant rung, and the per-peer rate-limiting arm for the per-ping snapshot build already sits on `tickets/backlog/20-debt-per-peer-rate-limiting.md`.

**Tripwires (recorded at the site, indexed here):**
- `handlePingRequest` — each inbound ping builds a whole snapshot; memoize for a short TTL if ping handling shows in profiles (implementer's `NOTE:`, kept).
- `snapshotDigest`, sample line — if the sample id set flaps on a quiet large ring the fetch skip never fires; exclude or quantize the sample if `nearExchangeSkipped.fetches` stays near zero there (implementer's `NOTE:`, kept).
- `snapshotDigest`, canonical form — **added:** metadata hashes in `JSON.stringify` key order, so a `setMetadata` with the same keys reordered costs one extra fetch; sort keys if that ever shows up.
- `probeAndFetch` — a skipped slot is not refilled from the window's outer members (implementer's `NOTE:`, kept).

**Considered and declined:** none encountered; no accepted-tradeoff `NOTE:` sits at any site this review touched.

## Measuring success

Ask the reporter to re-measure the same two phones on a patched build and report `getDiagnostics().nearExchangeSkipped` alongside inbound stream counts. Target: inbound `neighbors` streams per minute near zero on an idle stable strand, inbound `ping` streams better than halved (each side settles into pinging every third pass).
