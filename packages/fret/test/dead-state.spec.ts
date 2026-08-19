import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService, selectDiverseSample } from '../src/service/fret-service.js'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { assembleCohort } from '../src/service/cohort.js'
import { estimateSizeAndConfidence } from '../src/estimate/size-estimator.js'
import { createSparsityModel } from '../src/store/relevance.js'
import { coordToBase64url, hashKey, hashPeerId } from '../src/ring/hash.js'
import type { Libp2p } from 'libp2p'
import type { RouteAndMaybeActV1, RouteProgress } from '../src/index.js'

// A peer that repeatedly cannot be reached is marked `dead`; any proof that it is alive clears
// the run and resurrects it. The distinction these tests pin down is *what counts as a failed
// contact*: only a failure to reach the peer at all. A peer that answers and refuses to negotiate
// this network's protocol, a peer that replies `ok: false`, and an idle disconnect all prove (or
// at least do not disprove) that the remote is alive, so none of them may push it toward dead.
//
// The spacing guard between counted strikes is wall-clock, so every test that needs a *run* of
// strikes rewinds `lastContactFailureAt` between them rather than sleeping.
//
// NOTE: at ~1000 lines this is the largest spec in the package (next is ring-membership at ~840).
// Kept whole because its six blocks share one subject — what may and may not push a peer toward
// `dead` — and each already owns its fixture, so a split would duplicate setup without separating
// concerns. If a seventh block lands, split by *evidence source* (store-level, ring views, probe
// passes, real RPC call sites) rather than by test count.

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
			// `noteRpcFailure` branches on the outcome variant, not on the error's identity —
			// `foreign-protocol` is the variant that carries an unsupported-protocol failure.
			await (svc as any).noteRpcFailure(id, { kind: 'foreign-protocol', error: unsupportedProtocolError() })
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

	// Leave-notice replacement hints are the same transitive-propagation channel as the outgoing
	// snapshot's neighbor lists and sample: the recipient dials and pings what we name here, so a
	// peer we have given up on (or proved serves another network) must not be advertised as a
	// suggested neighbor.
	it('never advertises a dead or foreign peer as a leave-notice replacement', async () => {
		live('live-a', 60); live('live-b', 160)
		dead('gone', 61)
		store.upsert('other-net', coordAt(62)); store.setMembership('other-net', 'foreign')

		const selfCoord = await hashPeerId(node.peerId)
		const replacements = (svc as any).computeReplacements(
			selfCoord, new Set<string>(), node.peerId.toString()
		) as string[]

		expect(replacements).to.have.members(['live-a', 'live-b'])
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
			// only pass that will look at this peer — `classifyTargets` skips dead candidates
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

		// The pass now *selects* its targets and the tick pools the probes, so the selection is
		// what carries the separate-budgets rule and is asserted directly.
		const probed = (svc as any).reprobeExcludedTargets() as string[]

		expect(probed).to.include('gone')
		// Core budget is 2 per arm, so the foreign flood cannot consume the dead arm's slots.
		expect(probed.filter((id) => id.startsWith('foreign-'))).to.have.length(2)
	})

	// A peer that is both foreign and dead belongs to the dead arm alone — otherwise one tick
	// would spend two probes on the same peer, and a successful one fixes both labels anyway.
	it('probes a foreign+dead peer exactly once per tick', async () => {
		store.upsert('both', coordAt(42))
		store.setMembership('both', 'foreign')
		store.update('both', { state: 'dead' })
		;(svc as any).setAddressKnown('both', true)

		const probed = (svc as any).reprobeExcludedTargets() as string[]

		expect(probed).to.deep.equal(['both'])
	})

	// The announce and leave fan-outs walk the store unfiltered (so a freshly-connected `unknown`
	// peer is not stalled), which means they need their own dead skip: the dial can only fail, and
	// the leave path runs inside stop() where a stack of doomed dials also delays shutdown. Both
	// share one predicate — `isDoomedDial` — which is what these two tests pin: the announce test
	// drives it end to end through the choke point, this one covers the classification directly
	// (the leave fan-out's `sendLeave` is a module import with no seam to count attempts at).
	it('treats undialable, foreign, and dead maintenance targets as doomed dials', () => {
		const doomed = (id: string): boolean => (svc as any).isDoomedDial(id) as boolean

		store.upsert('no-address', coordAt(10)); store.setMembership('no-address', 'member')
		expect(doomed('no-address'), 'no peerStore address').to.equal(true)

		store.upsert('live', coordAt(20)); store.setMembership('live', 'member')
		;(svc as any).setAddressKnown('live', true)
		expect(doomed('live'), 'dialable live member').to.equal(false)

		// `unknown` is deliberately still a target — it may yet turn out to be a member, and
		// starving it is what would stall bootstrap.
		store.upsert('unclassified', coordAt(30))
		;(svc as any).setAddressKnown('unclassified', true)
		expect(doomed('unclassified'), 'unknown is not doomed').to.equal(false)

		store.upsert('other-net', coordAt(40)); store.setMembership('other-net', 'foreign')
		;(svc as any).setAddressKnown('other-net', true)
		expect(doomed('other-net'), 'foreign answers only UnsupportedProtocolError').to.equal(true)

		store.upsert('gone', coordAt(50)); store.setMembership('gone', 'member')
		store.update('gone', { state: 'dead' })
		;(svc as any).setAddressKnown('gone', true)
		expect(doomed('gone'), 'dead is the dead arm\'s job, not a fan-out\'s').to.equal(true)
	})

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
// observed end to end through `probeNeighborLatency`.
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
			await (svc as any).probeNeighborLatency(id, (svc as any).runSignal)
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

			await (svc as any).probeNeighborLatency(id, (svc as any).runSignal)

			expect(store.getById(id)?.state).to.equal('connected')
			expect(store.getById(id)?.contactFailures).to.equal(0)
			expect(store.getById(id)?.lastContactFailureAt).to.equal(0)
		} finally {
			await otherSvc.stop()
		}
	})
})

// An RPC that failed because *we* cancelled it says nothing about the peer it was aimed at. Every
// outbound call site therefore compares the failure against the run signal its caller captured
// before the loop (`wasCancelled`) and, when that signal is aborted, records nothing at all: no
// contact strike, no relevance decay, no backoff, no `pingsFail`. Without it a `stop()` landing on
// a busy tick manufactures strikes against healthy neighbors and can mark them dead — inverting
// the point of cancelling. These tests drive each guarded call site with an already-aborted run
// signal, and pair the ones that could pass vacuously with a live-run contrast.
describe('cancellation is not evidence about a peer', () => {
	let node: Libp2p
	let svc: CoreFretService
	let store: DigitreeStore
	const spares: Libp2p[] = []

	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
		// Not started: a live stabilization loop would probe these peers on its own schedule and
		// make every count below non-deterministic.
		svc = new CoreFretService(node, { profile: 'core', networkName: 'net-test' })
		store = svc.getStore()
	})

	afterEach(async () => {
		try { await svc.stop() } catch {}
		await stopAll([node, ...spares.splice(0)])
	})

	/**
	 * The state `stop()` leaves behind: a run signal already aborted, kept rather than nulled.
	 * `stopped` is deliberately left false, so what stops each pass below is the *signal* alone.
	 * That `stop()` really produces this state is pinned separately by service-lifecycle.spec's
	 * "mints a fresh run signal per start and leaves the stopped run aborted".
	 */
	function cancelRun(target: CoreFretService = svc): void {
		const ac = new AbortController()
		ac.abort(new Error('service stopped'))
		;(target as any).runAbort = ac
	}

	/** A live run, for the contrast cases — `runAbort` is null until the first `start()`. */
	function liveRun(target: CoreFretService = svc): AbortController {
		const ac = new AbortController()
		;(target as any).runAbort = ac
		return ac
	}

	/**
	 * A well-formed peer id this node holds no address for, so every dial to it fails outright.
	 *
	 * Real Ed25519 ids matter here rather than synthetic strings: `sendPing` / `sendMaybeAct` call
	 * `peerIdFromString` on their first line, *outside* the try, so a synthetic id throws a parse
	 * error — the cancelled-path tests would pass for the wrong reason and the contrast cases would
	 * record a strike that has nothing to do with reachability.
	 */
	async function unreachablePeer(coord?: Uint8Array): Promise<string> {
		const ghost = await createMemNode()
		const id = ghost.peerId.toString()
		const at = coord ?? await hashPeerId(ghost.peerId)
		await stopAll([ghost])
		store.upsert(id, at)
		store.setMembership(id, 'member')
		return id
	}

	/** Make a seeded id pass `isDialable` so it reaches the paths that dial. */
	function dialable(...ids: string[]): void {
		for (const id of ids) (svc as any).setAddressKnown(id, true)
	}

	/**
	 * Nothing about this peer was scored, across *both* arms of `noteRpcFailure`. The contact arm
	 * is the obvious one (relevance decay via `failureCount`, then the strike and the `dead` label);
	 * the membership arm is asserted too because a regression that moved a guard below
	 * `noteRpcFailure` would be invisible here whenever the cancelled call happened to fail with an
	 * unsupported-protocol error — that arm touches `negotiateFailures` / `membership` and neither
	 * `contactFailures` nor `failureCount`.
	 */
	function expectUnscored(id: string, label = id): void {
		const e = store.getById(id)
		expect(e, `${label} still in the routing table`).to.not.equal(undefined)
		expect(e?.contactFailures, `${label}: no contact strike`).to.equal(0)
		expect(e?.failureCount, `${label}: no relevance decay`).to.equal(0)
		expect(e?.negotiateFailures, `${label}: no membership evidence`).to.equal(0)
		expect(e?.membership, `${label}: not demoted`).to.equal('member')
		expect(e?.state, `${label}: not marked dead`).to.not.equal('dead')
		expect((svc as any).backoffMap.get(id), `${label}: no backoff recorded`).to.equal(undefined)
	}

	/** Count `dialProtocol` calls — the direct form of "no dial was issued". */
	function countDials(): { get: () => number; restore: () => void } {
		let dials = 0
		const original = node.dialProtocol.bind(node)
		;(node as any).dialProtocol = (...args: unknown[]) => {
			dials++
			return (original as any)(...args)
		}
		return { get: () => dials, restore: () => { (node as any).dialProtocol = original } }
	}

	/** `coord` shifted by one in ring arithmetic, so a seeded peer sits immediately beside a key. */
	function offsetCoord(coord: Uint8Array, delta: 1 | -1): Uint8Array {
		const out = new Uint8Array(coord)
		for (let i = out.length - 1; i >= 0; i--) {
			const v = out[i]! + delta
			out[i] = (v + 256) % 256
			if (v >= 0 && v <= 255) break
		}
		return out
	}

	it('records nothing against a neighbor when its latency probe is cancelled', async () => {
		const id = await unreachablePeer()
		cancelRun()
		const before = { ...svc.getDiagnostics() }

		await (svc as any).probeNeighborLatency(id, (svc as any).runSignal)

		expect(svc.getDiagnostics().pingsSent, 'no ping counted').to.equal(before.pingsSent)
		expect(svc.getDiagnostics().pingsFail, 'no ping failure counted').to.equal(before.pingsFail)
		expectUnscored(id)
	})

	// The contrast that keeps the guard from being over-broad: the same unreachable peer, the same
	// call, but a live run — the failure is now genuinely about the peer and is scored exactly once.
	// (The full run to `dead` is pinned by "marks an unreachable neighbor dead after a run of
	// failed pings" above; this is the single-strike half, so the pair reads together.)
	it('still strikes once from the latency probe when the run is live', async () => {
		const id = await unreachablePeer()
		liveRun()

		await (svc as any).probeNeighborLatency(id, (svc as any).runSignal)

		expect(store.getById(id)?.contactFailures, 'one strike').to.equal(1)
		expect(svc.getDiagnostics().pingsFail).to.equal(1)
	})

	// `probeMembership` is the site that also backs off on the unguarded path, so the backoff
	// assertion is the load-bearing one here: a cancelled probe must leave the next run free to
	// probe this peer immediately rather than starting it in a backoff window it never earned.
	it('records neither a strike nor a backoff when a membership probe is cancelled', async () => {
		const id = await unreachablePeer()
		cancelRun()
		const before = { ...svc.getDiagnostics() }

		await (svc as any).probeMembership(id, (svc as any).runSignal)

		expect(svc.getDiagnostics().pingsSent).to.equal(before.pingsSent)
		expect(svc.getDiagnostics().pingsFail).to.equal(before.pingsFail)
		expectUnscored(id)
	})

	it('still strikes and backs off from a membership probe when the run is live', async () => {
		const id = await unreachablePeer()
		liveRun()

		await (svc as any).probeMembership(id, (svc as any).runSignal)

		expect(store.getById(id)?.contactFailures, 'one strike').to.equal(1)
		expect((svc as any).backoffMap.get(id), 'backoff recorded').to.not.equal(undefined)
		expect(svc.getDiagnostics().pingsFail).to.equal(1)
	})

	// `preconnectNeighbors` never increments `pingsSent` for a failed ping either way, so counting
	// dials is what actually separates "cancelled before dialing" from "the target list was empty".
	// `openRpcStream` throws on an already-aborted signal *before* dialing, which is the mechanism.
	it('issues no dial from the preconnect pass when the run is cancelled', async () => {
		const id = await unreachablePeer()
		dialable(id)
		const dials = countDials()
		try {
			cancelRun()
			await (svc as any).preconnectNeighbors()

			expect(dials.get(), 'cancelled: no dial issued').to.equal(0)
			expect(svc.getDiagnostics().pingsSent).to.equal(0)
			expectUnscored(id)

			// Non-vacuity: the same pass on a live run really does reach the dial, so the zero above
			// is the signal's doing rather than an empty candidate list.
			liveRun()
			await (svc as any).preconnectNeighbors()
			expect(dials.get(), 'live: the seeded peer really was a preconnect target').to.equal(1)
		} finally {
			dials.restore()
		}
	})

	// `snapshotsFetched` is pinned at *unchanged*. It used to be +1: `fetchNeighbors` swallowed
	// every failure — the abort included — into a fabricated empty snapshot, so the counter ticked
	// for a fetch that never opened a stream. `RpcOutcome` distinguishes `cancelled` from an `ok`
	// carrying an empty snapshot, so `fetchAndMergeSnapshot` counts only `ok` and the overcount is
	// gone. Nothing merged and nothing scored is asserted alongside, as before.
	it('merges nothing and scores nothing when a snapshot fetch is cancelled', async () => {
		const id = await unreachablePeer()
		cancelRun()
		const before = svc.getDiagnostics().snapshotsFetched
		const entriesBefore = store.list().length

		await (svc as any).fetchAndMergeSnapshot(id, (svc as any).runSignal)

		expect(svc.getDiagnostics().snapshotsFetched, 'a cancelled fetch is not a fetch').to.equal(before)
		expect(store.list().length, 'nothing merged').to.equal(entriesBefore)
		expectUnscored(id)
	})

	// The announce loop is the one site where the catch cannot carry the guard: `announceNeighbors`
	// swallows the abort, so the top-of-loop check is what stops a cancelled run from spending an
	// announce token — and counting an `announcementsSent` — against every remaining target.
	it('takes no announce token when the run is cancelled', async () => {
		const a = await unreachablePeer()
		const b = await unreachablePeer()
		dialable(a, b)
		let takes = 0
		;(svc as any).bucketAnnounce = { tryTake: () => { takes++; return true } }
		const snap = await (svc as any).snapshot()

		cancelRun()
		await (svc as any).sendAnnouncementsRateLimited([a, b], snap)
		expect(takes, 'cancelled: not one token spent').to.equal(0)
		expect(svc.getDiagnostics().announcementsSent).to.equal(0)

		// Non-vacuity: both targets pass every other guard, so a live run spends one token each.
		liveRun()
		await (svc as any).sendAnnouncementsRateLimited([a, b], snap)
		expect(takes, 'live: one token per live target').to.equal(2)
	})

	it('scores nothing against the forward hop when a routeAct forward is cancelled', async () => {
		const keyBytes = new TextEncoder().encode('cancelled-forward-key')
		const coord = await hashKey(keyBytes)
		// Two members hugging the key, so the cohort of `want_k: 2` is filled by them and self
		// (which is not even in the store) is never in-cluster — the message must forward.
		const succ = await unreachablePeer(offsetCoord(coord, 1))
		const pred = await unreachablePeer(offsetCoord(coord, -1))
		dialable(succ, pred)

		cancelRun()
		const before = svc.getDiagnostics().maybeActForwarded
		const msg: RouteAndMaybeActV1 = {
			v: 1,
			key: coordToBase64url(keyBytes),
			want_k: 2,
			ttl: 4,
			min_sigs: 1,
			correlation_id: 'cancel-forward',
			timestamp: Date.now(),
			signature: '',
		}
		const res = await svc.routeAct(msg)

		// The counter increments just before the send, so it is what proves the forward path was
		// actually taken rather than the message being answered in-cluster.
		expect(svc.getDiagnostics().maybeActForwarded, 'forward path taken').to.equal(before + 1)
		expect(res, 'the honest "did not forward" answer').to.have.property('anchors')
		expectUnscored(succ, 'successor candidate')
		expectUnscored(pred, 'predecessor candidate')
	})

	it('ends a cancelled lookup as exhausted without scoring the hop', async () => {
		const keyBytes = new TextEncoder().encode('cancelled-lookup-key')
		const coord = await hashKey(keyBytes)
		const hop = await unreachablePeer(offsetCoord(coord, 1))
		dialable(hop)

		cancelRun()
		const progress: RouteProgress[] = []
		for await (const p of svc.iterativeLookup(keyBytes, { wantK: 2, minSigs: 1 })) progress.push(p)

		// `probing` is yielded before the send, so the tail is what carries the outcome.
		expect(progress.map((p) => p.type)).to.deep.equal(['probing', 'exhausted'])
		expect(progress[0]?.peerId, 'the walk really picked the seeded hop').to.equal(hop)
		expectUnscored(hop)
	})

	// The activity-resend arm: a lookup that probed, was invited to resend with the payload, and
	// was cancelled before the resend could land. The activity is silently never delivered — which
	// is exactly why the `exhausted`-vs-cancelled conflation carries a NOTE at the yield site — but
	// the peer that never answered must still not be scored for it.
	it('scores nothing against the anchor when the activity resend is cancelled', async () => {
		const other = await createMemNode()
		spares.push(other)
		await other.start()
		const otherSvc = new CoreFretService(other, { profile: 'core', networkName: 'net-test' })
		try {
			await otherSvc.start() // registers this network's maybeAct handler on the remote
			await node.dial(other.getMultiaddrs()[0]!)
			const id = other.peerId.toString()
			store.upsert(id, await hashPeerId(other.peerId))
			store.setMembership(id, 'member')

			const keyBytes = new TextEncoder().encode('cancelled-resend-key')
			const ac = liveRun()
			// On a ring this small `shouldIncludePayload` is false regardless of distance —
			// `probability * confidence >= 0.5` needs confidence >= 0.5, and confidence is
			// 0.5*sizeFactor + 0.5*dispersion with sizeFactor = count / 2m — so the payload is
			// withheld on the probe and the resend arm is the one taken.
			const gen = svc.iterativeLookup(keyBytes, { wantK: 2, minSigs: 1, activity: 'work' })
			const types: string[] = []
			for (let r = await gen.next(); !r.done; r = await gen.next()) {
				types.push(r.value.type)
				// Cancel the run the moment the invitation to resend arrives, so the abort lands on
				// the resend itself rather than on the probe.
				if (r.value.type === 'near_anchor') ac.abort(new Error('service stopped'))
			}

			expect(types, 'the resend arm was reached and then cancelled').to.deep.equal(
				['probing', 'near_anchor', 'activity_sent', 'exhausted']
			)
			expectUnscored(id, 'probed anchor')
		} finally {
			await otherSvc.stop()
		}
	})
})
