import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { hashPeerId } from '../src/ring/hash.js'
import type { Libp2p } from 'libp2p'

// A peer that repeatedly cannot be reached is marked `dead`; any proof that it is alive clears
// the run and resurrects it. The distinction these tests pin down is *what counts as a failed
// contact*: only a failure to reach the peer at all. A peer that answers and refuses to negotiate
// this network's protocol, a peer that replies `ok: false`, and an idle disconnect all prove (or
// at least do not disprove) that the remote is alive, so none of them may push it toward dead.
//
// The spacing guard between counted strikes is wall-clock, so every test that needs a *run* of
// strikes rewinds `lastContactFailureAt` between them rather than sleeping.

/** 32-byte ring coordinate distinguished by its most-significant byte. */
function coordAt(value: number): Uint8Array {
	const u = new Uint8Array(32)
	u[0] = value
	return u
}

function unsupportedProtocolError(): Error {
	const e = new Error('Protocol selection failed - could not negotiate /optimystic/net-test/fret/1.0.0/ping')
	e.name = 'UnsupportedProtocolError'
	return e
}

describe('dead state: contact-failure counter on the store', () => {
	// The counter is what turns a single unreachable moment into mere evidence, so — like
	// `negotiateFailures` — it has to survive the network-agnostic re-seeds that run every
	// stabilization tick, or the run could never reach the threshold.
	it('defaults contactFailures to 0 and preserves it across a re-upsert', () => {
		const s = new DigitreeStore()
		const fresh = s.upsert('id1', coordAt(1))
		expect(fresh.contactFailures).to.equal(0)
		expect(fresh.lastContactFailureAt).to.equal(0)

		s.update('id1', { contactFailures: 2, lastContactFailureAt: 12345 })
		s.upsert('id1', coordAt(1)) // simulate a peerStore / peer:connect re-seed
		expect(s.getById('id1')?.contactFailures).to.equal(2)
		expect(s.getById('id1')?.lastContactFailureAt).to.equal(12345)
	})

	// Unreachability describes a live attempt; after a restart (ours or the remote's) it says
	// nothing. `importEntries` already forces `state: 'disconnected'`, so a dead peer must import
	// alive — and with a cleared counter, or its very next failure would immediately re-kill it.
	it('imports a dead peer as disconnected with contactFailures reset to 0', () => {
		const s = new DigitreeStore()
		s.upsert('d', coordAt(1))
		s.update('d', { state: 'dead', contactFailures: 3, lastContactFailureAt: Date.now() })

		const exported = s.exportEntries()
		expect(exported.find((e) => e.id === 'd')?.contactFailures).to.equal(3, 'exported for diagnostics')
		expect(exported.find((e) => e.id === 'd')?.state).to.equal('dead')

		const s2 = new DigitreeStore()
		s2.importEntries(exported)
		expect(s2.getById('d')?.state).to.equal('disconnected')
		expect(s2.getById('d')?.contactFailures).to.equal(0)
		expect(s2.getById('d')?.lastContactFailureAt).to.equal(0)
	})
})

describe('dead state: liveness seam', () => {
	let node: Libp2p
	let svc: CoreFretService
	let store: DigitreeStore
	let selfId: string

	// The service is constructed but deliberately *not* started: these tests drive the seam
	// directly, and a running stabilization loop would probe the synthetic peers seeded below.
	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
		svc = new CoreFretService(node, { profile: 'core', networkName: 'net-test' })
		store = svc.getStore()
		selfId = node.peerId.toString()
	})

	afterEach(async () => {
		try { await svc.stop() } catch {}
		await stopAll([node])
	})

	/** Seed a peer that the seam can act on, and return its id. */
	function seedPeer(id: string, value = 1): string {
		store.upsert(id, coordAt(value))
		store.setMembership(id, 'member')
		return id
	}

	/** Rewind the spacing timestamp so the next strike counts as an independent observation. */
	function unspace(id: string): void {
		store.update(id, { lastContactFailureAt: 0 })
	}

	/** One failed contact, as `noteRpcFailure` routes a dial/stream error. */
	async function strike(id: string): Promise<void> {
		await (svc as any).applyContactFailure(id, coordAt(1))
	}

	it('marks a peer dead after three spread-out contact failures', async () => {
		const id = seedPeer('peer-a')
		await strike(id); unspace(id)
		await strike(id); unspace(id)
		await strike(id)

		expect(store.getById(id)?.contactFailures).to.equal(3)
		expect(store.getById(id)?.state).to.equal('dead')
	})

	it('leaves a peer live after two failures; the third kills it', async () => {
		const id = seedPeer('peer-b')
		await strike(id); unspace(id)
		await strike(id)

		expect(store.getById(id)?.contactFailures).to.equal(2)
		expect(store.getById(id)?.state).to.not.equal('dead')

		unspace(id)
		await strike(id)
		expect(store.getById(id)?.contactFailures).to.equal(3)
		expect(store.getById(id)?.state).to.equal('dead')
	})

	// Concurrent callers failing against one restarting peer in the same instant are a single
	// observation, not a run — otherwise a burst of forwards to one hop would kill it outright.
	it('counts failures inside the spacing window as one observation', async () => {
		const id = seedPeer('peer-c')
		await strike(id)
		await strike(id)
		await strike(id)

		expect(store.getById(id)?.contactFailures).to.equal(1)
		expect(store.getById(id)?.state).to.not.equal('dead')
	})

	// The dial succeeded and the remote answered at the transport layer, so it is demonstrably
	// alive. That error is evidence about which *network* it serves, never about liveness.
	it('routes an unsupported-protocol failure to membership, not to the dead-state run', async () => {
		const id = seedPeer('peer-d')
		for (let i = 0; i < 3; i++) {
			await (svc as any).noteRpcFailure(id, unsupportedProtocolError())
			store.update(id, { lastNegotiateFailureAt: 0 })
			unspace(id)
		}

		expect(store.getById(id)?.contactFailures).to.equal(0, 'no liveness strike')
		expect(store.getById(id)?.state).to.not.equal('dead')
		// The membership machinery still owns the signal and reached its own threshold.
		expect(store.getById(id)?.negotiateFailures).to.equal(3)
		expect(store.getById(id)?.membership).to.equal('foreign')
	})

	// libp2p closes idle connections routinely, and the disconnect handler's only response is
	// relevance decay. Counting those would kill a healthy peer after three ordinary cycles.
	it('does not strike on a bare relevance decay (the peer:disconnect path)', async () => {
		const id = seedPeer('peer-e')
		for (let i = 0; i < 3; i++) {
			await (svc as any).applyFailure(id, coordAt(1))
			unspace(id)
		}

		expect(store.getById(id)?.contactFailures).to.equal(0)
		expect(store.getById(id)?.state).to.not.equal('dead')
		expect(store.getById(id)?.failureCount).to.equal(3, 'relevance decay still applied')
	})

	// A dead self drops out of every ring view with no path back short of a restart.
	it('never marks self dead, however many strikes are applied', async () => {
		store.upsert(selfId, await hashPeerId(node.peerId))
		store.setMembership(selfId, 'member')
		for (let i = 0; i < 6; i++) {
			await strike(selfId)
			unspace(selfId)
		}

		expect(store.getById(selfId)?.contactFailures).to.equal(0)
		expect(store.getById(selfId)?.state).to.not.equal('dead')
	})

	it('resurrects a dead peer on a successful RPC, clearing the run', async () => {
		const id = seedPeer('peer-f')
		await strike(id); unspace(id)
		await strike(id); unspace(id)
		await strike(id)
		expect(store.getById(id)?.state).to.equal('dead')

		await (svc as any).applySuccess(id, coordAt(1), 12)

		expect(store.getById(id)?.contactFailures).to.equal(0)
		// No live connection to a synthetic id, so it comes back as disconnected rather than
		// claiming a connection the transport does not have.
		expect(store.getById(id)?.state).to.equal('disconnected')
	})

	// The peer dialed *us*, which is proof of life however badly our own dials to it fared —
	// this is what re-admits a peer we struggle to reach but that reaches us (e.g. behind NAT).
	it('resurrects a dead peer on an inbound RPC', async () => {
		const id = seedPeer('peer-g')
		store.update(id, { state: 'dead', contactFailures: 3 })

		await (svc as any).noteInboundRpc(id)

		expect(store.getById(id)?.contactFailures).to.equal(0)
		expect(store.getById(id)?.state).to.equal('disconnected')
	})

	// The counter reset is the load-bearing half at the connect site: `setState('connected')`
	// alone would resurrect a peer whose counter is still clamped, so the next failure re-kills it.
	it('clears the run on proof of life even when the peer was not dead', async () => {
		const id = seedPeer('peer-h')
		await strike(id); unspace(id)
		await strike(id)
		expect(store.getById(id)?.contactFailures).to.equal(2)

		;(svc as any).noteProofOfLife(id)
		expect(store.getById(id)?.contactFailures).to.equal(0)
		expect(store.getById(id)?.state).to.equal('disconnected')
	})

	// A live connection is the better answer when one exists — resurrecting to 'disconnected'
	// while connected would misreport the peer to every reader of `state`.
	it('resurrects to connected when a connection exists', async () => {
		const other = await createMemNode()
		await other.start()
		try {
			await node.dial(other.getMultiaddrs()[0]!)
			const id = other.peerId.toString()
			store.upsert(id, await hashPeerId(other.peerId))
			store.update(id, { state: 'dead', contactFailures: 3 })

			;(svc as any).noteProofOfLife(id)

			expect(store.getById(id)?.contactFailures).to.equal(0)
			expect(store.getById(id)?.state).to.equal('connected')
		} finally {
			await stopAll([other])
		}
	})

	it('honours a configured deadAfterFailures threshold', async () => {
		const svc2 = new CoreFretService(node, { profile: 'core', networkName: 'net-test', deadAfterFailures: 2 })
		const store2 = svc2.getStore()
		store2.upsert('peer-i', coordAt(1))

		await (svc2 as any).applyContactFailure('peer-i', coordAt(1))
		expect(store2.getById('peer-i')?.state).to.not.equal('dead')
		store2.update('peer-i', { lastContactFailureAt: 0 })
		await (svc2 as any).applyContactFailure('peer-i', coordAt(1))

		expect(store2.getById('peer-i')?.contactFailures).to.equal(2)
		expect(store2.getById('peer-i')?.state).to.equal('dead')
	})

	// The counter is clamped at the threshold so it stays bounded for a peer we keep re-probing.
	it('clamps the counter at the threshold', async () => {
		const id = seedPeer('peer-j')
		for (let i = 0; i < 6; i++) {
			await strike(id)
			unspace(id)
		}
		expect(store.getById(id)?.contactFailures).to.equal(3)
		expect(store.getById(id)?.state).to.equal('dead')
	})
})
