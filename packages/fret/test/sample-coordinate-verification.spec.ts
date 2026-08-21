import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import type { NeighborSnapshotV1 } from '../src/index.js'
import { hashPeerId, coordToBase64url, COORD_BYTES } from '../src/ring/hash.js'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id'

/**
 * A ring coordinate is *defined* as SHA-256(peerId.toMultihash().bytes), so it is derivable from
 * the peer id and the `coord` field a snapshot sample carries is at best a redundant copy.
 *
 * Trusting that copy was a free choice of ring position. A snapshot's successor / predecessor
 * lists have always been re-hashed from their ids, but the `sample` list was decoded straight
 * off the wire — so a transport-authenticated peer could name *any other* peer's id at *any*
 * coordinate it liked, with no id grinding, and that id would take its place in the local ring
 * as a neighbor, anchor and cohort member for keys it must never serve. Ring positions being
 * deterministic is the assumption the whole overlay rests on.
 *
 * Both inbound merge paths now re-hash. These tests spoof a coordinate and assert the stored
 * one is the hash of the id, not the value that arrived.
 */

async function makePeerId(): Promise<string> {
	const key = await generateKeyPair('Ed25519')
	return peerIdFromPrivateKey(key).toString()
}

/** A well-formed but wrong 32-byte coordinate: decodes cleanly, hashes to nothing. */
function spoofedCoord(fill: number): string {
	return coordToBase64url(new Uint8Array(COORD_BYTES).fill(fill))
}

function snapshotWithSample(
	from: string,
	sample: Array<{ id: string; coord: string; relevance: number }>,
): NeighborSnapshotV1 {
	return {
		v: 1,
		from,
		timestamp: Date.now(),
		successors: [],
		predecessors: [],
		sample,
		sig: '',
	}
}

describe('Sample coordinate verification', function () {
	this.timeout(10_000)

	it('re-hashes a spoofed sample coordinate on the announce path', async () => {
		const node = await createMemNode()
		await node.start()
		const svc = new CoreFretService(node, { profile: 'core', k: 7 })
		try {
			const from = await makePeerId()
			const victim = await makePeerId()
			const spoof = spoofedCoord(0xab)
			const truth = await hashPeerId(peerIdFromString(victim))

			// Sanity: the spoof must actually differ, or the test proves nothing.
			expect(coordToBase64url(truth), 'spoof must differ from the true coord').to.not.equal(spoof)

			await (svc as any).mergeAnnounceSnapshot(
				from,
				snapshotWithSample(from, [{ id: victim, coord: spoof, relevance: 0.9 }]),
			)

			const entry = svc.getStore().getById(victim)
			expect(entry, 'sample entry still merged').to.not.equal(undefined)
			expect(coordToBase64url(entry!.coord), 'stored coord must be the re-hash, not the wire value')
				.to.equal(coordToBase64url(truth))
		} finally {
			await stopAll([node])
		}
	})

	it('places the peer where its id hashes even when the spoof aims at a chosen ring region', async () => {
		// The attack this closes is positional: an all-zero coordinate parks the victim at the
		// very start of the ring, next to whatever key an attacker wants it to anchor. Pin that
		// the stored position is unrelated to the requested one.
		const node = await createMemNode()
		await node.start()
		const svc = new CoreFretService(node, { profile: 'core', k: 7 })
		try {
			const from = await makePeerId()
			const victim = await makePeerId()
			const zeros = coordToBase64url(new Uint8Array(COORD_BYTES))

			await (svc as any).mergeAnnounceSnapshot(
				from,
				snapshotWithSample(from, [{ id: victim, coord: zeros, relevance: 0.5 }]),
			)

			const entry = svc.getStore().getById(victim)!
			expect(coordToBase64url(entry.coord), 'must not land at the requested coordinate')
				.to.not.equal(zeros)
			expect(coordToBase64url(entry.coord)).to.equal(
				coordToBase64url(await hashPeerId(peerIdFromString(victim))),
			)
		} finally {
			await stopAll([node])
		}
	})

	it('drops a sample entry whose id is not a parseable peer id, and merges the rest', async () => {
		// The re-hash needs the id to parse. A junk id can no longer be smuggled in under a
		// valid-looking coordinate, and it must not take its neighbours down with it — the
		// per-entry try/catch is what keeps one bad entry from ending the merge loop.
		const node = await createMemNode()
		await node.start()
		const svc = new CoreFretService(node, { profile: 'core', k: 7 })
		try {
			const from = await makePeerId()
			const good = await makePeerId()

			await (svc as any).mergeAnnounceSnapshot(
				from,
				snapshotWithSample(from, [
					{ id: 'not-a-peer-id', coord: spoofedCoord(0x11), relevance: 0.9 },
					{ id: good, coord: spoofedCoord(0x22), relevance: 0.1 },
				]),
			)

			expect(svc.getStore().getById('not-a-peer-id'), 'unparseable id must not be stored')
				.to.equal(undefined)
			const entry = svc.getStore().getById(good)
			expect(entry, 'the entry behind it still merges').to.not.equal(undefined)
			expect(coordToBase64url(entry!.coord)).to.equal(
				coordToBase64url(await hashPeerId(peerIdFromString(good))),
			)
		} finally {
			await stopAll([node])
		}
	})

	it('a later spoof cannot move a peer already at its true coordinate', async () => {
		// `upsert` refreshes an existing entry's coordinate, so a re-key is exactly what a
		// repeated announce would have achieved before this change.
		const node = await createMemNode()
		await node.start()
		const svc = new CoreFretService(node, { profile: 'core', k: 7 })
		try {
			const from = await makePeerId()
			const victim = await makePeerId()
			const truth = coordToBase64url(await hashPeerId(peerIdFromString(victim)))

			await (svc as any).mergeAnnounceSnapshot(
				from,
				snapshotWithSample(from, [{ id: victim, coord: truth, relevance: 0.5 }]),
			)
			await (svc as any).mergeAnnounceSnapshot(
				from,
				snapshotWithSample(from, [{ id: victim, coord: spoofedCoord(0xff), relevance: 0.9 }]),
			)

			expect(coordToBase64url(svc.getStore().getById(victim)!.coord)).to.equal(truth)
		} finally {
			await stopAll([node])
		}
	})
})
