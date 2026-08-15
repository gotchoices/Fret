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
		avgLatencyMs: null,
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

	it('restores the snapshot peers and reports how many ids it stored', async () => {
		const stored = await svc.importTable(tableOf([serializedPeer(otherId, 40)]))

		expect(stored).to.equal(1)
		const restored = entryFor(svc, otherId)
		expect(restored.membership).to.equal('member')
		// Liveness cannot survive a restart, so an imported entry is always disconnected.
		expect(restored.state).to.equal('disconnected')
	})

	it('ignores a snapshot record for self rather than letting it overwrite the live entry', async () => {
		const before = entryFor(svc, selfId)
		expect(before.membership, 'self is seeded as a member of its own network').to.equal('member')

		// A snapshot taken by another peer, or one predating the membership field: self shows
		// up labelled `unknown` and — if the file was corrupted or hand-edited — at a
		// coordinate that is not the hash of self's peer id.
		const bogusCoord = coordToBase64url(new Uint8Array(32).fill(7))
		const stored = await svc.importTable(
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

	it('round-trips its own export without duplicating or demoting self', async () => {
		await svc.importTable(tableOf([serializedPeer(otherId, 40)]))

		const exported = svc.exportTable()
		expect(exported.entries.map((e) => e.id).sort()).to.deep.equal([selfId, otherId].sort())

		// Re-importing an export of this very table must be a no-op on the population: import
		// replaces by id, and self's record is dropped, so nothing is added and nothing moves.
		const stored = await svc.importTable(exported)

		expect(stored, 'every id but self re-stored').to.equal(exported.entries.length - 1)
		const after = svc.exportTable()
		expect(after.entries.map((e) => e.id).sort()).to.deep.equal(exported.entries.map((e) => e.id).sort())
		expect(entryFor(svc, selfId).membership).to.equal('member')
	})
})

describe('FretService routing-table import before start()', function () {
	this.timeout(30000)

	// `enforceCapacity` protects up to `m` member neighbors on each side of self, so CAPACITY
	// must exceed 2m for eviction to be able to reach the cap at all.
	const M = 8
	const CAPACITY = 20
	const OVERSIZED = 40

	let node: Libp2p
	let svc: FretService

	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
		// Deliberately *not* started: `start()` is what hashes and caches self's ring coordinate,
		// and capacity enforcement needs that coordinate to know which neighbors to protect.
		svc = new FretService(node, { networkName: NETWORK, capacity: CAPACITY, m: M })
	})

	afterEach(async () => {
		try { await svc.stop() } catch { /* never started */ }
		try { await node.stop() } catch { /* already stopped */ }
	})

	it('enforces capacity on a bulk import that runs before the self coordinate is cached', async () => {
		// Relevance ascending with the coordinate so the survivors are identifiable: eviction
		// takes the lowest-relevance non-protected entries first.
		const oversized = Array.from({ length: OVERSIZED }, (_, i) =>
			serializedPeer(`peer-${i}`, i, { relevance: i })
		)

		const stored = await svc.importTable(tableOf(oversized))

		expect(stored, 'every record accepted by the store').to.equal(OVERSIZED)
		// The regression this pins: enforcement used to read the not-yet-hashed self coordinate
		// and return early, leaving all 40 entries in a table capped at 20.
		expect(svc.getStore().size(), 'trimmed to the configured capacity').to.equal(CAPACITY)
		// Trimming is by relevance, not arbitrary. Self's coordinate is a hash, so *which* peers
		// land in the protected neighbor window is not predictable — but that window holds at
		// most 2m ids, so the CAPACITY - 2m highest-relevance peers survive on relevance alone
		// whatever it contains.
		const survivors = svc.exportTable().entries.map((e) => e.id)
		const alwaysKept = Array.from({ length: CAPACITY - 2 * M }, (_, i) => `peer-${OVERSIZED - 1 - i}`)
		for (const id of alwaysKept) expect(survivors, `${id} kept on relevance`).to.include(id)
	})
})
