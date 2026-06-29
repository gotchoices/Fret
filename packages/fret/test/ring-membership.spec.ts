import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService, selectDiverseSample } from '../src/service/fret-service.js'
import { DigitreeStore, type PeerEntry, type MembershipState } from '../src/store/digitree-store.js'
import { assembleCohort } from '../src/service/cohort.js'
import { estimateSizeAndConfidence } from '../src/estimate/size-estimator.js'
import { FretPeerDiscovery } from '../src/service/peer-discovery.js'
import { createSparsityModel } from '../src/store/relevance.js'
import { hashPeerId } from '../src/ring/hash.js'
import { isUnsupportedProtocolError } from '../src/rpc/protocols.js'
import type { Libp2p } from 'libp2p'

/** Member predicate mirroring FretService's internal one; gates the ring views below. */
const member = (e: PeerEntry): boolean => e.membership === 'member'

/** 32-byte ring coordinate distinguished by its most-significant byte (orders by `value`). */
function coordAt(value: number): Uint8Array {
	const u = new Uint8Array(32)
	u[0] = value
	return u
}

function seed(store: DigitreeStore, specs: Array<[string, number, MembershipState]>): void {
	for (const [id, value, m] of specs) {
		store.upsert(id, coordAt(value))
		store.setMembership(id, m)
	}
}

// Membership classification labels each known peer as member / foreign / unknown
// relative to *this* node's FRET network. The in-memory test nodes have no identify
// service, so peerStore protocols never populate — classification here rides the
// deployment-independent probe path (a namespaced ping over each network's protocol).

describe('isUnsupportedProtocolError', () => {
	it('matches libp2p UnsupportedProtocolError by name', () => {
		const e = new Error('Protocol selection failed - could not negotiate /optimystic/net-a/fret/1.0.0/ping')
		e.name = 'UnsupportedProtocolError'
		expect(isUnsupportedProtocolError(e)).to.equal(true)
	})

	it('matches the legacy ERR_UNSUPPORTED_PROTOCOL code', () => {
		const e = Object.assign(new Error('nope'), { code: 'ERR_UNSUPPORTED_PROTOCOL' })
		expect(isUnsupportedProtocolError(e)).to.equal(true)
	})

	it('matches by message substring as a fallback', () => {
		expect(isUnsupportedProtocolError(new Error('could not negotiate /x'))).to.equal(true)
	})

	// The critical guard: a timeout / transient failure must NOT demote a peer to
	// foreign — only an explicit unsupported-protocol error does. Otherwise a
	// fresh same-network peer whose probe times out would be wrongly excluded.
	it('does NOT match a timeout / transient error', () => {
		const t = Object.assign(new Error('request timed out'), { name: 'TimeoutError' })
		expect(isUnsupportedProtocolError(t)).to.equal(false)
		expect(isUnsupportedProtocolError(new Error('ECONNRESET'))).to.equal(false)
		expect(isUnsupportedProtocolError(new Error('stream reset'))).to.equal(false)
		expect(isUnsupportedProtocolError(null)).to.equal(false)
		expect(isUnsupportedProtocolError(undefined)).to.equal(false)
		expect(isUnsupportedProtocolError('a string')).to.equal(false)
	})
})

describe('DigitreeStore membership field', () => {
	it('defaults new entries to unknown', () => {
		const s = new DigitreeStore()
		const e = s.upsert('id1', new Uint8Array(32))
		expect(e.membership).to.equal('unknown')
		expect(s.getById('id1')?.membership).to.equal('unknown')
	})

	it('setMembership updates the label in both directions', () => {
		const s = new DigitreeStore()
		s.upsert('id1', new Uint8Array(32))
		s.setMembership('id1', 'member')
		expect(s.getById('id1')?.membership).to.equal('member')
		s.setMembership('id1', 'foreign')
		expect(s.getById('id1')?.membership).to.equal('foreign')
	})

	// upsert runs network-agnostically on every peerStore/connect/snapshot signal; if
	// it reset membership a classification would be wiped every stabilization tick.
	it('preserves membership across a re-upsert', () => {
		const s = new DigitreeStore()
		s.upsert('id1', new Uint8Array(32))
		s.setMembership('id1', 'foreign')
		s.upsert('id1', new Uint8Array(32)) // simulate a peerStore / peer:connect re-seed
		expect(s.getById('id1')?.membership).to.equal('foreign')
	})

	// upsert's contract is "ensure an entry exists", not "reset to defaults".
	// All mutable stats must survive a re-upsert (simulating a per-tick re-seed).
	it('preserves relevance and health counters across a re-upsert', () => {
		const s = new DigitreeStore()
		s.upsert('id1', new Uint8Array(32))
		s.update('id1', {
			relevance: 0.9,
			successCount: 5,
			failureCount: 1,
			accessCount: 7,
			avgLatencyMs: 42,
			state: 'connected',
			membership: 'member',
		})
		s.upsert('id1', new Uint8Array(32)) // simulate a per-tick re-seed
		const e = s.getById('id1')!
		expect(e.relevance).to.equal(0.9)
		expect(e.successCount).to.equal(5)
		expect(e.failureCount).to.equal(1)
		expect(e.accessCount).to.equal(7)
		expect(e.avgLatencyMs).to.equal(42)
		expect(e.state).to.equal('connected')
		expect(e.membership).to.equal('member')
	})

	// A brand-new id must still build from defaults — only existing entries are preserved.
	it('initializes a new id to zero counters and disconnected state', () => {
		const s = new DigitreeStore()
		const e = s.upsert('brand-new', new Uint8Array(32))
		expect(e.relevance).to.equal(0)
		expect(e.successCount).to.equal(0)
		expect(e.failureCount).to.equal(0)
		expect(e.accessCount).to.equal(0)
		expect(e.avgLatencyMs).to.equal(0)
		expect(e.state).to.equal('disconnected')
		expect(e.membership).to.equal('unknown')
	})

	// Defensive branch: coord is hash-derived from the id and never changes in practice,
	// but if a re-upsert ever supplied a different coord the BTree key must be rebuilt
	// (delete + re-insert) so the byId→key mapping and ordered index stay consistent —
	// while still preserving the entry's accumulated stats.
	it('re-keys without orphaning when a re-upsert changes the coord', () => {
		const s = new DigitreeStore()
		s.upsert('id1', new Uint8Array(32))
		s.update('id1', { relevance: 0.5, successCount: 3, membership: 'member' })
		const newCoord = new Uint8Array(32).fill(7)
		s.upsert('id1', newCoord)
		const e = s.getById('id1')!
		// stats survived the re-key
		expect(e.relevance).to.equal(0.5)
		expect(e.successCount).to.equal(3)
		expect(e.membership).to.equal('member')
		// coord was updated and no stale duplicate remains in the ordered index
		expect(Array.from(e.coord)).to.deep.equal(Array.from(newCoord))
		expect(s.size()).to.equal(1)
		expect(s.list()).to.have.lengthOf(1)
		// the entry is reachable at the new coord, not the old one
		expect(s.successorOfCoord(newCoord)?.id).to.equal('id1')
	})

	it('round-trips membership through export/import', () => {
		const s = new DigitreeStore()
		s.upsert('m', new Uint8Array(32)); s.setMembership('m', 'member')
		s.upsert('f', new Uint8Array(32).fill(1)); s.setMembership('f', 'foreign')

		const exported = s.exportEntries()
		expect(exported.find((e) => e.id === 'm')?.membership).to.equal('member')
		expect(exported.find((e) => e.id === 'f')?.membership).to.equal('foreign')

		const s2 = new DigitreeStore()
		s2.importEntries(exported)
		expect(s2.getById('m')?.membership).to.equal('member')
		expect(s2.getById('f')?.membership).to.equal('foreign')
	})

	it('defaults a missing membership field to unknown on import (back-compat)', () => {
		const s = new DigitreeStore()
		s.upsert('m', new Uint8Array(32)); s.setMembership('m', 'member')
		const legacy = s.exportEntries().map((e) => {
			const copy: Record<string, unknown> = { ...e }
			delete copy.membership
			return copy
		})
		const s2 = new DigitreeStore()
		s2.importEntries(legacy as never)
		expect(s2.getById('m')?.membership).to.equal('unknown')
	})
})

describe('Ring membership gating (member-scoped reads)', () => {
	it('neighborsRight/Left skip foreign entries and keep advancing', () => {
		const store = new DigitreeStore()
		seed(store, [
			['fR', 101, 'foreign'], ['fR2', 102, 'foreign'],
			['mR', 110, 'member'], ['mR2', 120, 'member'],
			['mL', 90, 'member'], ['mL2', 80, 'member'],
			['fL', 99, 'foreign'], ['fL2', 98, 'foreign'],
		])
		const key = coordAt(100)
		expect(store.neighborsRight(key, 2, member)).to.deep.equal(['mR', 'mR2'])
		expect(store.neighborsLeft(key, 2, member)).to.deep.equal(['mL', 'mL2'])
	})

	// The bounded-scan guard: a filtered walk over a ring with zero matching entries must
	// terminate (one full traversal) rather than spin forever on the wrap-around.
	it('a filtered walk with no matches terminates and returns empty', () => {
		const store = new DigitreeStore()
		seed(store, [['f1', 10, 'foreign'], ['f2', 20, 'foreign'], ['f3', 30, 'foreign']])
		expect(store.neighborsRight(coordAt(0), 5, member)).to.deep.equal([])
		expect(store.neighborsLeft(coordAt(255), 5, member)).to.deep.equal([])
	})

	// Foreign-near-key starvation: even when the closest slots to the key are all foreign,
	// skip-and-continue + the wants*2 over-fetch must still collect `wants` same-network members.
	it('cohort still returns members when foreign peers cluster nearest the key', () => {
		const store = new DigitreeStore()
		seed(store, [
			['fL', 98, 'foreign'], ['fL2', 99, 'foreign'],
			['fR', 101, 'foreign'], ['fR2', 102, 'foreign'],
			['mL', 80, 'member'], ['mL2', 70, 'member'], ['mL3', 60, 'member'], ['mL4', 50, 'member'],
			['mR', 120, 'member'], ['mR2', 130, 'member'], ['mR3', 140, 'member'], ['mR4', 150, 'member'],
		])
		const key = coordAt(100)
		const cohort = assembleCohort(store, key, 4, undefined, member)
		expect(cohort).to.have.length(4)
		for (const id of cohort) expect(store.getById(id)?.membership).to.equal('member')
		expect(cohort).to.not.include('fR')
		expect(cohort).to.not.include('fL')

		// Contrast: without the member filter the nearest (foreign) peers WOULD be selected.
		const unscoped = assembleCohort(store, key, 4)
		expect(unscoped.some((id) => store.getById(id)?.membership === 'foreign')).to.equal(true)
	})

	// A fresh same-network peer arrives `unknown`, is excluded from the ring, then is admitted
	// once the classification machinery promotes it to `member` — not starved permanently.
	it('admits a fresh peer once it is classified member (excluded while unknown)', () => {
		const store = new DigitreeStore()
		seed(store, [['m1', 50, 'member'], ['m2', 150, 'member']])
		const key = coordAt(100)
		store.upsert('fresh', coordAt(101)) // nearest the key, but still unknown

		expect(store.neighborsRight(key, 5, member)).to.not.include('fresh')
		expect(assembleCohort(store, key, 5, undefined, member)).to.not.include('fresh')

		store.setMembership('fresh', 'member') // probe pass / RPC confirms same-network

		expect(store.neighborsRight(key, 5, member)).to.include('fresh')
		expect(assembleCohort(store, key, 5, undefined, member)).to.include('fresh')
	})

	it('size estimate over members is not inflated by foreign peers', () => {
		const mixed = new DigitreeStore()
		seed(mixed, [
			['m1', 40, 'member'], ['m2', 80, 'member'], ['m3', 120, 'member'], ['m4', 160, 'member'],
			['f1', 50, 'foreign'], ['f2', 60, 'foreign'], ['f3', 70, 'foreign'],
		])
		const memberOnly = new DigitreeStore()
		seed(memberOnly, [
			['m1', 40, 'member'], ['m2', 80, 'member'], ['m3', 120, 'member'], ['m4', 160, 'member'],
		])

		const scoped = estimateSizeAndConfidence(mixed, 4, member)
		const expected = estimateSizeAndConfidence(memberOnly, 4)
		expect(scoped.n).to.equal(expected.n, 'member-scoped estimate equals a members-only store')

		// Sanity: the unfiltered estimate over the mixed store IS inflated by the foreign peers.
		const inflated = estimateSizeAndConfidence(mixed, 4)
		expect(inflated.n).to.be.greaterThan(scoped.n)
	})

	it('selectDiverseSample excludes foreign peers when given the member filter', () => {
		const store = new DigitreeStore()
		seed(store, [
			['m1', 40, 'member'], ['m2', 120, 'member'],
			['f1', 60, 'foreign'], ['f2', 80, 'foreign'],
		])
		const sparsity = createSparsityModel()
		const ids = selectDiverseSample(store, coordAt(0), sparsity, new Set(), 10, member).map((s) => s.id)
		expect(ids).to.include('m1')
		expect(ids).to.include('m2')
		expect(ids).to.not.include('f1')
		expect(ids).to.not.include('f2')

		// No filter → foreign peers included (exported standalone unchanged).
		const unfiltered = selectDiverseSample(store, coordAt(0), sparsity, new Set(), 10).map((s) => s.id)
		expect(unfiltered).to.include('f1')
	})

	// Single-network regression: when every peer is a member, member-scoping is a no-op on
	// results (the only cost is the per-entry membership comparison).
	it('member-scoped reads equal unfiltered reads when every peer is a member', () => {
		const store = new DigitreeStore()
		seed(store, [
			['m1', 30, 'member'], ['m2', 70, 'member'], ['m3', 110, 'member'],
			['m4', 150, 'member'], ['m5', 200, 'member'],
		])
		const key = coordAt(90)
		expect(store.neighborsRight(key, 3, member)).to.deep.equal(store.neighborsRight(key, 3))
		expect(store.neighborsLeft(key, 3, member)).to.deep.equal(store.neighborsLeft(key, 3))
		expect(assembleCohort(store, key, 4, undefined, member)).to.deep.equal(assembleCohort(store, key, 4))
		expect(estimateSizeAndConfidence(store, 4, member).n).to.equal(estimateSizeAndConfidence(store, 4).n)
	})

	// Simulator / standalone exports default to no filter and count every entry regardless of
	// membership, so direct store users (membership unset → all 'unknown') are unaffected.
	it('standalone exports are unchanged when membership is unset', () => {
		const store = new DigitreeStore()
		store.upsert('a', coordAt(40))
		store.upsert('b', coordAt(120)) // both default to 'unknown'

		expect(assembleCohort(store, coordAt(80), 2)).to.have.length(2)
		expect(estimateSizeAndConfidence(store, 2).n).to.be.greaterThan(0)

		// But a member-scoped read sees nothing while both are unclassified.
		expect(assembleCohort(store, coordAt(80), 2, undefined, member)).to.have.length(0)
		expect(estimateSizeAndConfidence(store, 2, member).n).to.equal(0)
	})
})

describe('Ring membership classification (probe-based, no identify)', function () {
	this.timeout(30000)

	let nodes: Libp2p[] = []
	let services: CoreFretService[] = []

	afterEach(async () => {
		for (const s of services) {
			if (!s) continue
			try { await s.stop() } catch {}
		}
		await stopAll(nodes.filter(Boolean))
		nodes = []
		services = []
	})

	it('labels a same-network peer member, a foreign-network peer foreign, and self member', async () => {
		// Two FRET networks share the same transport: A and C run 'net-a', B runs 'net-b'.
		// All three are libp2p-connected through A, but B never serves net-a's namespaced
		// FRET protocol.
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		const nodeC = await createMemNode(); await nodeC.start()
		nodes = [nodeA, nodeB, nodeC]

		const svcA = new CoreFretService(nodeA, { profile: 'core', networkName: 'net-a' })
		const svcB = new CoreFretService(nodeB, { profile: 'core', networkName: 'net-b' })
		const svcC = new CoreFretService(nodeC, { profile: 'core', networkName: 'net-a' })
		services = [svcA, svcB, svcC]
		await svcA.start(); await svcB.start(); await svcC.start()

		// Connect B and C into A AFTER services start so the peer:connect listener is
		// already attached and populates A's store with both peers.
		await nodeB.dial(nodeA.getMultiaddrs()[0]!)
		await nodeC.dial(nodeA.getMultiaddrs()[0]!)

		// Several passive stabilization ticks (1.5s each) run the probe pass.
		await new Promise((r) => setTimeout(r, 6000))

		const store = svcA.getStore()
		const idA = nodeA.peerId.toString()
		const idB = nodeB.peerId.toString()
		const idC = nodeC.peerId.toString()

		expect(store.getById(idA)?.membership).to.equal('member', 'self should be member')
		expect(store.getById(idC)?.membership).to.equal('member', 'same-network peer C should be member')
		expect(store.getById(idB)?.membership).to.equal('foreign', 'foreign-network peer B should be foreign')
	})

	it('excludes the foreign peer from net-a ring, cohort, size estimate, and discovery; admits the same-network peer', async () => {
		// Same topology as above: A and C run 'net-a', B runs 'net-b', all connected through A.
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		const nodeC = await createMemNode(); await nodeC.start()
		nodes = [nodeA, nodeB, nodeC]

		const svcA = new CoreFretService(nodeA, { profile: 'core', networkName: 'net-a', k: 7, m: 4 })
		const svcB = new CoreFretService(nodeB, { profile: 'core', networkName: 'net-b', k: 7, m: 4 })
		const svcC = new CoreFretService(nodeC, { profile: 'core', networkName: 'net-a', k: 7, m: 4 })
		services = [svcA, svcB, svcC]
		await svcA.start(); await svcB.start(); await svcC.start()

		await nodeB.dial(nodeA.getMultiaddrs()[0]!)
		await nodeC.dial(nodeA.getMultiaddrs()[0]!)

		await new Promise((r) => setTimeout(r, 6000))

		const store = svcA.getStore()
		const idA = nodeA.peerId.toString()
		const idB = nodeB.peerId.toString()
		const idC = nodeC.peerId.toString()

		// Precondition: classification has resolved (mirrors the labeling test above).
		expect(store.getById(idB)?.membership).to.equal('foreign')
		expect(store.getById(idC)?.membership).to.equal('member')

		const selfCoord = await hashPeerId(nodeA.peerId)

		// Neighbor set / ring: same-network peer C and self present, foreign peer B absent.
		const neighbors = svcA.getNeighbors(selfCoord, 'both', 8)
		expect(neighbors).to.include(idC, 'same-network peer C should be a neighbor')
		expect(neighbors).to.include(idA, 'self should be present in the ring')
		expect(neighbors).to.not.include(idB, 'foreign peer B must not be a neighbor')

		// Cohort: foreign B is never a cohort member.
		const cohort = svcA.assembleCohort(selfCoord, 7)
		expect(cohort).to.include(idC)
		expect(cohort).to.not.include(idB, 'foreign peer B must not be in the cohort')

		// Size estimate: B must not inflate n_est. The member-scoped estimate equals an
		// estimate over a store holding only the net-a members (A + C).
		const memberOnly = new DigitreeStore()
		memberOnly.upsert(idA, await hashPeerId(nodeA.peerId))
		memberOnly.upsert(idC, await hashPeerId(nodeC.peerId))
		const expectedN = estimateSizeAndConfidence(memberOnly, 4).n
		const scopedN = estimateSizeAndConfidence(store, 4, (e) => e.membership === 'member').n
		expect(scopedN).to.equal(expectedN, 'foreign peer must not inflate n_est')

		// Discovery emission: the scan surfaces C, never B.
		const disc = new FretPeerDiscovery(store, { emissionIntervalMs: 200, batchSize: 20, debounceMs: 60_000 })
		const emitted: string[] = []
		const handler = (evt: CustomEvent<{ id: { toString(): string } }>) => emitted.push(evt.detail.id.toString())
		disc.addEventListener('peer', handler)
		await disc.start()
		await new Promise((r) => setTimeout(r, 400))
		disc.removeEventListener('peer', handler)
		await disc.stop()

		expect(emitted).to.include(idC, 'same-network peer C should be discoverable')
		expect(emitted).to.not.include(idB, 'foreign peer B must never be surfaced to discovery')
	})

	// Gating excludes foreign peers from the ring, so `probeNeighborsLatency` no longer pings
	// them — the path that used to self-heal a *mislabeled* same-network peer. The foreign
	// re-probe pass is the replacement backstop: a same-network peer tagged `foreign` here
	// (standing in for an identify-race mislabel) must be re-admitted to `member` via RPC.
	//
	// We tag C foreign as soon as it appears in A's store — i.e. *before* the unknown-probe
	// pass would ping it — so the eventual re-admitting ping is delivered by the foreign
	// re-probe pass, which is exactly the path under test.
	it('re-admits a same-network peer that was mislabeled foreign (foreign re-probe)', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeC = await createMemNode(); await nodeC.start()
		nodes = [nodeA, nodeC]

		const svcA = new CoreFretService(nodeA, { profile: 'core', networkName: 'net-a' })
		const svcC = new CoreFretService(nodeC, { profile: 'core', networkName: 'net-a' })
		services = [svcA, svcC]
		await svcA.start(); await svcC.start()

		const store = svcA.getStore()
		const idC = nodeC.peerId.toString()

		await nodeC.dial(nodeA.getMultiaddrs()[0]!)

		// As soon as A's peer:connect listener inserts C (as `unknown`), tag it `foreign`,
		// standing in for an identify race that mislabeled a genuine net-a peer.
		const deadline = Date.now() + 4000
		while (Date.now() < deadline && !store.getById(idC)) {
			await new Promise((r) => setTimeout(r, 20))
		}
		expect(store.getById(idC), 'C should appear in A\'s store after dial').to.not.equal(undefined)
		store.setMembership(idC, 'foreign')
		expect(store.getById(idC)?.membership).to.equal('foreign')

		// A few stabilization ticks run the foreign re-probe, whose successful ping re-admits C.
		await new Promise((r) => setTimeout(r, 6000))
		expect(store.getById(idC)?.membership).to.equal('member', 'mislabeled member should be re-admitted via foreign re-probe')
	})

	it('marks self member even with zero peers (single-node dev)', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		nodes = [nodeA]
		const svcA = new CoreFretService(nodeA, { profile: 'core', networkName: 'solo' })
		services = [svcA]
		await svcA.start()
		await new Promise((r) => setTimeout(r, 2000))
		expect(svcA.getStore().getById(nodeA.peerId.toString())?.membership).to.equal('member')
	})
})
