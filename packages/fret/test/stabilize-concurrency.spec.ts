import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { Connection, PeerId, Stream } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { DigitreeStore, type MembershipState, type PeerPatch } from '../src/store/digitree-store.js'
import { encodeJson } from '../src/rpc/protocols.js'
import { abortReasonError } from '../src/utils/deadline.js'
import { hashPeerId } from '../src/ring/hash.js'
import type { NeighborSnapshotV1 } from '../src/index.js'

// One stabilization tick runs its outbound RPCs *pooled* — at most `maintenanceConcurrency` in
// flight (Core 6 / Edge 2) — under one tick-wide budget (`STABILIZE_TICK_BUDGET_MS`), instead of
// walking every target serially. These tests pin the properties that design rests on:
//
// - a peer that never answers costs the tick its budget, not the other peers their turn;
// - the pool cap binds, and is actually reached (parallel, not merely bounded);
// - the ping → snapshot-fetch dependency survives per peer even though peers overlap;
// - the four candidate lists a tick pools are pairwise disjoint (what makes pooling safe against
//   the lost-increment race on the score/strike counters);
// - a tick cut short by its budget records nothing against anyone (our cancellation is not
//   evidence about the peer);
// - candidate lists rotate under truncation, so a budget-cut tick never re-derives the same head.
//
// Harness: every outbound RPC funnels through `openRpcStream`, which consults
// `node.getConnections(pid)` before dialing. Overriding that on a real memory node to return one
// stub open connection per peer gives per-peer control of both the ping and the fetch in one
// place — and is the only way to exercise `fetchNeighbors` at all, which is connection-only and
// otherwise returns an empty snapshot. Neither sender *writes* to the stream (they open and read),
// so a stub stream needs only an async iterator yielding one JSON chunk, plus `close`/`abort`.
// The service is never started: the tick is driven directly so the loop cannot race the
// assertions, and `runSignal` is then `undefined`, which the tick accepts.

type Behavior = 'answers' | 'hangs'

interface StreamOpts { signal?: AbortSignal }

/**
 * A stream open that settles only when the caller's signal aborts — libp2p's `AbortOptions`
 * contract for `newStream`, and the only thing that can end a stalled open. A stub that ignored
 * the signal would never settle and the tick under test would hang the run.
 */
function hangsUntilAbort(opts: StreamOpts, onSettle: () => void): Promise<Stream> {
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
 * Per-peer control of every outbound RPC the tick issues, plus the recordings the assertions
 * read: which protocols each peer saw and in what order, and the outbound in-flight count with
 * its high-water mark.
 */
class PeerRig {
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
		return Promise.reject(new Error(`unexpected protocol opened during a stabilization tick: ${protocol}`))
	}

	protocolsSeenBy(id: string): string[] {
		return this.opened.get(id) ?? []
	}
}

describe('stabilization tick: pooled RPCs under one tick budget', function () {
	this.timeout(10000)

	let node: Libp2p
	let svc: CoreFretService
	let store: DigitreeStore
	let rig: PeerRig
	let originalGetConnections: Libp2p['getConnections']
	const originalTickBudget = (CoreFretService as any).STABILIZE_TICK_BUDGET_MS as number

	async function build(profile: 'core' | 'edge'): Promise<void> {
		node = await createMemNode()
		await node.start()
		svc = new CoreFretService(node, { profile, networkName: 'net-test' })
		store = svc.getStore()
		const protocols = (svc as any).protocols as { PROTOCOL_PING: string; PROTOCOL_NEIGHBORS: string }
		rig = new PeerRig(protocols.PROTOCOL_PING, protocols.PROTOCOL_NEIGHBORS)
		originalGetConnections = node.getConnections.bind(node)
		// Every peer id resolves to one open stub connection — which also makes `isConnected` true
		// for every peer, so all of them are dialable and none is skipped as unreachable.
		;(node as any).getConnections = (pid?: PeerId): Connection[] =>
			pid == null ? [] : [rig.connectionFor(pid.toString())]
	}

	beforeEach(async () => {
		await build('core')
	})

	async function teardown(): Promise<void> {
		;(CoreFretService as any).STABILIZE_TICK_BUDGET_MS = originalTickBudget
		;(node as any).getConnections = originalGetConnections
		try { await svc.stop() } catch {}
		await stopAll([node])
	}

	afterEach(teardown)

	function setTickBudget(ms: number): void {
		;(CoreFretService as any).STABILIZE_TICK_BUDGET_MS = ms
	}

	function concurrency(): number {
		return (svc as any).maintenanceConcurrency as number
	}

	async function tick(): Promise<number> {
		const t0 = Date.now()
		await (svc as any).stabilizeOnce()
		return Date.now() - t0
	}

	/**
	 * Seed `count` peers with real Ed25519 ids (`sendPing` / `fetchNeighbors` parse the id before
	 * anything else) at their true ring coordinates, dialable, in the given membership.
	 */
	async function seedPeers(count: number, membership: MembershipState, patch: PeerPatch = {}): Promise<string[]> {
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
	}

	function ping(): string { return (svc as any).protocols.PROTOCOL_PING as string }
	function neighbors(): string { return (svc as any).protocols.PROTOCOL_NEIGHBORS as string }

	/** The evidence a tick may record against a peer — snapshotted before, compared after. */
	function evidence(id: string): Record<string, unknown> {
		const e = store.getById(id)!
		return {
			contactFailures: e.contactFailures,
			failureCount: e.failureCount,
			negotiateFailures: e.negotiateFailures,
			membership: e.membership,
			state: e.state,
			backoff: (svc as any).backoffMap.get(id),
		}
	}

	// ----- headline regression -----

	// Four near peers, one of which never answers. Serially the hung one blocked the other three
	// for its full RPC timeout before any of them was pinged, let alone fetched; pooled, the three
	// complete while it hangs and the tick returns on its own budget.
	it('one unresponsive near peer costs the tick its budget, not the other peers their probe and fetch', async () => {
		const budget = 400
		setTickBudget(budget)
		await seedPeers(4, 'member')
		const near: string[] = await (svc as any).nearProbeTargets()
		expect(near, 'all four seeded members are near targets').to.have.length(4)
		// The *first* in ring order hangs — under a serial walk that is the one that blocks the rest.
		const hung = near[0]!
		rig.behavior.set(hung, 'hangs')

		const elapsed = await tick()

		expect(elapsed, `tick returned within its ${budget}ms budget plus slack`).to.be.at.most(budget + 1500)
		expect(elapsed, 'the hung peer really was in the tick and cut by the budget').to.be.at.least(budget / 2)
		for (const id of near.slice(1)) {
			expect(rig.protocolsSeenBy(id), `${id}: pinged then fetched`).to.deep.equal([ping(), neighbors()])
		}
		expect(rig.protocolsSeenBy(hung), 'hung peer: ping opened, fetch skipped after the cut').to.deep.equal([ping()])
		expect(svc.getDiagnostics().pingsOk, 'three pings answered').to.equal(3)
		expect(svc.getDiagnostics().snapshotsFetched, 'three snapshots fetched').to.equal(3)
	})

	// ----- pool cap -----

	// The high-water mark is asserted *equal* to the cap, not merely at-most: at-most also passes
	// for a serial walk, and the whole point is that the tick overlaps its peers. ≥ 8 targets so
	// the cap binds in at least one phase for both profiles.
	async function expectHighWaterAtCap(): Promise<void> {
		rig.holdMs = 30
		await seedPeers(4, 'member')
		// Enough unknowns for the classification budget (Core 8 / Edge 4) to fill the second phase.
		await seedPeers(8, 'unknown')
		const cap = concurrency()

		await tick()

		expect(rig.highWater, `in-flight high-water mark equals the ${cap}-wide pool`).to.equal(cap)
		expect(rig.inFlight, 'every stream released by the end of the tick').to.equal(0)
	}

	it('Core: never more than 6 outbound RPCs in flight, and 6 are reached', async () => {
		expect(concurrency()).to.equal(6)
		await expectHighWaterAtCap()
	})

	it('Edge: never more than 2 outbound RPCs in flight, and 2 are reached', async () => {
		await teardown()
		await build('edge')
		expect(concurrency()).to.equal(2)
		await expectHighWaterAtCap()
	})

	// ----- ping-before-fetch per peer -----

	// `fetchNeighbors` is connection-only and it is the ping that usually opens the connection, so
	// the two must stay ordered per peer even while peers overlap. `holdMs` makes the overlap real.
	it('pings a near peer before fetching its snapshot, for every near peer, while peers overlap', async () => {
		rig.holdMs = 20
		await seedPeers(4, 'member')
		const near: string[] = await (svc as any).nearProbeTargets()

		await tick()

		expect(near).to.have.length(4)
		for (const id of near) {
			expect(rig.protocolsSeenBy(id), `${id}: exactly one ping, then exactly one fetch`).to.deep.equal([ping(), neighbors()])
		}
		expect(svc.getDiagnostics().pingsOk).to.equal(4)
		expect(svc.getDiagnostics().snapshotsFetched).to.equal(4)
	})

	// ----- disjoint candidate lists -----

	// Pooling is safe against the lost-increment race on `applySuccess` / `applyFailure` only
	// because no peer appears in two pooled tasks of one tick. Asserted rather than trusted.
	it('selects pairwise-disjoint near / classify / re-probe targets, with no duplicate across the two re-probe arms', async () => {
		const [member] = await seedPeers(1, 'member')
		const [unknown] = await seedPeers(1, 'unknown')
		const [foreign] = await seedPeers(1, 'foreign')
		const [dead] = await seedPeers(1, 'member', { state: 'dead' })
		// Both foreign *and* dead: belongs to the dead arm alone.
		const [foreignDead] = await seedPeers(1, 'foreign', { state: 'dead' })

		const near: string[] = await (svc as any).nearProbeTargets()
		const classify: string[] = (svc as any).classifyTargets()
		const reprobe: string[] = (svc as any).reprobeExcludedTargets()

		expect(near, 'near = live members only').to.deep.equal([member])
		expect(classify, 'classify = non-dead unknowns only').to.deep.equal([unknown])
		expect(reprobe, 'no duplicates across the arms').to.have.length(new Set(reprobe).size)
		expect(reprobe, 'foreign arm picks the live foreign peer').to.include(foreign!)
		expect(reprobe, 'dead arm picks the dead peer').to.include(dead!)
		expect(reprobe, 'foreign-and-dead peer belongs to the dead arm, once').to.include(foreignDead!)
		expect(reprobe).to.have.length(3)

		const lists = [near, classify, reprobe]
		for (let a = 0; a < lists.length; a++) {
			for (let b = a + 1; b < lists.length; b++) {
				const overlap = lists[a]!.filter((id) => lists[b]!.includes(id))
				expect(overlap, `lists ${a} and ${b} share no peer`).to.deep.equal([])
			}
		}
	})

	// ----- truncation is not evidence -----

	// A budget expiry aborts in-flight RPCs and skips the rest; both must leave every peer exactly
	// as it was — no strike, no relevance decay, no backoff, no `dead`, no `pingsFail`.
	it('records nothing against any peer when the budget cuts the first phase and skips the second', async () => {
		setTickBudget(50)
		const members = await seedPeers(4, 'member')
		const unknowns = await seedPeers(2, 'unknown')
		const [foreign] = await seedPeers(1, 'foreign')
		const [dead] = await seedPeers(1, 'member', { state: 'dead' })
		const all = [...members, ...unknowns, foreign!, dead!]
		for (const id of all) rig.behavior.set(id, 'hangs')
		const before = new Map(all.map((id) => [id, evidence(id)]))
		const diagBefore = { ...svc.getDiagnostics() }

		await tick()

		for (const id of all) expect(evidence(id), `${id}: unchanged`).to.deep.equal(before.get(id))
		expect(svc.getDiagnostics().pingsFail, 'no ping failure counted').to.equal(diagBefore.pingsFail)
		expect(svc.getDiagnostics().pingsSent, 'no ping counted as sent').to.equal(diagBefore.pingsSent)
		// The second phase never started: its pool saw an already-expired signal and skipped every task.
		for (const id of [...unknowns, foreign!, dead!]) {
			expect(rig.protocolsSeenBy(id), `${id}: skipped, never opened`).to.deep.equal([])
		}
		expect(rig.inFlight, 'every hung open settled on the abort').to.equal(0)
	})

	it('records nothing against a peer whose membership probe the budget aborts mid-flight', async () => {
		setTickBudget(150)
		await seedPeers(4, 'member') // answer at once, so the second phase is reached well inside the budget
		const unknowns = await seedPeers(2, 'unknown')
		const [foreign] = await seedPeers(1, 'foreign')
		const [dead] = await seedPeers(1, 'member', { state: 'dead' })
		const offRing = [...unknowns, foreign!, dead!]
		for (const id of offRing) rig.behavior.set(id, 'hangs')
		const before = new Map(offRing.map((id) => [id, evidence(id)]))
		const diagBefore = { ...svc.getDiagnostics() }

		await tick()

		for (const id of offRing) {
			expect(rig.protocolsSeenBy(id), `${id}: probe was in flight when the budget expired`).to.deep.equal([ping()])
			expect(evidence(id), `${id}: unchanged`).to.deep.equal(before.get(id))
		}
		expect(svc.getDiagnostics().pingsFail, 'no ping failure counted').to.equal(diagBefore.pingsFail)
		expect(rig.inFlight, 'every hung open settled on the abort').to.equal(0)
	})

	// ----- rotation -----

	// A truncated tick must not re-derive the same head next tick. Unknowns are ordered by
	// ascending `lastAccess` before the budget slice, and a probed one is bumped (`applySuccess`)
	// or backed off, so it rotates to the back with no extra bookkeeping.
	it('classifyTargets rotates: oldest-touched unknowns first, and the unprobed tail leads the next tick', async () => {
		const ids = await seedPeers(12, 'unknown')
		const base = Date.now() - 60_000
		ids.forEach((id, i) => store.update(id, { lastAccess: base + i * 1000 }))
		const budget = 8 // Core classification budget

		const first: string[] = (svc as any).classifyTargets()
		expect(first, 'the 8 oldest, ascending').to.deep.equal(ids.slice(0, budget))

		// What `applySuccess` does to a probed unknown.
		const now = Date.now()
		for (const id of first) store.update(id, { lastAccess: now })

		const second: string[] = (svc as any).classifyTargets()
		expect(second.slice(0, ids.length - budget), 'the 4 never-probed lead').to.deep.equal(ids.slice(budget))
		expect(second, 'the rest of the budget is filled from the probed ones').to.have.length(budget)
		expect(new Set(second).size).to.equal(budget)
	})
})
