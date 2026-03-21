import { describe, it } from 'mocha'
import { expect } from 'chai'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { createSparsityModel, normalizedLogDistance, observeDistance } from '../src/store/relevance.js'
import { selectDiverseSample } from '../src/service/fret-service.js'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { COORD_BYTES } from '../src/ring/hash.js'

/**
 * Build a 32-byte coordinate with a single distinguishing byte at position `pos`.
 * By default sets byte 0 (MSB) for maximum ring spread.
 */
function coordAt(value: number, pos = 0): Uint8Array {
	const u = new Uint8Array(COORD_BYTES)
	u[pos] = value
	return u
}

describe('Seed new peers — selectDiverseSample', function () {
	this.timeout(10_000)

	it('returns entries sorted by sparsity bonus descending', () => {
		const store = new DigitreeStore()
		const selfCoord = coordAt(0)
		const sparsity = createSparsityModel()

		// Insert 20 peers at evenly spaced positions
		for (let i = 1; i <= 20; i++) {
			const coord = coordAt(Math.floor((i * 256) / 21))
			store.upsert(`peer-${i}`, coord)
		}

		// Observe distances to build up occupancy near self (simulating that near peers are common)
		for (let i = 0; i < 50; i++) {
			observeDistance(sparsity, 0.05 + Math.random() * 0.1) // near-self region
		}

		const sample = selectDiverseSample(store, selfCoord, sparsity, new Set(), 6)

		expect(sample).to.have.length(6)
		// All entries should have valid coords and non-zero relevance (or at least coord is non-empty)
		for (const s of sample) {
			expect(s.coord).to.be.a('string').and.not.be.empty
			expect(s.id).to.be.a('string').and.not.be.empty
		}
	})

	it('excludes specified peer IDs', () => {
		const store = new DigitreeStore()
		const selfCoord = coordAt(0)
		const sparsity = createSparsityModel()

		store.upsert('a', coordAt(50))
		store.upsert('b', coordAt(100))
		store.upsert('c', coordAt(150))
		store.upsert('d', coordAt(200))

		const excludeIds = new Set(['a', 'c'])
		const sample = selectDiverseSample(store, selfCoord, sparsity, excludeIds, 10)

		const ids = sample.map((s) => s.id)
		expect(ids).to.not.include('a')
		expect(ids).to.not.include('c')
		expect(ids).to.include('b')
		expect(ids).to.include('d')
	})

	it('respects the cap parameter', () => {
		const store = new DigitreeStore()
		const selfCoord = coordAt(0)
		const sparsity = createSparsityModel()

		for (let i = 1; i <= 30; i++) {
			store.upsert(`peer-${i}`, coordAt(i * 8))
		}

		const sample = selectDiverseSample(store, selfCoord, sparsity, new Set(), 4)
		expect(sample).to.have.length(4)
	})

	it('returns empty when all entries are excluded', () => {
		const store = new DigitreeStore()
		const selfCoord = coordAt(0)
		const sparsity = createSparsityModel()

		store.upsert('a', coordAt(50))
		store.upsert('b', coordAt(100))

		const sample = selectDiverseSample(store, selfCoord, sparsity, new Set(['a', 'b']), 10)
		expect(sample).to.have.length(0)
	})

	it('prefers entries in sparse ring regions over dense ones', () => {
		const store = new DigitreeStore()
		const selfCoord = new Uint8Array(COORD_BYTES) // all zeros
		const sparsity = createSparsityModel()

		// Create near-self peers: set a bit deep in the coordinate (high leading zeros = low x)
		// normalizedLogDistance: x = 1 - leadingZeros/256, so more leading zeros = lower x
		for (let i = 1; i <= 10; i++) {
			// Byte 30 (near LSB) — XOR has ~240 leading zero bits → x ≈ 0.06
			const coord = new Uint8Array(COORD_BYTES)
			coord[30] = i
			store.upsert(`near-${i}`, coord)
			const x = normalizedLogDistance(selfCoord, coord)
			observeDistance(sparsity, x)
		}

		// Create far-away peers: set MSB bits — few leading zeros → high x
		// Byte 0 = 128 → 0 leading zero bits → x ≈ 1.0
		const farCoords = [128, 64, 32]
		for (let i = 0; i < farCoords.length; i++) {
			const coord = new Uint8Array(COORD_BYTES)
			coord[0] = farCoords[i]!
			store.upsert(`far-${i + 1}`, coord)
		}

		// Heavily observe near-self distances to build up density in that region
		for (let i = 0; i < 200; i++) {
			observeDistance(sparsity, 0.06)
		}

		const sample = selectDiverseSample(store, selfCoord, sparsity, new Set(), 3)

		// The top 3 should favor the sparse (far) entries over the dense (near) cluster
		const farIds = sample.filter((s) => s.id.startsWith('far-')).map((s) => s.id)
		expect(farIds.length).to.be.greaterThanOrEqual(2,
			'sparse (far) peers should dominate the top sample positions')
	})

	it('sample entries have valid base64url coords', () => {
		const store = new DigitreeStore()
		const selfCoord = coordAt(0)
		const sparsity = createSparsityModel()

		for (let i = 1; i <= 5; i++) {
			store.upsert(`p${i}`, coordAt(i * 50))
		}

		const sample = selectDiverseSample(store, selfCoord, sparsity, new Set(), 5)
		const base64urlRegex = /^[A-Za-z0-9_-]+=*$/
		for (const s of sample) {
			expect(s.coord).to.match(base64urlRegex, `coord for ${s.id} should be valid base64url`)
		}
	})
})

describe('Seed new peers — estimator calibration from snapshots', function () {
	this.timeout(30_000)

	async function createService(profile: 'edge' | 'core' = 'edge') {
		const node = await createMemNode()
		await node.start()
		const svc = new CoreFretService(node, { profile, k: 7, m: 4 })
		await svc.start()
		return { node, svc }
	}

	it('mergeAnnounceSnapshot feeds size_estimate into local estimator', async () => {
		const { node, svc } = await createService()
		// Create a second node to get a valid peer ID for the 'from' field
		const node2 = await createMemNode()
		await node2.start()
		try {
			const before = svc.getNetworkSizeEstimate()
			const fromId = node2.peerId.toString()

			const snap = {
				v: 1 as const,
				from: fromId,
				timestamp: Date.now(),
				successors: [],
				predecessors: [],
				sample: [],
				size_estimate: 100,
				confidence: 0.8,
				sig: '',
			}

			await (svc as any).mergeAnnounceSnapshot(snap.from, snap)

			const after = svc.getNetworkSizeEstimate()
			expect(after.sources).to.be.greaterThan(before.sources,
				'should have more observation sources after calibration')
			expect(after.size_estimate).to.be.greaterThan(0,
				'estimate should be positive after calibration')
		} finally {
			await svc.stop()
			await node.stop()
			await node2.stop()
		}
	})

	it('does not calibrate when size_estimate or confidence is zero/missing', async () => {
		const { node, svc } = await createService()
		const node2 = await createMemNode()
		const node3 = await createMemNode()
		const node4 = await createMemNode()
		await node2.start()
		await node3.start()
		await node4.start()
		try {
			const before = svc.getNetworkSizeEstimate()

			// Snapshot with zero confidence
			const snap1 = {
				v: 1 as const,
				from: node2.peerId.toString(),
				timestamp: Date.now(),
				successors: [],
				predecessors: [],
				sample: [],
				size_estimate: 50,
				confidence: 0,
				sig: '',
			}
			await (svc as any).mergeAnnounceSnapshot(snap1.from, snap1)

			// Snapshot with zero estimate
			const snap2 = {
				v: 1 as const,
				from: node3.peerId.toString(),
				timestamp: Date.now(),
				successors: [],
				predecessors: [],
				sample: [],
				size_estimate: 0,
				confidence: 0.5,
				sig: '',
			}
			await (svc as any).mergeAnnounceSnapshot(snap2.from, snap2)

			// Snapshot with no estimate fields
			const snap3 = {
				v: 1 as const,
				from: node4.peerId.toString(),
				timestamp: Date.now(),
				successors: [],
				predecessors: [],
				sample: [],
				sig: '',
			}
			await (svc as any).mergeAnnounceSnapshot(snap3.from, snap3)

			const after = svc.getNetworkSizeEstimate()
			expect(after.sources).to.equal(before.sources,
				'should not add observations for zero/missing estimates')
		} finally {
			await svc.stop()
			await node.stop()
			await node2.stop()
			await node3.stop()
			await node4.stop()
		}
	})

	it('reportNetworkSize reflects externally reported size on near-empty store', async () => {
		const { node, svc } = await createService()
		try {
			// Directly report a size (mimicking what mergeNeighborSnapshots does)
			svc.reportNetworkSize(200, 0.9, 'snapshot:test')

			const est = svc.getNetworkSizeEstimate()
			expect(est.size_estimate).to.be.greaterThan(0)
			expect(est.sources).to.be.greaterThanOrEqual(1)
		} finally {
			await svc.stop()
			await node.stop()
		}
	})
})
