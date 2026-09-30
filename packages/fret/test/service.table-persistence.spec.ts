import { describe, it, before, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { PeerId, PrivateKey } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { PeerRecord, RecordEnvelope } from '@libp2p/peer-record'
import { multiaddr } from '@multiformats/multiaddr'
import { fromString as u8FromString } from 'uint8arrays/from-string'
import { toString as u8ToString } from 'uint8arrays/to-string'
import { createIdentifyMemNode, createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService } from '../src/service/fret-service.js'
import { ADDRESS_RECORD_PERSIST_MAX_AGE_MS } from '../src/service/address-records.js'
import type { SerializedAddressRecord, SerializedPeerEntry, SerializedTable } from '../src/store/digitree-store.js'
import { coordToBase64url } from '../src/ring/hash.js'
import { serializedPeer, tableOf } from './helpers/serialized-table.js'

// `DigitreeStore.importEntries` replaces by id, which is what keeps a coordinate move from
// stranding a second tree entry for the same peer. That semantic has one consequence the
// store cannot see: the snapshot also carries a record for the *importing node itself*, and
// self's entry is the one entry the local node knows better than any snapshot does. These
// tests pin the service-level rule that drops it — the store-level seam is covered by
// `digitree.invariants.spec.ts`.
//
// Import also runs capacity enforcement, and this file covers only the coarse arm of that
// (an oversized bulk import is trimmed to the cap). *Which* peers survive — neighbor
// protection around self, dead/foreign/unknown peers losing it, self never being a victim —
// lives in `relevance.eviction.spec.ts`; add victim-selection cases there, not here.

const NETWORK = 'table-persistence-test'

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

// The table also carries each peer's signed address record, so a restarted node's first dials
// already have addresses (gotchoices/sereus#18). The store serializes the field mechanically — its
// structural rows are in `digitree.persistence.spec.ts`, its round trip in
// `rpc.codec-properties.spec.ts` — and this pins what the service adds on top: the records reach
// libp2p's peerStore on import, and what a damaged, altered or stale record costs.
describe('FretService routing-table import — address records', function () {
	this.timeout(30000)

	/** Addresses a node's peerStore holds for `peer`; `[]` when it has never heard of it. */
	async function addressesOf(node: Libp2p, peer: PeerId): Promise<string[]> {
		try {
			return (await node.peerStore.get(peer)).addresses.map((a) => a.multiaddr.toString())
		} catch (err) {
			if ((err as { name?: string }).name === 'NotFoundError') return []
			throw err
		}
	}

	async function dialError(node: Libp2p, peer: PeerId): Promise<Error | undefined> {
		try {
			await node.dial(peer)
			return undefined
		} catch (err) {
			return err as Error
		}
	}

	/** base64url envelope over a record *about* `subject`, signed by `signer` — sequence number 1,
	 *  so older than any record libp2p's identify seals. */
	async function sealed(signer: PrivateKey, subject: PeerId): Promise<string> {
		const record = new PeerRecord({ peerId: subject, multiaddrs: [multiaddr('/ip4/127.0.0.1/tcp/4001')], seqNumber: 1n })
		return u8ToString((await RecordEnvelope.seal(record, signer)).marshal(), 'base64url')
	}

	async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
			await new Promise<void>((resolve) => setTimeout(resolve, 20))
		}
	}

	it('a restarted node dials a peer it knew only from its saved table, with no exchange first', async () => {
		const keyA = await generateKeyPair('Ed25519')
		const a = await createIdentifyMemNode(keyA)
		const b = await createIdentifyMemNode()
		const nodes: Libp2p[] = [a, b]
		try {
			const svcA = new FretService(a, { networkName: NETWORK })
			await svcA.start()
			const idB = b.peerId.toString()
			await a.dial(b.getMultiaddrs()[0]!)
			// identify stores B's signed record in A's peerStore; FRET mirrors it onto B's entry.
			await waitFor('B\'s record on A\'s entry', () => svcA.getStore().getById(idB)?.addressRecord !== undefined)
			// Through JSON, as a caller persisting the table would.
			const saved = JSON.parse(JSON.stringify(svcA.exportTable())) as SerializedTable
			expect(saved.entries.find((e) => e.id === idB)?.addressRecord, 'B exported with its record').to.not.equal(undefined)
			await svcA.stop()
			await a.stop()

			// Same identity, fresh peerStore, and a FRET service that never starts — so nothing but
			// the imported table can have told this node where B is.
			const restarted = await createIdentifyMemNode(keyA)
			nodes.push(restarted)
			const svcRestarted = new FretService(restarted, { networkName: NETWORK })

			// Negative control: the same table without the record restores B's entry and leaves B
			// undialable — the record is the only thing that differs between the two imports.
			const stripped: SerializedTable = { ...saved, entries: saved.entries.map(({ addressRecord: _r, ...rest }) => rest) }
			await svcRestarted.importTable(stripped)
			expect(svcRestarted.getStore().getById(idB), 'B restored').to.not.equal(undefined)
			expect((await dialError(restarted, b.peerId))?.name, 'no address for B').to.equal('NoValidAddressesError')

			await svcRestarted.importTable(saved)
			expect(await dialError(restarted, b.peerId), 'dials B from the restored record').to.equal(undefined)
		} finally {
			await stopAll(nodes)
		}
	})

	// An import after `start()` replaces a live entry with the file's copy; when libp2p already
	// holds a newer record the entry must come back to that one, not keep forwarding the file's.
	it('an entry whose imported record is older than the peerStore one adopts the peerStore one', async () => {
		const keyB = await generateKeyPair('Ed25519')
		const a = await createIdentifyMemNode()
		const b = await createIdentifyMemNode(keyB)
		try {
			const svcA = new FretService(a, { networkName: NETWORK })
			await svcA.start()
			const idB = b.peerId.toString()
			await a.dial(b.getMultiaddrs()[0]!)
			await waitFor('B\'s record on A\'s entry', () => svcA.getStore().getById(idB)?.addressRecord !== undefined)
			const live = svcA.getStore().getById(idB)!.addressRecord!.envelope

			await svcA.importTable(tableOf([serializedPeer(idB, 20, { addressRecord: { envelope: await sealed(keyB, b.peerId), confirmedAt: Date.now() } })]))

			expect(u8ToString(svcA.getStore().getById(idB)!.addressRecord!.envelope, 'base64url')).to.equal(u8ToString(live, 'base64url'))
			await svcA.stop()
		} finally {
			await stopAll([a, b])
		}
	})

	describe('a damaged, altered or stale record', () => {
		let keyG: PrivateKey
		let keyB: PrivateKey
		let keyC: PrivateKey
		let pidG: PeerId
		let pidB: PeerId
		let pidC: PeerId

		before(async () => {
			[keyG, keyB, keyC] = await Promise.all([generateKeyPair('Ed25519'), generateKeyPair('Ed25519'), generateKeyPair('Ed25519')])
			pidG = peerIdFromPrivateKey(keyG)
			pidB = peerIdFromPrivateKey(keyB)
			pidC = peerIdFromPrivateKey(keyC)
		})

		/** The signature is the envelope's last protobuf field: flipping the last byte leaves the
		 *  structure — and so the import pre-pass — intact, and fails only the verification. */
		function tampered(envelope: string): string {
			const bytes = u8FromString(envelope, 'base64url')
			bytes[bytes.length - 1]! ^= 0xff
			return u8ToString(bytes, 'base64url')
		}

		type Outcome = 'refused' | 'stripped' | 'dropped'

		it('refuses the table for a corrupt record, strips a forged signature, drops a stale record', async () => {
			const now = Date.now()
			const genuineB = await sealed(keyB, pidB)
			const rows: Array<[string, SerializedAddressRecord, Outcome]> = [
				['an envelope that is not a signed peer record', { envelope: u8ToString(new Uint8Array([1, 2, 3]), 'base64url'), confirmedAt: now }, 'refused'],
				['a record about B signed by C', { envelope: await sealed(keyC, pidB), confirmedAt: now }, 'refused'],
				['a genuine record for C, labelled B', { envelope: await sealed(keyC, pidC), confirmedAt: now }, 'refused'],
				['a record whose signature does not verify', { envelope: tampered(genuineB), confirmedAt: now }, 'stripped'],
				['a record past the persist age', { envelope: genuineB, confirmedAt: now - ADDRESS_RECORD_PERSIST_MAX_AGE_MS - 60_000 }, 'dropped'],
			]
			const good = serializedPeer(pidG.toString(), 10, { addressRecord: { envelope: await sealed(keyG, pidG), confirmedAt: now } })

			for (const [what, addressRecord, outcome] of rows) {
				// A fresh node per row: every import that is not refused puts the good record in the
				// peerStore, and a refused row has to show it did not.
				const node = await createMemNode()
				try {
					const svc = new FretService(node, { networkName: NETWORK })
					const sizeBefore = svc.getStore().size()
					const rejectedBefore = svc.getDiagnostics().rejected.addressHint

					let err: unknown
					try {
						await svc.importTable(tableOf([good, serializedPeer(pidB.toString(), 20, { addressRecord })]))
					} catch (e) {
						err = e
					}

					if (outcome === 'refused') {
						expect(err, `${what}: import refused`).to.be.instanceOf(Error)
						expect(svc.getStore().size(), `${what}: nothing written`).to.equal(sizeBefore)
						expect(await addressesOf(node, pidG), `${what}: not even the good record consumed`).to.deep.equal([])
						continue
					}
					expect(err, `${what}: import stands`).to.equal(undefined)
					expect(svc.getStore().getById(pidB.toString()), `${what}: B restored`).to.not.equal(undefined)
					expect(svc.getStore().getById(pidB.toString())?.addressRecord, `${what}: B without its record`).to.equal(undefined)
					expect(await addressesOf(node, pidB), `${what}: nothing about B reached the peerStore`).to.deep.equal([])
					expect(await addressesOf(node, pidG), `${what}: the rest of the table consumed`).to.deep.equal(['/ip4/127.0.0.1/tcp/4001'])
					expect(svc.getDiagnostics().rejected.addressHint - rejectedBefore, `${what}: counted only when altered`)
						.to.equal(outcome === 'stripped' ? 1 : 0)
				} finally {
					await stopAll([node])
				}
			}
		})
	})
})
