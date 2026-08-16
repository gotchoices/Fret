import type { Libp2p } from 'libp2p'
import type { Connection, PeerId, Stream } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { createMemNode, stopAll } from './libp2p.js'
import { FretService } from '../../src/service/fret-service.js'
import { DigitreeStore, type MembershipState, type PeerPatch } from '../../src/store/digitree-store.js'
import { encodeJson } from '../../src/rpc/protocols.js'
import { abortReasonError } from '../../src/utils/deadline.js'
import { hashPeerId } from '../../src/ring/hash.js'
import type { NeighborSnapshotV1 } from '../../src/index.js'

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

export type Behavior = 'answers' | 'hangs'

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

	constructor(
		private readonly pingProtocol: string,
		private readonly neighborsProtocol: string,
	) {}

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
		if ((this.behavior.get(id) ?? 'answers') === 'hangs') return hangsUntilAbort(opts, settle)
		return this.reply(id, protocol).then(
			(bytes) => stubStream(bytes, this.holdMs, settle),
			(err: unknown) => { settle(); throw err },
		)
	}

	private reply(id: string, protocol: string): Promise<Uint8Array> {
		if (protocol === this.pingProtocol) return encodeJson({ ok: true, ts: Date.now() })
		if (protocol === this.neighborsProtocol) {
			const snap: NeighborSnapshotV1 = { v: 1, from: id, timestamp: Date.now(), successors: [], predecessors: [], sample: [], sig: '' }
			return encodeJson(snap)
		}
		return Promise.reject(new Error(`unexpected protocol opened during a maintenance pass: ${protocol}`))
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

export async function buildMaintenanceRig(profile: 'core' | 'edge'): Promise<MaintenanceRig> {
	const node = await createMemNode()
	await node.start()
	const svc = new FretService(node, { profile, networkName: 'net-test' })
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
