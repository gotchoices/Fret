import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import type { NeighborSnapshotV1 } from '../src/index.js'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

async function makePeerId(): Promise<string> {
	const key = await generateKeyPair('Ed25519')
	return peerIdFromPrivateKey(key).toString()
}

function snapshotWithMetadata(from: string, metadata: unknown): NeighborSnapshotV1 {
	return {
		v: 1,
		from,
		timestamp: Date.now(),
		successors: [],
		predecessors: [],
		sample: [],
		sig: '',
		// Deliberately bypasses the declared type: the point of these tests is that wire JSON
		// can carry a shape the interface says is impossible.
		metadata: metadata as Record<string, unknown>,
	}
}

/**
 * `NeighborSnapshotV1.metadata` is decoded from untrusted wire JSON, so its declared
 * `Record<string, unknown>` is a claim rather than a fact. The merge stores it against the
 * sender's routing-table entry only when it is a non-array object; anything else is dropped,
 * so `getMetadata` never returns a value of an unrepresentable shape.
 */
describe('Announce metadata — shape guard', function () {
	this.timeout(10_000)

	it('stores a plain-object metadata blob against the sender', async () => {
		const node = await createMemNode(); await node.start()
		const svc = new CoreFretService(node, { profile: 'core', k: 7 })
		try {
			const from = await makePeerId()
			await (svc as any).mergeAnnounceSnapshot(from, snapshotWithMetadata(from, { role: 'validator', version: 3 }))

			const stored = svc.getMetadata(from)
			expect(stored, 'metadata stored').to.deep.equal({ role: 'validator', version: 3 })
		} finally {
			await stopAll([node])
		}
	})

	for (const [label, value] of [
		['an array', ['not', 'an', 'object']],
		['a string', 'not-an-object'],
		['a number', 42],
	] as Array<[string, unknown]>) {
		it(`drops metadata that is ${label}, and still merges the sender`, async () => {
			const node = await createMemNode(); await node.start()
			const svc = new CoreFretService(node, { profile: 'core', k: 7 })
			try {
				const from = await makePeerId()
				await (svc as any).mergeAnnounceSnapshot(from, snapshotWithMetadata(from, value))

				expect(svc.getMetadata(from), 'metadata must be dropped').to.equal(undefined)
				// The rest of the announce is unaffected — a bad metadata field is not a bad message.
				expect(svc.getStore().getById(from), 'sender still merged').to.not.equal(undefined)
			} finally {
				await stopAll([node])
			}
		})
	}

	it('leaves an existing metadata blob untouched when a later announce carries a bad shape', async () => {
		const node = await createMemNode(); await node.start()
		const svc = new CoreFretService(node, { profile: 'core', k: 7 })
		try {
			const from = await makePeerId()
			await (svc as any).mergeAnnounceSnapshot(from, snapshotWithMetadata(from, { role: 'validator' }))
			await (svc as any).mergeAnnounceSnapshot(from, snapshotWithMetadata(from, 'garbage'))

			expect(svc.getMetadata(from)).to.deep.equal({ role: 'validator' })
		} finally {
			await stopAll([node])
		}
	})
})
