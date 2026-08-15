import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode } from './helpers/libp2p.js'
import { FretService } from '../src/service/fret-service.js'
import type { SerializedPeerEntry, SerializedTable } from '../src/store/digitree-store.js'
import { coordToBase64url } from '../src/ring/hash.js'

// `DigitreeStore.importEntries` replaces by id, which is what keeps a coordinate move from
// stranding a second tree entry for the same peer. That semantic has one consequence the
// store cannot see: the snapshot also carries a record for the *importing node itself*, and
// self's entry is the one entry the local node knows better than any snapshot does. These
// tests pin the service-level rule that drops it — the store-level seam is covered by
// `digitree.invariants.spec.ts`.

const NETWORK = 'table-persistence-test'

function serializedPeer(id: string, coordByte: number, over: Partial<SerializedPeerEntry> = {}): SerializedPeerEntry {
	const coord = new Uint8Array(32)
	coord[0] = coordByte
	return {
		id,
		coord: coordToBase64url(coord),
		relevance: 1,
		lastAccess: 0,
		state: 'connected',
		membership: 'member',
		accessCount: 0,
		successCount: 0,
		failureCount: 0,
		avgLatencyMs: 0,
		...over,
	}
}

function tableOf(entries: SerializedPeerEntry[]): SerializedTable {
	return { v: 1, peerId: 'exporter', timestamp: Date.now(), entries }
}

function entryFor(svc: FretService, id: string): SerializedPeerEntry {
	const found = svc.exportTable().entries.find((e) => e.id === id)
	if (!found) throw new Error(`no exported entry for ${id}`)
	return found
}

describe('FretService routing-table import', function () {
	this.timeout(30000)

	let node: Libp2p
	let peerNode: Libp2p
	let svc: FretService
	let selfId: string
	let otherId: string

	beforeEach(async () => {
		node = await createMemNode()
		peerNode = await createMemNode()
		await node.start()
		svc = new FretService(node, { networkName: NETWORK })
		await svc.start()
		selfId = node.peerId.toString()
		otherId = peerNode.peerId.toString()
	})

	afterEach(async () => {
		try { await svc.stop() } catch { /* already stopped */ }
		try { await node.stop() } catch { /* already stopped */ }
		try { await peerNode.stop() } catch { /* already stopped */ }
	})

	it('restores the snapshot peers and reports how many ids it stored', () => {
		const stored = svc.importTable(tableOf([serializedPeer(otherId, 40)]))

		expect(stored).to.equal(1)
		const restored = entryFor(svc, otherId)
		expect(restored.membership).to.equal('member')
		// Liveness cannot survive a restart, so an imported entry is always disconnected.
		expect(restored.state).to.equal('disconnected')
	})

	it('ignores a snapshot record for self rather than letting it overwrite the live entry', () => {
		const before = entryFor(svc, selfId)
		expect(before.membership, 'self is seeded as a member of its own network').to.equal('member')

		// A snapshot taken by another peer, or one predating the membership field: self shows
		// up labelled `unknown` and — if the file was corrupted or hand-edited — at a
		// coordinate that is not the hash of self's peer id.
		const bogusCoord = coordToBase64url(new Uint8Array(32).fill(7))
		const stored = svc.importTable(
			tableOf([
				serializedPeer(selfId, 0, { membership: 'unknown', coord: bogusCoord }),
				serializedPeer(otherId, 40),
			])
		)

		// Self's record is dropped, so it is not counted among the ids stored.
		expect(stored, 'self excluded from the stored count').to.equal(1)

		const after = entryFor(svc, selfId)
		// An `unknown` self is excluded from every member-only ring view; a moved self is no
		// longer protected from capacity eviction around its own coordinate.
		expect(after.membership, 'self still a member').to.equal('member')
		expect(after.coord, 'self still at its own ring coordinate').to.equal(before.coord)
	})

	it('round-trips its own export without duplicating or demoting self', () => {
		svc.importTable(tableOf([serializedPeer(otherId, 40)]))

		const exported = svc.exportTable()
		expect(exported.entries.map((e) => e.id).sort()).to.deep.equal([selfId, otherId].sort())

		// Re-importing an export of this very table must be a no-op on the population: import
		// replaces by id, and self's record is dropped, so nothing is added and nothing moves.
		const stored = svc.importTable(exported)

		expect(stored, 'every id but self re-stored').to.equal(exported.entries.length - 1)
		const after = svc.exportTable()
		expect(after.entries.map((e) => e.id).sort()).to.deep.equal(exported.entries.map((e) => e.id).sort())
		expect(entryFor(svc, selfId).membership).to.equal('member')
	})
})
