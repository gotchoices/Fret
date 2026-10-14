description: Every stabilization pass pinged each nearby neighbour and downloaded its full neighbour list even when we heard from that neighbour a moment ago and its list had not changed. The ping is now skipped when recent traffic already proves the neighbour is alive, and the download is skipped when a short fingerprint of the neighbour's list says it is unchanged.
prereq: maintenance-redial-off-the-tick
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/near-exchange.ts (new), packages/fret/src/service/fret-service.ts (stabilizeOnce, probeAndFetch, probeNeighborLatency, fetchAndMergeSnapshot, noteRpcEvidence, noteInboundEvidence, noteInboundRpc, mergeAnnounceSnapshot, handlePingRequest, snapshot, calibrateSizeFromPeer, sweepBoundedMaps, stop, diag), packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/validate.ts, packages/fret/src/index.ts, packages/fret/test/near-exchange.spec.ts (new), packages/fret/test/helpers/maintenance-rig.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/failure-recovery.spec.ts, packages/fret/test/dead-state.spec.ts, packages/fret/test/rpc.stream-caps-local-limit-scoring.spec.ts, packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts, packages/fret/test/profile.behavior.spec.ts, docs/fret.md, AGENTS.md
difficulty: hard
----
Reported as gotchoices/Fret#2 (p2p-fret 1.0.2, two Android phones on one strand through a public circuit relay: ~20 inbound pings and ~20 inbound neighbour fetches per minute per node while idle). This is the reporter's suggestion 2 and the design document's long-unimplemented "if incoming message exchange received since last stabilization, skip verification". `stabilize-idle-backoff` (plan stage, prereqs this ticket) makes passes rarer; this one makes each pass cheaper.

## What landed

**New module `src/service/near-exchange.ts`.**
- `NearExchange`: per-peer `heardSeq` (pass in which the last RPC evidence of life arrived), `digest` and `digestSeq` (fingerprint of the content this node last merged from the peer, and the pass it was last confirmed in). `beginPass()`, `noteHeard()`, `confirmDigest()`, `digestOf()`, `canSkipProbe()` (rules 2 and 3: heard during or after the previous pass, digest confirmed within `NEAR_PROBE_MAX_SKIPS` = 3 passes), `prune()`, `clear()`. Pass-sequence numbers throughout, never the clock.
- `snapshotDigest(content)`: SHA-256 over canonical JSON of `[successors, predecessors, sorted sample ids, metadata ?? null, hints as sorted [id, record] pairs]`, first 16 bytes, base64url (22 characters). `SNAPSHOT_DIGEST_CHARS` (22) and `MAX_SNAPSHOT_DIGEST_CHARS` (64, the parsers' acceptance width) exported.

**Wire, no version bump.** `NeighborSnapshotV1.digest?` set by `snapshot()` on every build (announces, served neighbour requests, and now served pings all carry it). `PingResponseV1.snapshot_digest?` set by the ping handler. `parsePingResponse` and `makeSnapshotParser` keep either field only as a non-empty string of at most 64 characters, drop it otherwise, never reject. `SizeEstimateProvider` renamed `PingReplyProvider`, returning `PingReplyExtras` (`size_estimate?`, `confidence?`, `snapshot_digest?`).

**Service.**
- `stabilizeOnce` calls `beginPass()` first; `sweepBoundedMaps` prunes the map to routing-table membership beside the backoff prune; `stop()` clears it.
- One proof-of-life-by-RPC seam, `noteRpcEvidence` (= `noteProofOfLife` + heard stamp), reached from `applySuccess`, `noteAnsweredOnProtocol`, and `noteInboundEvidence` (= `rpc-inbound` membership signal + `noteRpcEvidence`), which `noteInboundRpc` and `mergeAnnounceSnapshot` both call. `peer:connect` keeps the bare `noteProofOfLife`. **Behaviour change:** an inbound announce is now proof of life (clears a contact-failure run, restores a `dead` sender) — before it applied only the membership signal. Stated in the docs' *Recovery* bullet.
- `probeAndFetch`: skip the whole probe (no redial, ping or fetch; nothing recorded; `diag.nearExchangeSkipped.probes++`) when `isConnected(id) && nearExchange.canSkipProbe(id)`. After an answered ping, skip the fetch when the good pong's `snapshot_digest` equals `digestOf(id)` (`confirmDigest`, `diag.nearExchangeSkipped.fetches++`). Skipped slots are not refilled (a `NOTE:` at the site).
- `probeNeighborLatency` now returns `{ answered, digest? }` and feeds the good pong's raw `size_estimate` / `confidence` to the observer through `calibrateSizeFromPeer` (source label `peer:<id>`, formerly `snapshot:<id>`). `fetchAndMergeSnapshot` no longer calibrates and confirms the fetched snapshot's own digest after its merges and hint ingestion. `mergeAnnounceSnapshot` still calibrates and confirms the announce's digest last.
- `handlePingRequest` is async: after the bucket it builds `this.snapshot()` and answers the snapshot's raw `size_estimate` / `confidence` plus `snapshot_digest`. The blended `getNetworkSizeEstimate()` it used to answer with was read by nobody. A `NOTE:` tripwire there says to memoize if ping handling shows in profiles; the over-cap-metadata `NOTE:` in `snapshot()` now mentions served pings.
- `diag.nearExchangeSkipped = { probes, fetches }`, documented.

**Docs.** `docs/fret.md`: *Stabilization and churn handling* first bullet rewritten; a long near-exchange sub-bullet under *Two phases* (rules, the seam, the cap's reason, the digest, the cache invariant, rejected alternatives, where the consequences are stated); *Recovery* (announce is proof of life); *Eviction sticks* (named in a *changed* snapshot); *Network size estimation* (calibration from pongs and announces, not fetches; pongs carry raw); byte numbers in *Stream management*; wire formats (`digest?`, a new *PingLite reply* block, both parser table rows); A6 marked done. `AGENTS.md` project layout lists `near-exchange.ts`.

**Measured byte numbers** (recomputed from the codec test's worst-build arithmetic with a 64-character digest, not hand-added): Core fixed fields 11,651 (was 11,575), arithmetic bound 60,814 (was 60,738), headroom ~4.6 KiB; Edge fixed fields 6,377 (was 6,301). Note the old "60,738" was the arithmetic bound (fixed + whole hint budget + framing), not a concrete packed build; the concrete Core build with the digest measures 60,490. Updated in `validate.ts`, `snapshot()`'s NOTE, `profile.behavior.spec.ts`, the codec spec comment and the docs.

## Tests

New `test/near-exchange.spec.ts` (3 cases):
- **Digest coverage table** (pure) — each of a successor added, a predecessor removed, a sample id swapped, metadata changed, a hint's record replaced, a hint added changes the digest; each of `timestamp`, `size_estimate`, `confidence`, sample `relevance`, sample order leaves it equal; width is 22.
- **Idle two-node strand** — two memory nodes, services constructed with handlers registered (never started), passes driven alternately by calling `stabilizeOnce`. After two warm-up passes each, over ten more passes each: no `snapshotsFetched` movement on either side, both `nearExchangeSkipped` counters move on both sides, each side's `pingsSent` grows by at most 5 (hand trace: 4 and 3 — each side settles into every third pass). Then `setMetadata` on B and A refetches within four passes. Runs in ~50 ms.
- **Strike accounting** on the maintenance rig (new `PeerRig.digest` map: an `'answers'` peer with a digest carries it on both replies) — tick 1 pinged and fetched; tick 2 skipped outright (no `pingsSent` change, no strike, no decay, `probes` = 1); peer switched to `'hangs'`; three spaced ticks strike 1, 2, 3 and `dead` on tick 5; `probes` still exactly 1. ~8 s because each hanging tick costs the real 2 s `MAINTENANCE_RPC_TIMEOUT_MS` (the `timeout` outcome is the strike path; a rig-shrunk timeout would pin a different arm).

`test/rpc.codec-properties.spec.ts`: legal snapshot and ping-reply generators carry an optional 22-character base64url digest (round-trip property extended to it); the illegal snapshot generator carries a junk `digest`; two normalization cases pin keep-at-cap / drop-illegal (non-string, empty, 65 chars) / never-reject for both parsers; both worst-case snapshot encodings include a 64-character `digest`.

Existing specs touched, each for a stated reason:
- `failure-recovery.spec.ts` ("demotes to foreign…"): the tick helper clears `nearExchange` between ticks, with a comment — the near pass now legitimately skips the tick after the warm-up (connected, heard from, digest fresh), and that spec pins the negotiate-failure escalation, not per-tick probing. No assertion loosened.
- `dead-state.spec.ts`, `rpc.stream-caps-local-limit-scoring.spec.ts`, `rpc.stream-caps-local-limit-arms.spec.ts`: direct callers of the private `probeNeighborLatency` read `.answered` from the new return shape.
- `rpc.codec-properties.spec.ts`, `profile.behavior.spec.ts`: `await` the now-async `handlePingRequest`.
- Every other rig-driven spec is unchanged: the rig's replies carry no digest unless a spec sets one, so rule 3 never holds and nothing skips (the version-skew path).

`npx tsc --noEmit` clean; `yarn test` 1322 passing, 0 failing (two full runs; the second after the last source edit).

## Known gaps and things worth a second look

- **Announce-path behaviour is verified by inspection only.** No test pins that an inbound announce now restores a `dead` sender, nor that `mergeAnnounceSnapshot` confirms the digest so the next pass skips the fetch. Both are two-line changes on a seam that `dead-state.spec.ts` already pins for the other handlers; a reviewer may want a row there.
- **Pre-first-pass evidence counts for pass 1.** Evidence arriving before any pass is stamped 0, and `canSkipProbe` at pass 1 accepts `heardSeq >= 0` — so a connected peer that announced to us before our first pass is skipped on that pass. Harmless by the cache invariant (we merged the announce), but it is a corner the ticket's prose did not spell out.
- **Metadata canonical form is `JSON.stringify` key order.** Stable across builds on one sender (the same object is reused), but a `setMetadata` with the same keys in a different order changes the digest and costs one extra fetch. Not worth a canonical key sort today.
- **Source label rename** `snapshot:<id>` → `peer:<id>` for size observations. Nothing reads labels but the count; `seed-new-peers.spec.ts` passes a literal `'snapshot:test'` through the public `reportNetworkSize`, which is unaffected.
- **The strike-accounting case spends ~6 s on real timeouts.** Deliberate (see above); if suite time matters more, override `MAINTENANCE_RPC_TIMEOUT_MS` the way `fetch-snapshot-failure-arms.spec.ts` overrides the snapshot timeout.
- **Per-ping snapshot build** is the one new responder cost; `tickets/backlog/20-debt-per-peer-rate-limiting.md` already carries an arm for it (added at plan stage), and the `NOTE:` at `handlePingRequest` is the tripwire.
- **Sample flap** on a quiet large ring would defeat the fetch skip (digest changes every pass). Tripwire `NOTE:` at the sample line in `snapshotDigest`: if `nearExchangeSkipped.fetches` stays near zero there, exclude or quantize the sample.

## Measuring success

Ask the reporter to re-measure the same two phones on a patched build and report `getDiagnostics().nearExchangeSkipped` alongside inbound stream counts. Target: inbound `neighbors` streams per minute near zero on an idle stable strand, inbound `ping` streams roughly halved (the hand trace says each side pings every third pass, so better than half).
