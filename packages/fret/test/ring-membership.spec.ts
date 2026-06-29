import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { isUnsupportedProtocolError } from '../src/rpc/protocols.js'
import type { Libp2p } from 'libp2p'

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
