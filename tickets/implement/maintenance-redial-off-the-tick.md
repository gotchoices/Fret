description: When FRET's background maintenance has to open a new connection to a peer, it allows only 2 seconds, which a relayed connection on a slow link can't meet, so such a peer is never reconnected (two phones that restart on a slow relay may never find each other again). Give connection-opening its own, host-configurable time limit and run it outside the stabilization tick.
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/fret-service.ts (MAINTENANCE_RPC_TIMEOUT_MS ~339; probeAndFetch ~2562; probeNeighborLatency ~2588; nearProbeTargets ~2510; probeMembership ~2808; pingWarmupTargets ~1757; sendAnnouncementsRateLimited ~1673; peer:connect listener ~1173; applyContactFailure ~795; constructor config defaults), packages/fret/src/index.ts (FretConfig), packages/fret/src/utils/deadline.ts, packages/fret/test/helpers/libp2p.ts, packages/fret/test/failure-recovery.spec.ts, packages/fret/test/preconnect-concurrency.spec.ts, packages/fret/test/stabilize-concurrency.spec.ts, docs/fret.md
difficulty: hard
repro: verified
----
Reported from sereus (`p2p-fret` 1.0.2; sereus ticket `fret-maintenance-ping-dial-budget-below-a-relayed-dial`). Sereus measured, after a strand member restarted on a slow relayed link: 32 reconnect dials over 180 s, every one aborted 2.05 s after it started (mostly `EncryptionFailedError: This operation was aborted`, i.e. the Noise handshake over the circuit). The one relayed connection that did open took about 9 s. Sereus budgets a relayed dial at 21.5 s.

## Root cause

Every maintenance ping (`sendPing`, which defaults to `dial: 'always'`) runs with `timeoutMs: MAINTENANCE_RPC_TIMEOUT_MS` (2000 ms). `rpcRequest` builds one deadline for the whole call — opening the connection included — and hands its signal to `openRpcStream` → `node.dialProtocol`. The constant's comment reasons only about the exchange on an open connection ("a ~50-byte round trip").

A libp2p detail makes FRET's 2 s the *only* limit: libp2p's dial queue applies its own whole-dial `dialTimeout` (10 s default) **only when the caller passes no signal** (`node_modules/libp2p/dist/src/connection-manager/dial-queue.js`: `signal: options.signal ?? AbortSignal.timeout(this.dialTimeout)`). FRET always passes one, so the host's libp2p `dialTimeout` never applies; only the per-address `addressDialTimeout` (6 s default; Sereus sets 39 s) still does, and FRET's 2 s cuts under it.

Raising the constant is not enough on its own, and splitting the ping's budget into "dial" and "exchange" halves inside `rpcRequest` is not enough either: the near-peer probe and the classification / re-probe probes run inside the stabilization tick (`STABILIZE_TICK_BUDGET_MS` 5 s, phase 1 sub-budget 3 s), and the tick's signal aborts any dial still running when it expires. A 9–21 s relayed dial cannot fit inside any tick. The dial has to run **outside** the tick.

## Reproduction (verified, FRET-local)

A memory-transport node whose connection encrypter delays its outbound handshake models "slow handshake, fast exchange" exactly. (Memory-transport `latency` does not — it slows the dial and the ping equally: at 150 ms per buffer the dial took 1.25 s and a ping on the open connection 1.25 s too.)

```ts
function slowHandshake(ms: number) {
	const base = plaintext()
	return (components: any): ConnectionEncrypter => {
		const inner = base(components)
		const wait = (signal?: AbortSignal) => new Promise<void>((res, rej) => {
			const t = setTimeout(res, ms)
			signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason) }, { once: true })
		})
		return {
			protocol: inner.protocol,
			secureInbound: (c, o) => inner.secureInbound(c, o),
			secureOutbound: async (c, o) => { await wait(o?.signal); return inner.secureOutbound(c, o) },
		} as ConnectionEncrypter
	}
}
// createLibp2p({ transports: [memory()], connectionEncrypters: [slowHandshake(3000)], streamMuxers: [yamux()], ... })
```

Measured with a 3000 ms handshake, A holding B's address in its peerStore and no connection:
- `sendPing(a, b, proto, { timeoutMs: 2000 })` ×3 → `timeout@2014, timeout@2013, timeout@2013`, connections 0 afterwards. (Each aborted dial is discarded; nothing accumulates across attempts.)
- `a.dial(b.peerId, { signal: AbortSignal.timeout(10000) })` → connected in 3040 ms.
- `sendPing` with 2000 ms over that open connection → `ok` in 4 ms.

So the 2 s is right for the exchange and wrong for the dial. In the service this becomes: near pass pings the disconnected member → timeout → contact strike; three spaced strikes → `dead`; the dead arm re-probes it at backoff with the same 2 s → never reconnects. That matches the Sereus log's ~5.6 s between attempts.

## Design (recommended)

Split the budget by **where the dial runs**, not just by its size: maintenance pings use a connection that exists; opening one is a separate, per-peer, deduplicated **redial** that runs under the run signal and a host-supplied dial budget, and outlives the tick that asked for it.

**Config.** `FretConfig.dialTimeoutMs?: number` — the whole-dial budget for a maintenance redial. Default **10 000 ms**, which is libp2p's own `dialTimeout` default, restated because FRET passing a signal switches libp2p's off (see root cause). A host on slow relayed links sets it from its link budget (Sereus: `relayedDialBudgetMs`, 21.5 s). Reject a non-finite or non-positive value in the constructor. `MAINTENANCE_RPC_TIMEOUT_MS` stays 2000 and its comment is corrected to say it bounds the exchange on an open connection only.

**Redial seam.** One private method on `FretService`, e.g. `redial(id: string): Promise<'connected' | 'failed' | 'cancelled'>`:
- Returns the **in-flight promise** when a redial to `id` is already running (a `Map<string, Promise<…>>`), so a later tick, the warm-up pass and the dead arm all share one dial and one verdict.
- Resolves a distinct `'skipped'` (add it to the result union) with no dial and no score when the peer is already connected, has no address, or `maintenanceConcurrency` redials are already in flight. A skipped request is simply re-asked next tick; nothing queues.
- Dials with `node.dial(peerIdFromString(id), { signal })` where the signal is `deadline(dialTimeoutMs, this.runSignal)` (the existing util — it is a child of the parent signal and avoids `AbortSignal.any`, which React Native's Hermes lacks). `cancel()` the deadline in a `finally`.
- **The redial owns its verdict and books it exactly once**: a dial failure that is not our own cancellation (`wasCancelled(runSignal)`) is a failed contact → `applyContactFailure(id)`. Success books nothing here — the `peer:connect` listener already sets `connected`, clears any `dead` label and the contact-failure run (proof of life), and touches the entry. Cancellation books nothing.
- libp2p's dial queue makes sharing safe in the other direction too: a concurrent `dialProtocol` to the same peer (e.g. an announce) *joins* the pending dial, and the joined job is aborted only once every joiner's signal has aborted (`@libp2p/utils` `queue/job.js`), so a 2 s announce timing out does not kill the redial.

**Callers.** Each caller partitions its targets three ways — connected (ping as today, `dial: 'never'` so a ping can never dial again), dialable but not connected (redial), undialable (unchanged: `strikeUncontactable` for the near window, filtered out elsewhere).
- **Near pass** (`probeAndFetch`): for a not-connected target, `await` the redial raced against the phase-1 signal. If it connected within the phase, ping and fetch in the same task as today — so a fast dial still reconnects and verifies within one tick and a fast-failing dial (connection refused) still books its strike within the tick, which keeps `failure-recovery.spec.ts`'s timing. If the phase signal fires first, return with no score; the redial carries on. The near-pass ping keeps its "no backoff on unreachable/timeout" rule.
- **Phase 2** (`probeMembership` — classify, foreign and dead arms): same shape against the tick signal. On a redial `'failed'` also `backoff.record(id)`, matching what `probeMembership` books for a failed ping today (every failure there backs off). Note backoff must be recorded by the *caller's* arm, not by the redial seam, because the near pass records none.
- **Warm-up passes** (`pingWarmupTargets`, start-up and active tick): request a redial for a not-connected target instead of a 2 s dialing ping. Warm-up never scored and still must not — but the redial's failure strike now applies to these peers too; that is correct (a failed dial is a failed contact, whoever asked), state it in the method comment. Whether the pooled task awaits the redial or fire-and-forgets it is the implementer's call; awaiting holds a pool slot for up to `dialTimeoutMs`, so prefer not awaiting and let the pool cover only the pings.

**Disjointness.** The tick's pooled sets stay disjoint (near / classify / foreign / dead), and a redial in flight for a peer is the same promise whoever awaits it, so no peer gets two verdicts. `applyContactStrike` is synchronous; `applyFailure`'s lost-increment race is the one already accepted in the `applySuccess` NOTE.

**Out of scope, record as `NOTE:` tripwires:**
- `sendAnnouncementsRateLimited` dials with `dial: true` under the 2 s budget and is deliberately serial; on a slow link every announce to a non-connected target times out. Announces are opportunistic and score nothing, and a slow dial there must not stall the serial loop, so leave it — NOTE at the call: "an announce to a non-connected peer dials within MAINTENANCE_RPC_TIMEOUT_MS; on links where a dial exceeds that it never lands — if announce delivery to fresh peers matters there, request a redial and announce on the next pass".
- `sendMaybeAct` / `iterativeLookup` dial a non-connected hop inside the 5 s route budget (`RPC_TIMEOUT_MS`). Same class on slow relays, but routing mostly goes through peers the near pass now keeps connected. NOTE at the forward site.

**Rejected alternatives.** Raising `MAINTENANCE_RPC_TIMEOUT_MS` outright: a long ping holds a tick open, and the tick aborts it anyway. A `dialTimeoutMs` option on `rpcRequest` alone: the tick's signal still bounds the call, so it fixes only the warm-up path. Leaving reconnection to the host (Sereus's redial supervisor): works, but duplicates what FRET's maintenance is for, and every other host on relays would have to rebuild it.

## Tests

One new spec (e.g. `test/maintenance-redial.spec.ts`) using the slow-handshake encrypter above — add it to `test/helpers/libp2p.ts` as a node factory taking the handshake delay. Two real FRET nodes, A holding B as a live `member` with B's address in its peerStore and no connection, handshake 3000 ms, A's `dialTimeoutMs` 10 000:
- Reproduction (red today): drive A's stabilization ticks; B is never struck while its redial is pending, a connection forms within the dial budget, B stays a live member, and the next tick's ping to B is `ok`. Today this goes `timeout` ×3 → `dead`.
- Control: same rig with `dialTimeoutMs` below the handshake (e.g. 1000) — the redial fails, exactly one contact strike is booked per failed redial (not one per tick that awaited it).

Existing specs to re-run and adjust where they assumed a dialing ping: `failure-recovery.spec.ts`, `preconnect-concurrency.spec.ts` (its "three unresponsive neighbors cost one timeout" case uses rig stub connections, so it should be unaffected — verify), `stabilize-concurrency.spec.ts`, `dead-state.spec.ts`, `address-less-departure.spec.ts`, `dialability.spec.ts`, `stabilize-budget-invariants.spec.ts` (the invariant arithmetic is unchanged; the redial is outside it — say so in that spec's header if it explains the budgets).

## TODO

- Add `dialTimeoutMs` to `FretConfig` with the 10 000 ms default and constructor validation; document it in the config defaults block.
- Correct the `MAINTENANCE_RPC_TIMEOUT_MS` comment: it bounds the exchange on an open connection; opening one is the redial's budget.
- Implement the `redial` seam (in-flight dedup map, concurrency cap at `maintenanceConcurrency`, `deadline(dialTimeoutMs, runSignal)`, single verdict, strike on non-cancelled failure, nothing on success). Clear the in-flight map on `stop()` alongside the other run-scoped maps.
- Near pass: partition connected / redial / undialable; pings use `dial: 'never'`; race the redial against the phase-1 signal and ping+fetch in the same task when it connects in time.
- Phase 2 (`probeMembership`): same shape against the tick signal; `backoff.record` on a failed redial.
- Warm-up passes: redial not-connected targets instead of a dialing ping; update the method comment (failed redial strikes).
- `NOTE:` tripwires at the announce call and the routing forward site.
- New spec with the slow-handshake helper (reproduction + control); run the full suite and fix specs that assumed a dialing ping.
- docs/fret.md: *Stabilization and churn handling* (near pass and phase 2 redial; a slow dial no longer costs tick budget or strikes while pending), *Stream management* (the `MAINTENANCE_RPC_TIMEOUT_MS` sentence — it no longer covers a dial; add the libp2p signal-disables-`dialTimeout` fact), *Active vs passive state* (warm-up redials), *Configuration* (`dialTimeoutMs`).
- `yarn check` from root.
