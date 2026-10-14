description: Every stabilization pass pings each nearby neighbour and downloads its full neighbour list even when we heard from that neighbour a moment ago and its list has not changed. Skip the ping when recent traffic already proves the neighbour is alive, and skip the download when the neighbour's list is unchanged.
prereq: maintenance-redial-off-the-tick
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/fret-service.ts (stabilizeOnce, nearProbeTargets, probeAndFetch, probeNeighborLatency, fetchAndMergeSnapshot, noteInboundRpc, handlePingRequest, snapshot), packages/fret/src/rpc/ping.ts (PingResponseV1, pingReply), packages/fret/src/rpc/validate.ts (parsePingResponse), packages/fret/src/rpc/neighbors.ts, packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, docs/fret.md
----
Reported as gotchoices/Fret#2 (p2p-fret 1.0.2, via sereus on two Android phones sharing one strand through a public circuit relay). This ticket covers the reporter's suggestion 2, plus a documented behavior the code does not implement. The idle-backoff (`stabilize-idle-backoff`) and peerStore re-seed (`peerstore-reseed-on-change`) tickets cover the rest of the issue.

## Problem

`stabilizeOnce` phase 1 contacts up to 4 live members from the successor/predecessor window around self (`nearProbeTargets`). For each one, `probeAndFetch` sends a `ping` and then, if the ping was answered, fetches a full `neighbors` snapshot. Each of those opens a new stream. Nothing in that path asks whether we already know the answer:

- **Recent traffic is not used as proof of liveness.** `docs/fret.md` (*Stabilization and churn handling*, first bullet) says: "Verify reachability of entries in S(p) and P(p) … If incoming message exchange received since last stabilization, skip verification." The code has no such skip, and no per-peer "last heard from" time is tracked at all (grep for one finds nothing). On a two-member ring both peers run this pass, so each one pings the other every pass, and each inbound ping is itself proof of life that the receiver then ignores.
- **The snapshot is re-fetched even when it cannot have changed.** On a stable ring, consecutive snapshots from the same neighbour differ only in `timestamp` and possibly `size_estimate`/`confidence`. The id lists, sample, metadata and address hints are byte-identical. The fetch still costs a stream, a JSON encode on the sender and a parse, vet and merge on the receiver.

Measured by the reporter, both phones idle, inbound streams per minute on one strand node: ping 21–24 and neighbors 18–24 (one pass every ~2.5–3 s, because the slower phone stretches the 1.5 s timer). On the Galaxy S7 the idle CPU profile was 22% receive (noise decrypt, yamux), 15% send and 19% young-generation GC, with the JS loop blocked 15–19% of the time. FRET is the largest single source of that traffic, and a phone in three strands runs four of these loops.

## Expected behavior

**Liveness from recent traffic.** A near target that has proven itself alive recently enough is not pinged on this pass. "Proven alive" counts only evidence that already counts as proof of life elsewhere in the design: an inbound namespaced RPC from that peer (the transport-authenticated sender that `noteInboundRpc` already receives) or a completed outbound RPC to it. Hearsay (being named in a snapshot) does not count. The freshness window is about one passive interval. Plan stage chooses the exact bound and whether it should scale with the loop's current delay once `stabilize-idle-backoff` lands. Skipping a probe records nothing: no strike, no decay, no `pingsSent`.

**Conditional snapshot fetch.** The ping reply carries a compact summary of what the responder's snapshot would currently contain, as a new optional field on `PingResponseV1`. Following the `hints` precedent there is no version bump, an older reader ignores the field, and its absence means "unknown, fetch as before". The pinger remembers, per neighbour, the summary of the last snapshot it fetched and merged, and skips the fetch when they match. When the probe itself is skipped for recent traffic, the fetch decision still needs a basis, so plan stage must choose one of:
- carry the summary on every inbound RPC reply we already receive from that peer;
- piggyback it on the reverse-direction ping (the responder is pinging us anyway);
- or fetch on a slower independent cadence.

**What the summary covers.** Everything the receiver acts on in a merge: the successor and predecessor id lists, the sample, the sender's metadata, and the address hints. It must not cover `timestamp`, which changes on every build. `size_estimate`/`confidence` also drift slightly on every pass and must not force a fetch: they already ride on the ping reply, and `calibrateSizeFromSnapshot` can be fed from there. The summary is a local cache key and carries no authority: a mismatch means "fetch", never "trust". A collision-resistant hash is not required for correctness against an honest peer. A dishonest peer can always lie about its snapshot, so this adds no new attack.

## Edge cases & interactions

- **Strike accounting (escalation and hard failure).** The near pass is what marks an unreachable member dead (`deadAfterFailures` 3, spaced ≥ 500 ms). A skipped probe must never count as a success that clears a contact-failure run. Only real evidence clears it, and that path already exists (`noteInboundRpc` is proof of life). Verify by inspection plus one test: a peer that stops answering is still marked dead in the same number of passes once its traffic stops.
- **Members we cannot contact.** `strikeUncontactable` books one failed contact per pass against window members that are not dialable. This ticket must not change that path: recent traffic from a peer means it was contactable. Verify by inspection.
- **Busy replies.** A `busy` ping reply is an answer (membership evidence) but records backoff. A summary carried on a busy reply, if any, must not suppress a fetch the receiver would otherwise skip-gate wrongly. Simplest rule: busy replies carry no summary.
- **First contact, restart and eviction.** Nothing is cached for a peer we have never fetched from, for a fresh run (state cleared by `stop()` like the other run-scoped maps), or for a peer evicted from the routing table. All three fetch. The cache must be bounded by routing-table membership, like `ProbeBackoff`'s prune.
- **Version skew.** A peer that sends no summary is fetched every pass exactly as today. Pin with the existing codec property tests in `test/rpc.codec-properties.spec.ts`, extending the generators.
- **Wire caps.** Adding a field to the ping reply must keep it far below any cap. State the encoded size.
- **Interaction with announces.** An inbound announce delivers a full snapshot unasked. It should refresh the cached summary for its sender, so the next pass does not fetch the same content again.
- **Address-hint freshness.** A neighbour's own record re-seals when its addresses change (e.g. a relay reservation lands). That changes the hints, so it must change the summary, or the reservation never propagates. Pin with one test: a re-sealed self record changes the summary.
- **Diagnostics.** Count skipped probes and skipped fetches separately, so the saving is measurable on the reporter's phones. `snapshotsFetched` stays "fetched", not "considered".

## Measuring success

The reporter offered to re-measure a patched build on the same two phones. Target: on an idle, stable two-member strand, inbound `neighbors` streams per minute drop to near zero, and inbound `ping` streams roughly halve (each side's pings serve as the other side's liveness evidence).
