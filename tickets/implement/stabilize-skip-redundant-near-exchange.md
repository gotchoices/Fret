description: Every stabilization pass pings each nearby neighbour and downloads its full neighbour list even when we heard from that neighbour a moment ago and its list has not changed. Skip the ping when recent traffic already proves the neighbour is alive, and skip the download when a short fingerprint of the neighbour's list says it is unchanged.
prereq: maintenance-redial-off-the-tick
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/near-exchange.ts (new), packages/fret/src/service/fret-service.ts (stabilizeOnce, probeAndFetch, probeNeighborLatency, fetchAndMergeSnapshot, noteProofOfLife and its callers, noteInboundRpc, mergeAnnounceSnapshot, handlePingRequest, snapshot, calibrateSizeFromSnapshot, sweepBoundedMaps, stop, diag), packages/fret/src/rpc/ping.ts (PingResponseV1, SizeEstimateProvider, pingReply, sendPing), packages/fret/src/rpc/validate.ts (parsePingResponse, makeSnapshotParser), packages/fret/src/index.ts (NeighborSnapshotV1), packages/fret/test/helpers/maintenance-rig.ts, packages/fret/test/near-exchange.spec.ts (new), packages/fret/test/rpc.codec-properties.spec.ts, docs/fret.md, AGENTS.md
difficulty: hard
----
Reported as gotchoices/Fret#2 (p2p-fret 1.0.2, via sereus on two Android phones sharing one strand through a public circuit relay). This ticket is the reporter's suggestion 2, plus the design document's "if incoming message exchange received since last stabilization, skip verification", which the code never implemented. `stabilize-idle-backoff` (next in line, prereqs this ticket) makes passes rarer; this one makes each pass cheaper.

## Problem

`stabilizeOnce` phase 1 contacts up to 4 live members of the successor/predecessor window around self (`nearProbeTargets`). For each one, `probeAndFetch` sends a `ping` and, if it answered, fetches a full `neighbors` snapshot — two new streams per neighbour per pass. Nothing asks whether we already know the answer:

- No per-peer "last heard from" is tracked, so a neighbour that pinged *us* half a second ago is pinged back anyway. On a two-member ring both sides do this every pass.
- On a stable ring consecutive snapshots from one neighbour differ only in `timestamp`, `size_estimate`/`confidence` and sample `relevance` values — none of which the receiver acts on — yet each pass pays a stream, a JSON encode on the sender, and a parse, vet and merge on the receiver.

Measured by the reporter, both phones idle, inbound streams per minute on one strand node: ping 21–24, neighbors 18–24. Galaxy S7 idle profile: 22% receive (noise decrypt, yamux), 15% send, 19% young-generation GC, JS loop blocked 15–19%.

## Design

### Pass sequence, not wall clock

The service keeps a monotonic **pass sequence number**, incremented at the very top of `stabilizeOnce` (so hand-driven passes in tests count exactly like loop passes). Every "since the previous pass" comparison below is on this number, never on `Date.now()`: hand-driven test passes land inside one millisecond (15 ms on Windows), where a time comparison cannot tell pass k from pass k+1, and under `stabilize-idle-backoff` the window must scale with the loop's delay anyway — a pass count does that for free. Evidence arriving between pass k's start and pass k+1's start is stamped `k`.

### Per-neighbour state — `src/service/near-exchange.ts`

A small class (suggested name `NearExchange`) owned by `FretService`, holding per peer id: `heardSeq` (pass in which the last proof of life arrived), `digest` (the snapshot fingerprint of content we actually merged), `digestSeq` (pass in which that digest was last confirmed). Methods along the lines of `beginPass()`, `noteHeard(id)`, `confirmDigest(id, digest)`, `digestOf(id)`, `canSkipProbe(id)`, `prune(keep)`, `clear()`.

- **Bounded by routing-table membership**: `sweepBoundedMaps` calls `prune(id => store.getById(id) !== undefined)` beside `ProbeBackoff`'s prune. A plain `Map`, not a store field: the heard stamp is written on every inbound RPC, and a `store.update` per inbound RPC is a B+tree replace on the hot path this ticket is trying to cool.
- **Run-scoped**: `stop()` calls `clear()` beside `backoff.clearAll()`. The pass counter need not reset; a cleared map means the first pass of a run probes and fetches everyone.

### Liveness from recent traffic (the probe skip)

"Heard" is stamped at exactly the sites that already prove liveness by RPC — every caller of `noteProofOfLife` **except** `peer:connect`:
- `applySuccess` (a completed outbound RPC with a usable reply — near pings, phase-2 pings, maybeAct forwards);
- `noteAnsweredOnProtocol` (`ok: false`, `busy`, `decode-error` answers — all already proof of life);
- `noteInboundRpc` (inbound ping, neighbors request, maybeAct);
- **new:** `mergeAnnounceSnapshot` for its `from`. Today it applies the `rpc-inbound` membership signal but never `noteProofOfLife`, although `docs/fret.md` (*Evidence strength*, *Recovery*) counts an inbound announce as an inbound RPC. Route it through the same seam as `noteInboundRpc` so the heard stamp and proof of life cannot disagree. Small behaviour change: an announce now clears a contact-failure run and restores a `dead` sender — state it in the docs' *Recovery* bullet.

Make this one seam (e.g. split `noteProofOfLife` into the bare form `peer:connect` keeps and an RPC-evidence form that also stamps), so a future proof-of-life site cannot stamp one and not the other. A connection forming is not counted: the ticket's rule is "evidence that the peer *answered*", and `peer:connect` already has its own handling.

A near target is **skipped** (no redial, no ping, no fetch) when all hold:
1. it is connected now (a peer with no connection takes the existing redial path, whatever we heard);
2. `heardSeq >= currentSeq - 1` — proof of life arrived during or after the previous pass;
3. a cached digest exists and `currentSeq - digestSeq <= NEAR_PROBE_MAX_SKIPS` (**3**).

Rule 3 exists because a skipped probe yields no fingerprint, and the reverse-direction ping cannot carry ours (see *Rejected alternatives*). Without it, a neighbour that pings us every pass (old version, active mode) would suppress our probes forever and we would never see its list change. With it, every neighbour's content is re-checked at least every fourth pass — 6 s at the passive base interval.

A skipped probe records **nothing**: no `applySuccess`, no strike, no decay, no backoff, no `pingsSent`, no calibration. It increments `diag.nearExchangeSkipped.probes`. The skip decision sits in `probeAndFetch` before the redial check (or partitions `near` in `stabilizeOnce` before pooling — implementer's choice), **after** the 4-target slice in `nearProbeTargets`: skipped slots are not refilled with the window's outer members, because the point is fewer RPCs, and the "truncate the outermost, never the immediate successor" ordering stays as it is.

Our own near ping counts as evidence for the *next* pass. So a neighbour that never sends us anything is still probed every other pass at most, and in the symmetric two-node case the two sides' pings interleave so each side's pings serve as the other side's evidence.

### Conditional snapshot fetch (the fetch skip)

**The fingerprint.** `snapshotDigest(content)` in `near-exchange.ts`: SHA-256 (the `multiformats` `sha256` already used by `src/ring/hash.ts`; `await` it, it is async in browsers) over a canonical JSON string of exactly what a receiver acts on, truncated to the first 16 bytes and base64url-encoded — 22 characters. Canonical input, in this order:
- `successors` and `predecessors` as emitted (ring order, stable on a stable ring);
- the sample's **ids only, sorted** — sample `coord` is never read by the receiver (re-hashed from the id), `relevance` drifts every pass, and the selection order follows sparsity scores that wobble;
- the emitted `metadata` (post over-cap drop) or `null`;
- `hints` as `[id, record]` pairs sorted by id.

Not covered: `timestamp`, `size_estimate`, `confidence`, `sig`, `v`, `from` (the cache is keyed by peer). It carries no authority: equality means "skip", anything else means "fetch". Collision resistance is not needed for correctness against an honest peer, and a dishonest peer can already send any snapshot it likes.

**Where it travels — two optional wire fields, no version bump** (the `hints` precedent; an older reader ignores them, absence means "unknown, fetch as before"):
- `NeighborSnapshotV1.digest?: string` — set by `snapshot()` on every build, so announces and fetch replies both carry it. +34 bytes per snapshot.
- `PingResponseV1.snapshot_digest?: string` — set by the ping handler. `handlePingRequest` becomes async: after the bucket, it builds `this.snapshot()` and answers `{ size_estimate, confidence, snapshot_digest }` from it. +43 bytes; the worst ping reply is ~140 bytes against `sendPing`'s 1024-byte `maxBytes`. Rename `SizeEstimateProvider` in `src/rpc/ping.ts` to reflect that it now provides the reply's extras (it is not exported from the package root) and widen its return type.
- **Busy replies carry no digest.** That is automatic: `BusyResponseV1` is a different shape and `rpcRequest` classifies busy before `decode` runs.

**Receiver rules.**
- In `probeAndFetch`, after an answered ping: if the reply was `ok` with `ok === true`, carried a `snapshot_digest`, and it equals `digestOf(id)` → `confirmDigest(id, digest)`, increment `diag.nearExchangeSkipped.fetches`, return `[]`. Otherwise fetch exactly as today (`probeNeighborLatency` must return the digest alongside `answered`).
- `fetchAndMergeSnapshot`, `ok` arm, after the merges and `ingestAddressHints`: `if (snap.digest !== undefined) confirmDigest(id, snap.digest)`. Use the snapshot's own digest, not the ping's: it is the fingerprint of the content just merged.
- `mergeAnnounceSnapshot`, after its merges and hint ingestion: same `confirmDigest(from, snap.digest)`, so the next pass does not refetch content the announce just delivered.
- **Invariant: a cached digest is always the fingerprint of content this node actually merged.** That is what makes every race benign — a fetch and an announce for one peer interleaving can cache an older digest, which only costs one extra fetch on the next mismatch; it can never make us skip content we have not seen. A failed or cancelled fetch leaves the cache untouched.
- `snapshotsFetched` keeps meaning "fetched" (`ok` replies only).

**Network size calibration moves to the ping.** Today the fetch path feeds the neighbour's raw estimate into the size observer (`calibrateSizeFromSnapshot`), and the ping reply carries the responder's *blended* `getNetworkSizeEstimate()`, which nothing reads. A skipped fetch would starve calibration, so:
- the ping reply now carries the **raw** local estimate (the snapshot's `size_estimate` / `confidence`), matching the snapshot rule in *Network size estimation* ("advertise raw so blending does not re-amplify");
- `probeNeighborLatency`'s good-reply arm feeds it to the observer (generalise `calibrateSizeFromSnapshot` to take the two numbers and a source id; keep the `snapshot:<peerId>` source label or rename it — one label per neighbour either way);
- `fetchAndMergeSnapshot` **stops** calibrating, so a pass that pings and fetches reports once, not twice (the observer appends per report; it does not dedupe by source). `mergeAnnounceSnapshot` keeps calibrating.
- A skipped probe reports nothing that pass; the rule-3 cap keeps at least one report per neighbour per four passes, well inside the observer's window.

### Rejected alternatives (record in the docs, briefly)

- **Fingerprint on every inbound RPC reply**: touches maybeAct's reply shapes and the shared reply seams for one consumer. Rejected as invasive.
- **Fingerprint on the reverse-direction ping request**: the ping request has no body and the handler reads none. A new handler waiting for a body from an old sender — which never writes one and never half-closes — would hang until the deadline. Rejected on version skew.
- **Fetch on an independent slower timer**: a second schedule to keep in sync with the loop and with idle backoff. The rule-3 cap gives the same bound with no timer.
- **Refilling skipped slots from the outer window**: more coverage at today's cost; the ticket is a traffic reduction. Parked, not filed — note it as a `NOTE:` at the skip site.

## Edge cases & interactions

- **Strike accounting.** The near pass is what marks a silently-unreachable connected member dead (`deadAfterFailures` 3, spaced ≥ 500 ms). Skips only happen on fresh RPC evidence, which went through `noteProofOfLife` itself, so a skip never clears a run that real evidence did not already clear, and records no success. Once a peer's traffic stops, at most one more pass skips (the one after our own last answered ping), then three probing passes strike it dead. **Test** (below).
- **Members we cannot contact.** `strikeUncontactable` runs before phase 1 against undialable window members; rule 1 (connected) means such a member is never skip-eligible. Unchanged — verify by inspection.
- **Disconnected but recently heard.** Rule 1 sends it down the redial path. Verify by inspection.
- **Busy / `ok: false` / `decode-error` pings.** Proof of life, so they stamp `heardSeq` and may let the next pass skip if a digest is still fresh. They carry no usable digest, so this pass fetches exactly as today. Verify by inspection.
- **First contact, restart, eviction, import.** Nothing cached → fetch. `stop()` clears; the prune drops evicted peers; `importTable` replacing an entry does not touch the map, which is harmless (the digest still names content we merged). Verify by inspection.
- **Eviction sticks harder.** Today a peer we evicted comes back on the next fetch of any neighbour that names it (*Relevance scoring*, "Eviction sticks"). With the fetch skip it comes back only when that neighbour's content changes. That stops an evict/re-add churn of low-relevance sample peers every pass and is accepted; restate the bullet. A neighbour's own successors/predecessors are near us and mostly inside our protected window anyway.
- **Version skew.** A peer sending no `snapshot_digest`/`digest` is never skip-eligible (no cached digest, rule 3) and is fetched every pass exactly as today. Every existing maintenance-rig spec exercises this path unchanged, since the rig's replies carry no digest. Pin the parser half with the codec property tests.
- **Wire caps.** Snapshot +34 bytes against ~4.7 KiB of headroom under `MAX_NEIGHBORS_BYTES`; update the measured numbers in `docs/fret.md` (*Stream management*: 11,575 fixed / 60,738 worst) and the `snapshot()` NOTE from the codec test's recomputed values, not by hand-adding. Ping reply ~140 bytes worst against 1024.
- **Parsers.** `parsePingResponse` projects `snapshot_digest` when it is a string of 1–64 characters, drops it otherwise; `makeSnapshotParser` likewise for `digest`. Never reject the message over it. The 64 leaves room for a longer digest later.
- **Address-hint freshness.** A re-sealed self record (a relay reservation landing) changes the self hint's bytes, so it changes the digest, so the neighbour refetches and the reservation propagates. Covered by construction (hints are in the canonical input) and pinned by the digest coverage test.
- **Responder cost.** Each inbound ping now builds a snapshot (size estimate, two neighbour walks, the diverse sample, hints, one SHA-256) instead of just the size estimate. That is less than today's ping-then-neighbors pair, but a peer pinging us for other reasons (classification, warm-up) also pays it. Metered by the existing ping bucket. Leave a `NOTE:` tripwire at `handlePingRequest`: if ping handling shows in profiles, memoize the digest for a short TTL. Also extend the over-cap-metadata NOTE in `snapshot()`: it now logs per inbound ping as well.
- **Sample stability.** The sample's id *set* is chosen by sparsity score; if it flaps on a stable large ring the digest changes and fetches are not skipped — correct, just a smaller saving. `NOTE:` tripwire at the digest's sample line: if `nearExchangeSkipped.fetches` stays near zero on a quiet large ring, exclude or quantize the sample.
- **Concurrency.** Pooled tasks handle distinct near ids; an announce can race a fetch for the same id — benign by the cache invariant above. The heard stamp is a synchronous `Map.set`.
- **Diagnostics.** `diag.nearExchangeSkipped = { probes, fetches }`, separate counters, documented in the `diag` JSDoc.
- **Existing real-node specs.** Specs that drive back-to-back ticks against a *live, connected, real* FRET peer (candidates: `failure-recovery`, `dead-state` "through a real outbound call site", `per-tick-hotpath`, `address-less-departure`, `maintenance-redial`, `fret.mesh`, `proactive-announce`) may now see the second tick skip. For each failure, decide whether the assertion is about something this ticket legitimately changes (update it to the new contract) or about per-tick probing for another reason (clear the service's near-exchange state between ticks in that spec's helper, with a comment saying why). Do not loosen an assertion to make it pass.

## Tests (new — keep to these)

In a new `test/near-exchange.spec.ts`:
- **Digest coverage table** (pure, no network): starting from one base content, each of these changes the digest — a successor added, a predecessor removed, a sample id swapped, metadata changed, a hint's record bytes replaced (as a re-seal does), a hint added — and each of these leaves it equal — `timestamp`, `size_estimate`, `confidence`, sample `relevance` values, sample order. One table-driven case.
- **Idle two-node strand (the reproduction).** Two memory nodes, both services constructed and handlers registered (follow how `failure-recovery.spec.ts` drives a remote service), connected, membership set; drive passes alternately A, B, A, B … by calling `stabilizeOnce` directly. After a warm-up of two passes each, over the next 10 passes each: neither side's `snapshotsFetched` moves, both `nearExchangeSkipped` counters move, and each side's `pingsSent` grows by at most 5 (tracing the rules by hand, each side settles into pinging every second or third pass). Then change B's content (`setMetadata`) and assert A's `snapshotsFetched` rises within A's next 4 passes — rule 3 forces a probe at least every fourth pass, and the probe's digest mismatch forces the fetch. (Fetches do not store metadata — `mergeAnnounceSnapshot` does — so assert the fetch, not the metadata.)
- **Strike accounting** on the maintenance rig: extend `Behavior`'s `'answers'` with an optional per-peer digest so the ping reply carries `snapshot_digest` and the neighbors reply carries `digest`. Tick 1: answers → pinged and fetched, digest cached. Tick 2: skipped (no `pingsSent` change, no strike, `nearExchangeSkipped.probes` +1). Switch the peer to `'hangs'`, then three spaced ticks (`unspace` as `failure-recovery.spec.ts` does): one strike each, `dead` after the third. Expected: dead on tick 5, exactly one skipped pass.

In `test/rpc.codec-properties.spec.ts`: extend the ping-reply and snapshot generators with the optional fields (legal: 22-char base64url; illegal: non-string, empty, > 64 chars) — legal round-trips, illegal is dropped and the message still parses — and include `digest` in the worst-case snapshot encoding cases.

No other new tests: the skip predicate's remaining branches (disconnected, busy, version skew) are verified by inspection and by the unchanged rig specs.

## Docs (`docs/fret.md`) and `AGENTS.md`

- *Stabilization and churn handling*: rewrite the first bullet (the skip is now implemented — say how: pass-sequence window, connected, fingerprint confirmed within 3 skips); in *Two phases*, a sub-bullet beside "A near peer whose ping did not answer is not snapshot-fetched" describing both skips, the cache invariant, and the rejected alternatives in two or three lines.
- *Recovery*: inbound announce is proof of life now.
- *Relevance scoring* "Eviction sticks": named in a snapshot → named in a *changed* snapshot (or an announce).
- *Network size estimation*: peer-reported estimates now arrive on near-pass ping replies and announces; ping replies carry the raw estimate.
- *Wire formats*: `digest?` on `NeighborSnapshotV1`; a ping reply shape (the doc names it `PingLite`) with `snapshot_digest?`; parser table rows for `parsePingResponse` and `makeSnapshotParser`; byte numbers in *Stream management*.
- *Aspect-oriented implementation plan* A6 "skip if recent traffic": done.
- `AGENTS.md` project layout: add `near-exchange.ts` to the `service/` line.

## Measuring success

The reporter offered to re-measure a patched build on the same two phones. Target: on an idle, stable two-member strand, inbound `neighbors` streams per minute drop to near zero, and inbound `ping` streams roughly halve. Ask them to report `getDiagnostics().nearExchangeSkipped` alongside.

## TODO

- `src/service/near-exchange.ts`: `snapshotDigest` + the per-peer state class (pass sequence, heard, digest, prune, clear).
- `fret-service.ts`: own a `NearExchange`; `beginPass()` at the top of `stabilizeOnce`; prune in `sweepBoundedMaps`; clear in `stop()`; `diag.nearExchangeSkipped`.
- Split the proof-of-life seam so RPC evidence stamps heard; route `mergeAnnounceSnapshot`'s sender through it.
- `snapshot()` computes and emits `digest`; `handlePingRequest` async, answers raw estimate + `snapshot_digest` from `snapshot()`; add the two NOTEs.
- `ping.ts` / `validate.ts` / `index.ts`: wire types and parsers for the two optional fields.
- `probeNeighborLatency` returns the digest and calibrates size from the ping; `probeAndFetch` applies the probe skip and the fetch skip; `fetchAndMergeSnapshot` confirms the digest and stops calibrating; `mergeAnnounceSnapshot` confirms the digest.
- Rig: optional digest on `'answers'`.
- Tests: `near-exchange.spec.ts` (three cases), codec property extensions; run the full suite and resolve real-node spec fallout per the rule above.
- Docs and `AGENTS.md` as listed.
- `npx tsc --noEmit` and `yarn test` from `packages/fret`.
