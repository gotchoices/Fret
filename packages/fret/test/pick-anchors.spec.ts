import { describe, it } from 'mocha'
import { createMemoryNode } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { hashKey } from '../src/ring/hash.js'
import { fromString as u8FromString } from 'uint8arrays/from-string'
import { toString as u8ToString } from 'uint8arrays/to-string'

// Regression coverage for a bug where anchor selection measured distance from the
// all-zero ring coordinate instead of from the key's own coordinate, biasing results
// toward peers with numerically small coordinates rather than the peers actually
// nearest the key.

describe('pickAnchors targets the key coordinate, not zero', function () {
	this.timeout(10000)

	it('picks the peer closest to the key over one closest to coordinate zero', async () => {
		const node = await createMemoryNode()
		await node.start()
		const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
		const s: any = svc

		const keyCoord = await hashKey(u8FromString('pick-anchors-regression', 'utf8'))

		// Numerically tiny coordinate: closest possible peer to the all-zero vector the bug used.
		const nearZeroCoord = new Uint8Array(32)
		nearZeroCoord[31] = 1
		s.store.upsert('near-zero', nearZeroCoord)

		// Genuinely closest peer to the key: one bit flipped from the key's own coordinate.
		const trueNearestCoord = Uint8Array.from(keyCoord)
		trueNearestCoord[31] ^= 0x01
		s.store.upsert('true-nearest', trueNearestCoord)

		// Decoys, far from both the key and zero.
		const decoyA = new Uint8Array(32).fill(0x77)
		const decoyB = new Uint8Array(32).fill(0x99)
		s.store.upsert('decoy-a', decoyA)
		s.store.upsert('decoy-b', decoyB)

		const anchors: string[] = s.pickAnchors(
			['near-zero', 'true-nearest', 'decoy-a', 'decoy-b'],
			keyCoord
		)

		if (anchors[0] !== 'true-nearest') {
			throw new Error(`expected true-nearest peer as primary anchor, got ${JSON.stringify(anchors)}`)
		}

		await node.stop()
	})

	it('routeAct NearAnchor reply favors the key\'s nearest peer end-to-end', async () => {
		const node = await createMemoryNode()
		await node.start()
		const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
		const s: any = svc

		const keyBytes = u8FromString('pick-anchors-regression-e2e', 'utf8')
		const keyCoord = await hashKey(keyBytes)

		// Two peers with numerically tiny coordinates — under the zero-coordinate bug these
		// fill both anchor slots and crowd out the peer actually nearest the key.
		const nearZeroCoord = new Uint8Array(32)
		nearZeroCoord[31] = 2
		s.store.upsert('near-zero', nearZeroCoord)
		s.store.setMembership('near-zero', 'member')

		const nearZeroCoord2 = new Uint8Array(32)
		nearZeroCoord2[31] = 4
		s.store.upsert('near-zero-2', nearZeroCoord2)
		s.store.setMembership('near-zero-2', 'member')

		const trueNearestCoord = Uint8Array.from(keyCoord)
		trueNearestCoord[0] ^= 0x01
		s.store.upsert('true-nearest', trueNearestCoord)
		s.store.setMembership('true-nearest', 'member')

		const msg = {
			v: 1,
			key: u8ToString(keyBytes, 'base64url'),
			want_k: 7,
			wants: 2,
			ttl: 0,
			min_sigs: 3,
			breadcrumbs: [] as string[],
			correlation_id: 'pick-anchors-e2e',
			timestamp: Date.now(),
			signature: ''
		}

		const res = await svc.routeAct(msg as any)
		if (!('anchors' in res)) throw new Error('expected NearAnchor response')
		if ((res as any).anchors[0] !== 'true-nearest') {
			throw new Error(`expected true-nearest as primary anchor, got ${JSON.stringify((res as any).anchors)}`)
		}

		await node.stop()
	})
})
