import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import type { NeighborSnapshotV1 } from '../src/index.js'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { toString as u8ToString } from 'uint8arrays/to-string'

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

async function makePeerIds(n: number): Promise<string[]> {
	const ids: string[] = []
	for (let i = 0; i < n; i++) {
		const key = await generateKeyPair('Ed25519')
		ids.push(peerIdFromPrivateKey(key).toString())
	}
	return ids
}

/** Valid base64url encoding of a distinct 32-byte ring coordinate. */
function coord32(seed: number): string {
	const b = new Uint8Array(32)
	b[0] = (seed + 1) & 0xff
	b[1] = (seed * 7 + 3) & 0xff
	b[2] = (seed * 31 + 17) & 0xff
	return u8ToString(b, 'base64url')
}

function makeSnapshot(from: string, opts: { successors?: string[]; predecessors?: string[]; sampleCount?: number } = {}): NeighborSnapshotV1 {
	const sample = Array.from({ length: opts.sampleCount ?? 0 }, (_v, i) => ({
		id: `sample-${from.slice(-6)}-${i}`,
		coord: coord32(i),
		relevance: 0,
	}))
	return {
		v: 1,
		from,
		timestamp: Date.now(),
		successors: opts.successors ?? [],
		predecessors: opts.predecessors ?? [],
		sample,
		sig: '',
	}
}

/** Drain a token bucket, returning how many whole tokens it held (its capacity). */
function drainBucket(bucket: { tryTake(cost?: number): boolean }): number {
	let taken = 0
	while (bucket.tryTake()) taken++
	return taken
}

/**
 * Unit-level coverage of the inbound-announce rate limit (token bucket) and the per-message
 * caps applied when merging a received announce. These drive the private handlers directly so
 * the assertions are deterministic (no reliance on stabilization timing).
 */
describe('inbound announce rate limiting + merge caps', function () {
	this.timeout(30000)

	it('drops an announce when the inbound bucket is exhausted and increments the rate-limited counter', async () => {
		const node = await createMemNode(); await node.start()
		const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
		try {
			// Exhaust the inbound-announce bucket directly, then the next announce must be dropped.
			drainBucket((svc as any).bucketAnnounceInbound)

			const before = svc.getDiagnostics().rejected.rateLimited
			const sizeBefore = svc.getStore().size()

			;(svc as any).handleAnnounce('some-peer', makeSnapshot('some-peer', { sampleCount: 4 }))
			// Merge is skipped synchronously on rejection; allow any (non-)microtasks to settle.
			await delay(50)

			expect(svc.getDiagnostics().rejected.rateLimited - before, 'rateLimited delta').to.equal(1)
			expect(svc.getStore().size(), 'store must not grow when dropped').to.equal(sizeBefore)
		} finally {
			await stopAll([node])
		}
	})

	it('admits an announce while the bucket has tokens (merge runs, no rate-limited increment)', async () => {
		const node = await createMemNode(); await node.start()
		const svc = new CoreFretService(node, { profile: 'core', k: 7 })
		try {
			const [from] = await makePeerIds(1)
			const succ = await makePeerIds(2)
			const before = svc.getDiagnostics().rejected.rateLimited
			const sizeBefore = svc.getStore().size()

			;(svc as any).handleAnnounce(from, makeSnapshot(from, { successors: succ }))
			await delay(50)

			expect(svc.getDiagnostics().rejected.rateLimited - before, 'no rate-limited increment').to.equal(0)
			// from + 2 successors ingested
			expect(svc.getStore().size() - sizeBefore, 'entries merged').to.equal(3)
		} finally {
			await stopAll([node])
		}
	})

	it('edge inbound-announce bucket capacity is lower than core', async () => {
		const nodeE = await createMemNode()
		const nodeC = await createMemNode()
		const svcE = new CoreFretService(nodeE, { profile: 'edge', k: 7 })
		const svcC = new CoreFretService(nodeC, { profile: 'core', k: 7 })
		try {
			const edgeCap = drainBucket((svcE as any).bucketAnnounceInbound)
			const coreCap = drainBucket((svcC as any).bucketAnnounceInbound)
			expect(edgeCap, 'edge capacity').to.be.lessThan(coreCap)
		} finally {
			await stopAll([nodeE, nodeC])
		}
	})

	it('caps a core announce to 16 successors / 16 predecessors / 8 sample', async () => {
		const node = await createMemNode(); await node.start()
		const svc = new CoreFretService(node, { profile: 'core', k: 7 })
		try {
			const [from] = await makePeerIds(1)
			const succ = await makePeerIds(30)
			const pred = await makePeerIds(30)
			const snap = makeSnapshot(from, { successors: succ, predecessors: pred, sampleCount: 20 })

			await (svc as any).mergeAnnounceSnapshot(from, snap)

			// from(1) + capped 16 + 16 + 8 = 41; uncapped would be 1 + 30 + 30 + 20 = 81.
			expect(svc.getStore().size()).to.equal(41)
		} finally {
			await stopAll([node])
		}
	})

	it('caps an edge announce to 8 successors / 8 predecessors / 6 sample', async () => {
		const node = await createMemNode(); await node.start()
		const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
		try {
			const [from] = await makePeerIds(1)
			const succ = await makePeerIds(30)
			const pred = await makePeerIds(30)
			const snap = makeSnapshot(from, { successors: succ, predecessors: pred, sampleCount: 20 })

			await (svc as any).mergeAnnounceSnapshot(from, snap)

			// from(1) + capped 8 + 8 + 6 = 23
			expect(svc.getStore().size()).to.equal(23)
		} finally {
			await stopAll([node])
		}
	})

	it('announce merge caps match the neighbor-fetch merge caps (single source of truth)', async () => {
		// Both mergeAnnounceSnapshot and fetchAndMergeSnapshot consume mergeSnapshotCaps(),
		// so asserting the shared helper's values guarantees the two paths stay in lockstep.
		const nodeC = await createMemNode()
		const nodeE = await createMemNode()
		const svcC = new CoreFretService(nodeC, { profile: 'core', k: 7 })
		const svcE = new CoreFretService(nodeE, { profile: 'edge', k: 7 })
		try {
			expect((svcC as any).mergeSnapshotCaps()).to.deep.equal({ successors: 16, predecessors: 16, sample: 8 })
			expect((svcE as any).mergeSnapshotCaps()).to.deep.equal({ successors: 8, predecessors: 8, sample: 6 })
		} finally {
			await stopAll([nodeC, nodeE])
		}
	})
})
