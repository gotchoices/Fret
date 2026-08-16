import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService, selectDiverseSample } from '../src/service/fret-service.js'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { assembleCohort } from '../src/service/cohort.js'
import { estimateSizeAndConfidence } from '../src/estimate/size-estimator.js'
import { createSparsityModel } from '../src/store/relevance.js'
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

	// A disconnect is not proof of life, and it is the event that *follows* a run of failed
	// contacts — so if it cleared `dead` the seam would undo nearly every transition it makes,
	// re-admitting the peer to every ring view with its counter still clamped at the threshold.
	it('does not resurrect a dead peer when its connection drops', async () => {
		const id = seedPeer('peer-k')
		store.update(id, { state: 'dead', contactFailures: 3 })

		;(svc as any).noteDisconnected(id)

		expect(store.getById(id)?.state).to.equal('dead')
		expect(store.getById(id)?.contactFailures).to.equal(3, 'counter left clamped')
	})

	it('still records a disconnect for a peer that is not dead', () => {
		const id = seedPeer('peer-l')
		store.setState(id, 'connected')

		;(svc as any).noteDisconnected(id)

		expect(store.getById(id)?.state).to.equal('disconnected')
	})

	// The spacing stamp only means anything inside one run. Carrying it past a recovery makes the
	// first failure of the *next* run land inside the previous run's window and be discarded, so
	// the peer gets a free miss after every recovery.
	it('clears the spacing stamp on proof of life so the next run starts clean', async () => {
		const id = seedPeer('peer-m')
		await strike(id)
		expect(store.getById(id)?.lastContactFailureAt).to.be.greaterThan(0)

		;(svc as any).noteProofOfLife(id)
		expect(store.getById(id)?.lastContactFailureAt).to.equal(0)

		// Immediately after recovery — well inside the spacing window of the strike above — the
		// next failure must still count.
		await strike(id)
		expect(store.getById(id)?.contactFailures).to.equal(1)
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

	// An inbound RPC arriving while an outbound probe is failing is the one interleaving both
	// directions can hit. Both paths patch the entry synchronously (no await between read and
	// write), so whichever lands last wins outright and the label always agrees with the counter
	// behind it — the outcome that must never occur is a half-resurrection, i.e. `dead` with a
	// cleared run (nothing would ever re-probe it out of the ring exclusion on its own schedule)
	// or a live label with the run still clamped (the next failure re-kills it instantly).
	it('never leaves a half-resurrected entry when an inbound RPC races a failing probe', async () => {
		const id = seedPeer('peer-n')
		await strike(id); unspace(id)
		await strike(id); unspace(id)

		await Promise.all([
			(svc as any).applyContactFailure(id, coordAt(1)),
			(svc as any).noteInboundRpc(id),
		])

		const e = store.getById(id)!
		if (e.state === 'dead') expect(e.contactFailures).to.equal(3, 'dead implies a completed run')
		else expect(e.contactFailures).to.be.lessThan(3, 'alive implies an incomplete run')
	})
})

// Phase 4: a dead peer is not merely labelled — it drops out of every ring-shaped read. FRET
// keeps no separate successor/predecessor *set*, so those windows are the filtered ring walk and
// exclusion from the walk predicate IS the "remove from S/P" the design calls for.
describe('dead state: exclusion from ring views', () => {
	let node: Libp2p
	let svc: CoreFretService
	let store: DigitreeStore

	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
		// Not started: a live stabilization loop would probe (and re-probe) the synthetic peers.
		svc = new CoreFretService(node, { profile: 'core', networkName: 'net-test' })
		store = svc.getStore()
	})

	afterEach(async () => {
		try { await svc.stop() } catch {}
		await stopAll([node])
	})

	/** A confirmed same-network peer we still believe is alive. */
	function live(id: string, value: number): string {
		store.upsert(id, coordAt(value))
		store.setMembership(id, 'member')
		return id
	}

	/** A confirmed same-network peer a run of failed contacts has marked dead. */
	function dead(id: string, value: number): string {
		live(id, value)
		store.update(id, { state: 'dead', contactFailures: 3 })
		return id
	}

	/** Make a synthetic id pass `isDialable` so it can reach the routing-candidate walk. */
	function dialable(...ids: string[]): void {
		for (const id of ids) (svc as any).setAddressKnown(id, true)
	}

	it('drops a dead peer from getNeighbors, the cohort, and the routing-candidate walk', () => {
		const key = coordAt(100)
		// The dead peers sit *nearer* the key than the live ones, so any result that included
		// them would prefer them.
		dead('dead-r', 101); dead('dead-l', 99)
		live('live-r', 110); live('live-l', 90)
		dialable('dead-r', 'dead-l', 'live-r', 'live-l')

		const right = svc.getNeighbors(key, 'right', 3)
		expect(right).to.include('live-r')
		expect(right).to.not.include('dead-r')

		const left = svc.getNeighbors(key, 'left', 3)
		expect(left).to.include('live-l')
		expect(left).to.not.include('dead-l')

		const cohort = svc.assembleCohort(key, 4)
		expect(cohort).to.have.members(['live-r', 'live-l'])

		const routing = (svc as any).dialableCohort(key, 4, new Set<string>()) as string[]
		expect(routing).to.have.members(['live-r', 'live-l'])
	})

	// Same starvation property the member gate already relies on: the ring walk skips a filter
	// miss and keeps advancing, so a run of dead peers nearest the key must not shrink the cohort
	// while live members exist further out.
	it('still returns `wants` live members when dead peers cluster nearest the key', () => {
		const key = coordAt(100)
		dead('d1', 98); dead('d2', 99); dead('d3', 101); dead('d4', 102)
		live('mL1', 80); live('mL2', 70); live('mL3', 60); live('mL4', 50)
		live('mR1', 120); live('mR2', 130); live('mR3', 140); live('mR4', 150)

		const cohort = svc.assembleCohort(key, 4)
		expect(cohort).to.have.length(4)
		for (const id of cohort) expect(store.getById(id)?.state).to.not.equal('dead')
	})

	it('excludes dead peers from the outgoing snapshot: neighbors, sample, and size estimate', async () => {
		for (let i = 1; i <= 24; i++) live(`m${i}`, i * 10)
		const deadIds = [dead('d-a', 5), dead('d-b', 7), dead('d-c', 245), dead('d-d', 250)]

		const snap = await (svc as any).snapshot() as {
			successors: string[]; predecessors: string[]
			sample: Array<{ id: string }>; size_estimate: number
		}
		const advertised = [...snap.successors, ...snap.predecessors, ...snap.sample.map((s) => s.id)]
		for (const id of deadIds) expect(advertised).to.not.include(id)
		// Non-vacuous: the sample really did have slots left over after the S/P windows.
		expect(snap.sample.length).to.be.greaterThan(0)

		// The member-scoped size estimate counts live members only, so killing most of the ring
		// widens the sampled gaps and the estimate falls.
		const before = svc.getNetworkSizeEstimate().size_estimate
		for (let i = 1; i <= 12; i++) store.update(`m${i * 2}`, { state: 'dead' })
		const after = svc.getNetworkSizeEstimate().size_estimate
		expect(after).to.be.lessThan(before)
	})

	// `enforceCapacity` protects only the peers the live-member predicate returns around self, so
	// the dead peer loses its protected slot and its decayed relevance puts it at the front of the
	// victim list. No eviction-specific handling is needed — this test is what pins that down.
	it('evicts a dead peer before a live member neighbor at capacity', async () => {
		const small = new CoreFretService(node, { profile: 'core', networkName: 'net-test', capacity: 3 })
		const st = small.getStore()
		const selfId = node.peerId.toString()
		st.upsert(selfId, await hashPeerId(node.peerId))
		st.setMembership(selfId, 'member')

		st.upsert('live-neighbor', coordAt(10)); st.setMembership('live-neighbor', 'member')
		st.update('live-neighbor', { relevance: 0 })
		st.upsert('dead-neighbor', coordAt(20)); st.setMembership('dead-neighbor', 'member')
		st.update('dead-neighbor', { state: 'dead', relevance: 0 })
		// Unclassified, so it is unprotected too — but its relevance is higher, so the dead peer
		// is still the first victim.
		st.upsert('filler', coordAt(30))
		st.update('filler', { relevance: 5 })

		await (small as any).enforceCapacity()

		expect(st.getById('dead-neighbor'), 'dead peer evicted').to.equal(undefined)
		expect(st.getById('live-neighbor'), 'live member neighbor protected').to.not.equal(undefined)
		expect(st.getById(selfId), 'self protected').to.not.equal(undefined)
	})

	it('re-admits a resurrected peer to the ring views', () => {
		const key = coordAt(100)
		dead('back', 101)
		live('other', 110)
		expect(svc.getNeighbors(key, 'right', 3)).to.not.include('back')

		;(svc as any).noteProofOfLife('back')

		expect(svc.getNeighbors(key, 'right', 3)).to.include('back')
		expect(svc.assembleCohort(key, 3)).to.include('back')
	})

	// The exported standalones take the predicate as a parameter and default to no filter, which
	// is what keeps the design simulator byte-for-byte unaffected by ring-view gating.
	it('leaves the unfiltered standalone exports seeing dead entries', () => {
		const bare = new DigitreeStore()
		for (const [id, value] of [['x', 90], ['y', 110]] as Array<[string, number]>) {
			bare.upsert(id, coordAt(value))
			bare.setMembership(id, 'member')
		}
		bare.upsert('gone', coordAt(100))
		bare.setMembership('gone', 'member')
		bare.update('gone', { state: 'dead' })

		expect(assembleCohort(bare, coordAt(100), 3)).to.include('gone')
		expect(bare.neighborsRight(coordAt(99), 3)).to.include('gone')
		expect(estimateSizeAndConfidence(bare, 8).n).to.equal(
			estimateSizeAndConfidence(bare, 8, { filter: () => true }).n
		)
		const sampled = selectDiverseSample(bare, coordAt(0), createSparsityModel(), new Set(), 10)
		expect(sampled.map((s) => s.id)).to.include('gone')
	})
})

// Phase 5: exclusion must not be a one-way door. Once a peer is out of every ring view nothing
// pings it again — `stabilizeOnce` draws its probe targets from `getNeighbors` — so a peer that
// recovers but never dials us would stay dead until evicted at capacity. The dead arm of the
// re-probe pass is the only path back on a ring where nobody else calls.
describe('dead state: recovery through the re-probe pass', () => {
	let node: Libp2p
	let svc: CoreFretService
	let store: DigitreeStore
	const spares: Libp2p[] = []

	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
		// Not started: `stabilizeOnce` is driven explicitly so the ping counts stay deterministic.
		svc = new CoreFretService(node, { profile: 'core', networkName: 'net-test' })
		store = svc.getStore()
	})

	afterEach(async () => {
		try { await svc.stop() } catch {}
		await stopAll([node, ...spares.splice(0)])
	})

	it('re-probes a dead peer on a stabilization tick and restores it to live + member', async () => {
		const other = await createMemNode()
		spares.push(other)
		await other.start()
		const otherSvc = new CoreFretService(other, { profile: 'core', networkName: 'net-test' })
		try {
			await otherSvc.start() // registers this network's ping handler on the remote
			await node.dial(other.getMultiaddrs()[0]!)
			const id = other.peerId.toString()
			store.upsert(id, await hashPeerId(other.peerId))
			// Dead *and* still unclassified: the recovery arm has to fix both labels, and it is the
			// only pass that will look at this peer — `classifyUnknownPeers` skips dead candidates
			// so the two arms never probe the same peer in one tick.
			store.update(id, { state: 'dead', contactFailures: 3, lastContactFailureAt: Date.now() })
			expect(store.getById(id)?.membership).to.equal('unknown')
			// Nothing in the ring views can reach it, so a tick's ordinary probe targets are empty.
			expect(svc.getNeighbors(await hashPeerId(node.peerId), 'both', 8)).to.not.include(id)

			const pingsBefore = svc.getDiagnostics().pingsSent
			await (svc as any).stabilizeOnce()

			expect(svc.getDiagnostics().pingsSent).to.be.greaterThan(pingsBefore, 'the dead arm pinged it')
			expect(store.getById(id)?.state).to.equal('connected')
			expect(store.getById(id)?.contactFailures).to.equal(0)
			expect(store.getById(id)?.membership).to.equal('member')
		} finally {
			await otherSvc.stop()
		}
	})

	// Separate budgets, not one merged candidate list: the foreign arm is already near saturation
	// around ~42 foreign peers, and a merged list would put every dead peer behind that queue.
	it('does not let a large foreign population starve the dead arm', async () => {
		const probed: string[] = []
		;(svc as any).probeMembership = async (id: string) => { probed.push(id) }
		for (let i = 0; i < 40; i++) {
			const id = `foreign-${i}`
			store.upsert(id, coordAt(i))
			store.setMembership(id, 'foreign')
			;(svc as any).setAddressKnown(id, true)
		}
		store.upsert('gone', coordAt(200))
		store.setMembership('gone', 'member')
		store.update('gone', { state: 'dead' })
		;(svc as any).setAddressKnown('gone', true)

		await (svc as any).reprobeExcludedPeers()

		expect(probed).to.include('gone')
		// Core budget is 2 per arm, so the foreign flood cannot consume the dead arm's slots.
		expect(probed.filter((id) => id.startsWith('foreign-'))).to.have.length(2)
	})

	// A peer that is both foreign and dead belongs to the dead arm alone — otherwise one tick
	// would spend two probes on the same peer, and a successful one fixes both labels anyway.
	it('probes a foreign+dead peer exactly once per tick', async () => {
		const probed: string[] = []
		;(svc as any).probeMembership = async (id: string) => { probed.push(id) }
		store.upsert('both', coordAt(42))
		store.setMembership('both', 'foreign')
		store.update('both', { state: 'dead' })
		;(svc as any).setAddressKnown('both', true)

		await (svc as any).reprobeExcludedPeers()

		expect(probed).to.deep.equal(['both'])
	})

	// The announce and leave fan-outs walk the store unfiltered (so a freshly-connected `unknown`
	// peer is not stalled), which means they need their own dead skip: the dial can only fail, and
	// the leave path runs inside stop() where a stack of doomed dials also delays shutdown.
	it('skips dead targets in the announce fan-out', async () => {
		store.upsert('alive', coordAt(10)); store.setMembership('alive', 'member')
		store.upsert('gone', coordAt(20)); store.setMembership('gone', 'member')
		store.update('gone', { state: 'dead' })
		;(svc as any).setAddressKnown('alive', true)
		;(svc as any).setAddressKnown('gone', true)

		// Neither dial can succeed against a synthetic id, so count what the choke point *attempts*
		// instead: the announce token is taken once per target that passes the guards, so a bucket
		// that always grants makes the take count the attempt count.
		let takes = 0
		;(svc as any).bucketAnnounce = { tryTake: () => { takes++; return true } }
		await (svc as any).sendAnnouncementsRateLimited(['alive', 'gone'], await (svc as any).snapshot())

		expect(takes).to.equal(1, 'only the live target was attempted')
	})
})

// The tests above drive the seam helpers directly, which leaves the wiring at the outbound-RPC
// call sites unasserted — a call site that forgot to route its catch through `noteRpcFailure`
// would pass every one of them. These drive a real `sendPing` instead, so the transition is
// observed end to end through `probeNeighborsLatency`.
describe('dead state: through a real outbound RPC call site', () => {
	let node: Libp2p
	let svc: CoreFretService
	let store: DigitreeStore
	const spares: Libp2p[] = []

	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
		// Not started: the transitions here are driven explicitly, and a live stabilization loop
		// would probe the same peers on its own schedule and make the counts non-deterministic.
		svc = new CoreFretService(node, { profile: 'core', networkName: 'net-test' })
		store = svc.getStore()
	})

	afterEach(async () => {
		try { await svc.stop() } catch {}
		await stopAll([node, ...spares.splice(0)])
	})

	/** A well-formed peer id this node holds no address for — every dial to it fails outright. */
	async function unreachablePeer(): Promise<string> {
		const ghost = await createMemNode()
		const id = ghost.peerId.toString()
		await stopAll([ghost])
		store.upsert(id, await hashPeerId(ghost.peerId))
		store.setMembership(id, 'member')
		return id
	}

	it('marks an unreachable neighbor dead after a run of failed pings', async () => {
		const id = await unreachablePeer()
		for (let i = 0; i < 3; i++) {
			await (svc as any).probeNeighborsLatency([id])
			store.update(id, { lastContactFailureAt: 0 }) // stand in for the spacing interval
		}

		expect(store.getById(id)?.contactFailures).to.equal(3)
		expect(store.getById(id)?.state).to.equal('dead')
		// A dial that never reached the remote says nothing about which network it serves.
		expect(store.getById(id)?.membership).to.equal('member')
	})

	it('resurrects a dead peer once a ping to it succeeds again', async () => {
		const other = await createMemNode()
		spares.push(other)
		await other.start()
		const otherSvc = new CoreFretService(other, { profile: 'core', networkName: 'net-test' })
		try {
			await otherSvc.start() // registers this network's ping handler on the remote
			await node.dial(other.getMultiaddrs()[0]!)
			const id = other.peerId.toString()
			store.upsert(id, await hashPeerId(other.peerId))
			store.update(id, { state: 'dead', contactFailures: 3, lastContactFailureAt: Date.now() })

			await (svc as any).probeNeighborsLatency([id])

			expect(store.getById(id)?.state).to.equal('connected')
			expect(store.getById(id)?.contactFailures).to.equal(0)
			expect(store.getById(id)?.lastContactFailureAt).to.equal(0)
		} finally {
			await otherSvc.stop()
		}
	})
})
