import type { Libp2p } from 'libp2p'
import type { Connection, PeerId, Stream } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import * as lp from 'it-length-prefixed'
import { createMemNode, stopAll } from './libp2p.js'
import { FretService } from '../../src/service/fret-service.js'
import { DigitreeStore, type MembershipState, type PeerPatch } from '../../src/store/digitree-store.js'
import { encodeJson } from '../../src/rpc/protocols.js'
import { abortReasonError } from '../../src/utils/deadline.js'
import { hashPeerId } from '../../src/ring/hash.js'
import type { FretConfig, NeighborSnapshotV1 } from '../../src/index.js'

// Shared harness for the maintenance paths that run their outbound RPCs *pooled* at
// `maintenanceConcurrency` — the stabilization tick and the two connection warm-up passes.
//
// Every outbound RPC funnels through `openRpcStream`, which consults `node.getConnections(pid)`
// before dialing. Overriding that on a real memory node to return one stub open connection per
// peer gives per-peer control of every RPC in one place — and is the only way to exercise
// `fetchNeighbors` at all, which is connection-only and otherwise returns an empty snapshot.
// Neither sender *writes* to the stream (they open and read), so a stub stream needs only an async
// iterator yielding one JSON chunk, plus `close`/`abort`. The service is never started: the pass
// under test is driven directly so the loop cannot race the assertions, and `runSignal` is then
// `undefined`, which every pass accepts.
//
// A peer's behavior is not only "answers or does not": the arms of `probeNeighborLatency` and
// `fetchAndMergeSnapshot` that matter most are the ones where the peer answered *badly* — busy,
// `ok: false`, or a well-framed reply whose bytes will not decode. Each of those is still an
// answer on our namespaced protocol, so it confirms membership and clears a contact-failure run
// while scoring differently from a good reply. `Behavior` therefore spans all five cases; see the
// per-value notes on the type.

/**
 * What one peer does when a maintenance pass opens a stream to it.
 *
 * - `'answers'` — ping replies `{ok: true, ts}`; a neighbors fetch replies with an empty
 *   snapshot. The default at both lookup sites, so a spec that sets nothing is unchanged.
 * - `'hangs'` — the stream open settles only when the caller's signal aborts.
 * - `'busy'` — `{busy: true, retry_after_ms: 500}`, on **either** protocol. `rpcRequest`'s
 *   `decodeReply` tests the busy shape on the parsed body before any reply validator runs, so one
 *   busy body serves every sender.
 * - `'not-ok'` — `{ok: false, ts}`. **Ping only** — a neighbors reply has no `ok` field, so
 *   setting this against the neighbors protocol rejects loudly rather than degrading to something
 *   that would pass vacuously.
 * - `'undecodable'` — a *complete* frame whose body is not a JSON object, on either protocol.
 *   Proof of life that classifies `decode-error`.
 *
 * `retry_after_ms` is a fixed 500 with no knob: no caller reads the hint today (`RpcOutcome`'s
 * `busy` variant exposes it; nothing consumes it), so a configurable value would be an untested
 * parameter. Add one when a consumer exists.
 */
export type Behavior = 'answers' | 'hangs' | 'busy' | 'not-ok' | 'undecodable'

interface StreamOpts { signal?: AbortSignal }

/**
 * A stream open that settles only when the caller's signal aborts — libp2p's `AbortOptions`
 * contract for `newStream`, and the only thing that can end a stalled open. A stub that ignored
 * the signal would never settle and the pass under test would hang the run.
 */
export function hangsUntilAbort(opts: StreamOpts, onSettle: () => void): Promise<Stream> {
	return new Promise<Stream>((_resolve, reject) => {
		const signal = opts.signal
		if (signal == null) return
		const fail = (): void => { onSettle(); reject(abortReasonError(signal)) }
		if (signal.aborted) { fail(); return }
		signal.addEventListener('abort', fail, { once: true })
	})
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

/**
 * A stream that yields `bytes` once (after `holdMs`, so overlapping opens stay open together
 * long enough for the in-flight high-water mark to be real) and then reports EOF. `onRelease`
 * fires once, on whichever of `close` / `abort` the sender's `releaseRpcStream` picks.
 */
function stubStream(bytes: Uint8Array, holdMs: number, onRelease: () => void): Stream {
	let released = false
	const release = (): void => { if (!released) { released = true; onRelease() } }
	let sent = false
	const stream = {
		id: 'stub-stream',
		[Symbol.asyncIterator]: () => ({
			next: async (): Promise<IteratorResult<Uint8Array>> => {
				if (sent) return { done: true, value: undefined }
				if (holdMs > 0) await sleep(holdMs)
				sent = true
				return { done: false, value: bytes }
			},
		}),
		close: async () => { release() },
		abort: () => { release() },
	}
	return stream as unknown as Stream
}

/**
 * Per-peer control of every outbound RPC a maintenance pass issues, plus the recordings the
 * assertions read: which protocols each peer saw and in what order, and the outbound in-flight
 * count with its high-water mark.
 */
export class PeerRig {
	readonly behavior = new Map<string, Behavior>()
	/** id → protocols opened against it, in call order. */
	readonly opened = new Map<string, string[]>()
	inFlight = 0
	highWater = 0
	holdMs = 0

	/** `id + '|' + protocol` to behavior; consulted before the per-peer map. */
	readonly protocolBehavior = new Map<string, Behavior>()

	constructor(
		private readonly pingProtocol: string,
		private readonly neighborsProtocol: string,
	) {}

	/** Per-(peer, protocol) behavior — e.g. a peer that answers ping and hangs the neighbors fetch. */
	setProtocolBehavior(id: string, protocol: string, b: Behavior): void {
		this.protocolBehavior.set(`${id}|${protocol}`, b)
	}

	connectionFor(id: string): Connection {
		return {
			status: 'open',
			remoteAddr: { toString: () => '/memory/stub' },
			newStream: (protocols: string[], opts: StreamOpts) => this.open(id, protocols, opts),
		} as unknown as Connection
	}

	private open(id: string, protocols: string[], opts: StreamOpts): Promise<Stream> {
		const protocol = protocols[0]!
		const seen = this.opened.get(id) ?? []
		seen.push(protocol)
		this.opened.set(id, seen)
		this.inFlight++
		this.highWater = Math.max(this.highWater, this.inFlight)
		const settle = (): void => { this.inFlight-- }
		const behavior = this.protocolBehavior.get(`${id}|${protocol}`) ?? this.behavior.get(id) ?? 'answers'
		if (behavior === 'hangs') return hangsUntilAbort(opts, settle)
		return this.reply(id, protocol, behavior).then(
			(bytes) => stubStream(bytes, this.holdMs, settle),
			(err: unknown) => { settle(); throw err },
		)
	}

	/**
	 * The reply body for one (protocol, behavior) pair, framed. `behavior` is threaded down from
	 * {@link open} rather than re-read here, so the per-(peer, protocol) override and the per-peer
	 * default are resolved in exactly one place.
	 */
	private async reply(id: string, protocol: string, behavior: Behavior): Promise<Uint8Array> {
		// Senders read replies with `readFramed`, so the stub must frame its body exactly like
		// `sendFramed` does — raw JSON would have its first byte parsed as a varint length prefix.
		// That holds for the `'undecodable'` body too: only its *content* is invalid, never its
		// framing — a truncated frame would exercise `FrameTruncationError` instead (pinned by
		// `test/rpc.stream-errors.spec.ts`), a different arm of the same `decode-error` class.
		const known = protocol === this.pingProtocol || protocol === this.neighborsProtocol
		if (!known) return Promise.reject(new Error(`unexpected protocol opened during a maintenance pass: ${protocol}`))

		if (behavior === 'busy') return this.framed({ busy: true, retry_after_ms: 500 })
		if (behavior === 'undecodable') {
			// `'nope'` fails at `decodeJson` (not valid JSON at all). Deliberately *not* `'{}'`,
			// which parses fine and then fails the reply *parser* instead — also `decode-error`,
			// but by a different route. Do not "simplify" this into the other path.
			return lp.encode.single(new TextEncoder().encode('nope')).subarray()
		}
		if (behavior === 'not-ok') {
			// Ping-only: a neighbors reply has no `ok` field, so a mis-set behavior must fail the
			// run loudly rather than pass vacuously by degrading into some other reply shape.
			if (protocol !== this.pingProtocol) {
				return Promise.reject(new Error(`the 'not-ok' behavior is ping-only; it was set against ${protocol}`))
			}
			return this.framed({ ok: false, ts: Date.now() })
		}

		if (protocol === this.pingProtocol) return this.framed({ ok: true, ts: Date.now() })
		const snap: NeighborSnapshotV1 = { v: 1, from: id, timestamp: Date.now(), successors: [], predecessors: [], sample: [], sig: '' }
		return this.framed(snap)
	}

	private framed(body: unknown): Uint8Array {
		return lp.encode.single(encodeJson(body)).subarray()
	}

	protocolsSeenBy(id: string): string[] {
		return this.opened.get(id) ?? []
	}
}

export interface MaintenanceRig {
	readonly node: Libp2p
	readonly svc: FretService
	readonly store: DigitreeStore
	readonly rig: PeerRig
	/** `PROTOCOL_PING` of the service under test. */
	ping: () => string
	/** `PROTOCOL_NEIGHBORS` of the service under test. */
	neighbors: () => string
	/** The pool cap every pooled maintenance path shares — Core 6 / Edge 2. */
	concurrency: () => number
	/** Override the tick budget static; restored by {@link teardown}. */
	setTickBudget: (ms: number) => void
	/**
	 * Seed `count` peers with real Ed25519 ids (`sendPing` / `fetchNeighbors` parse the id before
	 * anything else) at their true ring coordinates, dialable, in the given membership.
	 */
	seedPeers: (count: number, membership: MembershipState, patch?: PeerPatch) => Promise<string[]>
	teardown: () => Promise<void>
}

/**
 * `cfg` overrides go straight to the service constructor, for the passes whose behaviour depends
 * on a config knob the rig cannot reach afterwards — capacity enforcement being the case in point
 * (a tick's `enforceCapacity` is only observable below the 2048 default).
 */
export async function buildMaintenanceRig(profile: 'core' | 'edge', cfg?: Partial<FretConfig>): Promise<MaintenanceRig> {
	const node = await createMemNode()
	await node.start()
	const svc = new FretService(node, { profile, networkName: 'net-test', ...cfg })
	const store = svc.getStore()
	const protocols = (svc as any).protocols as { PROTOCOL_PING: string; PROTOCOL_NEIGHBORS: string }
	const rig = new PeerRig(protocols.PROTOCOL_PING, protocols.PROTOCOL_NEIGHBORS)
	const originalGetConnections = node.getConnections.bind(node)
	const originalTickBudget = (FretService as any).STABILIZE_TICK_BUDGET_MS as number
	// Every peer id resolves to one open stub connection — which also makes `isConnected` true
	// for every peer, so all of them are dialable and none is skipped as unreachable.
	;(node as any).getConnections = (pid?: PeerId): Connection[] =>
		pid == null ? [] : [rig.connectionFor(pid.toString())]

	return {
		node, svc, store, rig,
		ping: () => protocols.PROTOCOL_PING,
		neighbors: () => protocols.PROTOCOL_NEIGHBORS,
		concurrency: () => (svc as any).maintenanceConcurrency as number,
		setTickBudget: (ms: number) => { (FretService as any).STABILIZE_TICK_BUDGET_MS = ms },
		seedPeers: async (count, membership, patch = {}) => {
			const ids: string[] = []
			for (let i = 0; i < count; i++) {
				const pid = peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
				const id = pid.toString()
				store.upsert(id, await hashPeerId(pid))
				store.setMembership(id, membership)
				if (Object.keys(patch).length > 0) store.update(id, patch)
				;(svc as any).setAddressKnown(id, true)
				ids.push(id)
			}
			return ids
		},
		teardown: async () => {
			;(FretService as any).STABILIZE_TICK_BUDGET_MS = originalTickBudget
			;(node as any).getConnections = originalGetConnections
			try { await svc.stop() } catch {}
			await stopAll([node])
		},
	}
}
