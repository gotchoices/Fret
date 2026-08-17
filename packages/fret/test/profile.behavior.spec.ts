import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { TokenBucket } from '../src/utils/token-bucket.js'
import { peerDiscoverySymbol } from '@libp2p/interface'
import { Libp2pFretService } from '../src/service/libp2p-fret-service.js'

// Helper: create a started service with given profile, returning both node and service
async function createService(profile: 'edge' | 'core') {
	const node = await createMemNode()
	await node.start()
	const svc = new CoreFretService(node, { profile, k: 7, m: 4 })
	await svc.start()
	return { node, svc }
}

// Helper: drain a token bucket and count accepted takes
function drainBucket(bucket: TokenBucket, attempts: number): number {
	let accepted = 0
	for (let i = 0; i < attempts; i++) {
		if (bucket.tryTake()) accepted++
	}
	return accepted
}

// Reusable maybeAct message factory
function makeMaybeActMsg(correlationId: string) {
	return {
		v: 1 as const,
		key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
		want_k: 3,
		ttl: 5,
		min_sigs: 1,
		breadcrumbs: [] as string[],
		correlation_id: correlationId,
		timestamp: Date.now(),
		signature: '',
	}
}

describe('Profile behavior tests', function () {
	this.timeout(15000)

	// ----- Phase 1: Token bucket capacity and refill per profile -----

	describe('Token bucket capacities and refill rates', () => {
		const bucketSpecs: Array<{
			name: string;
			field: string;
			coreCap: number;
			edgeCap: number;
			coreRefill: number;
			edgeRefill: number;
		}> = [
			// No Discovery bucket: FretService no longer emits discovery events at all. The single
			// emission path is FretPeerDiscovery, rate-bounded by batchSize / emissionIntervalMs.
			{ name: 'Neighbors', field: 'bucketNeighbors', coreCap: 20, edgeCap: 8, coreRefill: 10, edgeRefill: 4 },
			{ name: 'MaybeAct', field: 'bucketMaybeAct', coreCap: 32, edgeCap: 8, coreRefill: 16, edgeRefill: 4 },
			{ name: 'Ping', field: 'bucketPing', coreCap: 30, edgeCap: 10, coreRefill: 15, edgeRefill: 5 },
			{ name: 'Leave', field: 'bucketLeave', coreCap: 20, edgeCap: 8, coreRefill: 10, edgeRefill: 4 },
			{ name: 'Announce', field: 'bucketAnnounce', coreCap: 16, edgeCap: 6, coreRefill: 8, edgeRefill: 2 },
		]

		for (const spec of bucketSpecs) {
			it(`Core bucket${spec.name} capacity=${spec.coreCap}, refill=${spec.coreRefill}/s`, async () => {
				const { node, svc } = await createService('core')
				const bucket: TokenBucket = (svc as any)[spec.field]
				const accepted = drainBucket(bucket, spec.coreCap + 10)
				expect(accepted).to.be.within(spec.coreCap - 1, spec.coreCap)
				// Verify refill rate via internal state
				expect((bucket as any).refillPerSec).to.equal(spec.coreRefill)
				await svc.stop()
				await node.stop()
			})

			it(`Edge bucket${spec.name} capacity=${spec.edgeCap}, refill=${spec.edgeRefill}/s`, async () => {
				const { node, svc } = await createService('edge')
				const bucket: TokenBucket = (svc as any)[spec.field]
				const accepted = drainBucket(bucket, spec.edgeCap + 10)
				expect(accepted).to.be.within(spec.edgeCap - 1, spec.edgeCap)
				expect((bucket as any).refillPerSec).to.equal(spec.edgeRefill)
				await svc.stop()
				await node.stop()
			})
		}
	})

	describe('TokenBucket retryAfterMs', () => {
		it('returns 0 when tokens available', () => {
			const bucket = new TokenBucket(10, 5)
			expect(bucket.retryAfterMs()).to.equal(0)
		})

		it('returns >0 when bucket is empty', () => {
			const bucket = new TokenBucket(3, 1)
			for (let i = 0; i < 3; i++) bucket.tryTake()
			const wait = bucket.retryAfterMs()
			expect(wait).to.be.greaterThan(0)
		})
	})

	// ----- Phase 1b: Announce fanout -----

	describe('Announce fanout', () => {
		it('Core announceFanout is 8', async () => {
			const { node, svc } = await createService('core')
			expect((svc as any).announceFanout).to.equal(8)
			await svc.stop()
			await node.stop()
		})

		it('Edge announceFanout is 4', async () => {
			const { node, svc } = await createService('edge')
			expect((svc as any).announceFanout).to.equal(4)
			await svc.stop()
			await node.stop()
		})
	})

	// ----- Phase 2: Snapshot export caps -----

	describe('Snapshot export caps', () => {
		it('Edge snapshot caps successors/predecessors ≤ 6, sample ≤ 6', async () => {
			const nodes = []
			for (let i = 0; i < 15; i++) {
				const n = await createMemNode()
				await n.start()
				nodes.push(n)
			}
			for (let i = 1; i < nodes.length; i++) {
				await nodes[i]!.dial(nodes[0]!.getMultiaddrs()[0]!)
			}

			const svc = new CoreFretService(nodes[0], { profile: 'edge', k: 15, m: 8 })
			await svc.start()
			await new Promise((r) => setTimeout(r, 2000))

			const snap = await (svc as any).snapshot()
			expect(snap.successors.length).to.be.at.most(6)
			expect(snap.predecessors.length).to.be.at.most(6)
			expect((snap.sample ?? []).length).to.be.at.most(6)

			await svc.stop()
			await stopAll(nodes)
		})

		it('Core snapshot caps successors/predecessors ≤ 12, sample ≤ 8', async () => {
			const nodes = []
			for (let i = 0; i < 15; i++) {
				const n = await createMemNode()
				await n.start()
				nodes.push(n)
			}
			for (let i = 1; i < nodes.length; i++) {
				await nodes[i]!.dial(nodes[0]!.getMultiaddrs()[0]!)
			}

			const svc = new CoreFretService(nodes[0], { profile: 'core', k: 15, m: 8 })
			await svc.start()
			await new Promise((r) => setTimeout(r, 2000))

			const snap = await (svc as any).snapshot()
			expect(snap.successors.length).to.be.at.most(12)
			expect(snap.predecessors.length).to.be.at.most(12)
			expect((snap.sample ?? []).length).to.be.at.most(8)

			await svc.stop()
			await stopAll(nodes)
		})
	})

	// ----- Phase 2b: Snapshot receive caps (fetchAndMergeSnapshot) -----

	describe('Snapshot receive caps', () => {
		it('Edge truncates received successors to 8, predecessors to 8, sample to 6', async () => {
			const nodes = []
			for (let i = 0; i < 22; i++) {
				const n = await createMemNode()
				await n.start()
				nodes.push(n)
			}
			for (let i = 1; i < nodes.length; i++) {
				await nodes[i]!.dial(nodes[0]!.getMultiaddrs()[0]!)
			}
			const sender = new CoreFretService(nodes[0]!, { profile: 'core', k: 15, m: 8 })
			await sender.start()
			await new Promise((r) => setTimeout(r, 2000))

			const receiverNode = await createMemNode()
			await receiverNode.start()
			await receiverNode.dial(nodes[0]!.getMultiaddrs()[0]!)
			const receiver = new CoreFretService(receiverNode, { profile: 'edge', k: 15, m: 8 })
			await receiver.start()

			const storeBefore = receiver.getStore().size()
			await (receiver as any).fetchAndMergeSnapshot(nodes[0]!.peerId.toString(), (receiver as any).runSignal)
			const storeAfter = receiver.getStore().size()

			// Edge receive caps: 8 succ + 8 pred + 6 sample = 22 max unique peers merged
			const added = storeAfter - storeBefore
			expect(added).to.be.at.most(22)

			await receiver.stop()
			await receiverNode.stop()
			await sender.stop()
			await stopAll(nodes)
		})

		it('Core truncates received successors to 16, predecessors to 16, sample to 8', async () => {
			const nodes = []
			for (let i = 0; i < 22; i++) {
				const n = await createMemNode()
				await n.start()
				nodes.push(n)
			}
			for (let i = 1; i < nodes.length; i++) {
				await nodes[i]!.dial(nodes[0]!.getMultiaddrs()[0]!)
			}
			const sender = new CoreFretService(nodes[0]!, { profile: 'core', k: 15, m: 8 })
			await sender.start()
			await new Promise((r) => setTimeout(r, 2000))

			const receiverNode = await createMemNode()
			await receiverNode.start()
			await receiverNode.dial(nodes[0]!.getMultiaddrs()[0]!)
			const receiver = new CoreFretService(receiverNode, { profile: 'core', k: 15, m: 8 })
			await receiver.start()

			const storeBefore = receiver.getStore().size()
			await (receiver as any).fetchAndMergeSnapshot(nodes[0]!.peerId.toString(), (receiver as any).runSignal)
			const storeAfter = receiver.getStore().size()

			// Core receive caps: 16 succ + 16 pred + 8 sample = 40 max unique peers merged
			const added = storeAfter - storeBefore
			expect(added).to.be.at.most(40)

			await receiver.stop()
			await receiverNode.stop()
			await sender.stop()
			await stopAll(nodes)
		})
	})

	// ----- Phase 3: Concurrent act limit & busy responses -----

	describe('Concurrent act limits', () => {
		it('Edge allows handleMaybeAct when inflightAct < 4, rejects at 4', async () => {
			const { node, svc } = await createService('edge')
			// At limit - 1, request should NOT be rejected for inflight (may still proceed or fail for other reasons)
			;(svc as any).inflightAct = 3
			const msg = makeMaybeActMsg('test-edge-under-limit')
			const result = await (svc as any).handleMaybeAct(msg)
			// Under the limit: should not be a busy response from inflight check
			expect(result?.retry_after_ms).to.not.equal(500)

			// At exactly the limit, should get busy with retry_after_ms=500
			;(svc as any).inflightAct = 4
			const busyResult = await (svc as any).handleMaybeAct(makeMaybeActMsg('test-edge-at-limit'))
			expect(busyResult).to.have.property('busy', true)
			expect(busyResult).to.have.property('retry_after_ms', 500)

			await svc.stop()
			await node.stop()
		})

		it('Core allows handleMaybeAct when inflightAct < 16, rejects at 16', async () => {
			const { node, svc } = await createService('core')
			;(svc as any).inflightAct = 15
			const msg = makeMaybeActMsg('test-core-under-limit')
			const result = await (svc as any).handleMaybeAct(msg)
			expect(result?.retry_after_ms).to.not.equal(500)

			;(svc as any).inflightAct = 16
			const busyResult = await (svc as any).handleMaybeAct(makeMaybeActMsg('test-core-at-limit'))
			expect(busyResult).to.have.property('busy', true)
			expect(busyResult).to.have.property('retry_after_ms', 500)

			await svc.stop()
			await node.stop()
		})

		it('handleMaybeAct returns BusyResponseV1 when bucketMaybeAct exhausted', async () => {
			const { node, svc } = await createService('edge')
			const bucket: TokenBucket = (svc as any).bucketMaybeAct
			drainBucket(bucket, 20)

			const result = await (svc as any).handleMaybeAct(makeMaybeActMsg('test-busy-1'))
			expect(result).to.have.property('busy', true)
			expect(result).to.have.property('retry_after_ms')
			expect(result.retry_after_ms).to.be.greaterThan(0)

			const diag = svc.getDiagnostics()
			expect(diag.rejected.rateLimited).to.be.greaterThan(0)

			await svc.stop()
			await node.stop()
		})

		it('handleNeighborsRequest returns BusyResponseV1 when bucket exhausted', async () => {
			const { node, svc } = await createService('edge')
			const bucket: TokenBucket = (svc as any).bucketNeighbors
			drainBucket(bucket, 20)

			const result = await (svc as any).handleNeighborsRequest()
			expect(result).to.have.property('busy', true)
			expect(result).to.have.property('retry_after_ms')

			await svc.stop()
			await node.stop()
		})

		it('handlePingRequest returns BusyResponseV1 when bucket exhausted', async () => {
			const { node, svc } = await createService('edge')
			const bucket: TokenBucket = (svc as any).bucketPing
			drainBucket(bucket, 20)

			const result = (svc as any).handlePingRequest()
			expect(result).to.have.property('busy', true)
			expect(result).to.have.property('retry_after_ms')

			await svc.stop()
			await node.stop()
		})
	})

	// ----- Phase 4: Payload size limits -----

	describe('Payload size limits', () => {
		it('Core maxBytesNeighbors = 128 KB (131072)', async () => {
			const { node, svc } = await createService('core')
			expect((svc as any).maxBytesNeighbors()).to.equal(131072)
			await svc.stop()
			await node.stop()
		})

		it('Edge maxBytesNeighbors = 64 KB (65536)', async () => {
			const { node, svc } = await createService('edge')
			expect((svc as any).maxBytesNeighbors()).to.equal(65536)
			await svc.stop()
			await node.stop()
		})

		it('Core maxBytesMaybeAct = 512 KB (524288)', async () => {
			const { node, svc } = await createService('core')
			expect((svc as any).maxBytesMaybeAct()).to.equal(524288)
			await svc.stop()
			await node.stop()
		})

		it('Edge maxBytesMaybeAct = 256 KB (262144)', async () => {
			const { node, svc } = await createService('edge')
			expect((svc as any).maxBytesMaybeAct()).to.equal(262144)
			await svc.stop()
			await node.stop()
		})
	})

	// ----- Phase 5: Preconnect budget -----
	//
	// The per-second active-mode preconnect budget (Core 6 / Edge 3) is pinned by the two
	// "active tick:" cases in `preconnect-concurrency.spec.ts`, which seed 16 peers through the shared maintenance
	// rig so the budget actually saturates and asserts `pingsSent` equals it *exactly*, plus that
	// the budget is spent on dialable peers rather than wasted on undialable leaders. The block that
	// used to live here put an empty-store service into active mode and asserted `pingsSent <= budget`,
	// which holds for any budget when the count is 0.

	// ----- Profile config defaults -----

	describe('Profile config defaults', () => {
		it('defaults to core profile', async () => {
			const node = await createMemNode()
			await node.start()
			const svc = new CoreFretService(node)
			await svc.start()
			expect((svc as any).cfg.profile).to.equal('core')
			await svc.stop()
			await node.stop()
		})

		it('Edge profile is set when requested', async () => {
			const { node, svc } = await createService('edge')
			expect((svc as any).cfg.profile).to.equal('edge')
			await svc.stop()
			await node.stop()
		})
	})

	// ----- Diagnostics rejection counter -----

	describe('Diagnostics rejection tracking', () => {
		it('rateLimited counter increments on each rate-limited rejection', async () => {
			const { node, svc } = await createService('edge')

			// Drain neighbors bucket
			const bucket: TokenBucket = (svc as any).bucketNeighbors
			drainBucket(bucket, 20)

			const before = svc.getDiagnostics().rejected.rateLimited

			// Three rejected requests
			await (svc as any).handleNeighborsRequest()
			await (svc as any).handleNeighborsRequest()
			await (svc as any).handleNeighborsRequest()

			const after = svc.getDiagnostics().rejected.rateLimited
			expect(after - before).to.equal(3)

			await svc.stop()
			await node.stop()
		})
	})

	// ----- Bounded internal map capacities (backoffMap, departureDebounce, discovery debounce) -----

	describe('Bounded internal map capacities', () => {
		it('Core backoffMap capacity defaults to routing-table capacity (2048)', async () => {
			const { node, svc } = await createService('core')
			expect((svc as any).backoffMap.capacity).to.equal(2048)
			await svc.stop()
			await node.stop()
		})

		it('Edge backoffMap capacity is capped at 512', async () => {
			const { node, svc } = await createService('edge')
			expect((svc as any).backoffMap.capacity).to.equal(512)
			await svc.stop()
			await node.stop()
		})

		it('Core departureDebounce capacity defaults to 512', async () => {
			const { node, svc } = await createService('core')
			expect((svc as any).departureDebounce.capacity).to.equal(512)
			await svc.stop()
			await node.stop()
		})

		it('Edge departureDebounce capacity defaults to 128', async () => {
			const { node, svc } = await createService('edge')
			expect((svc as any).departureDebounce.capacity).to.equal(128)
			await svc.stop()
			await node.stop()
		})

		it('Core discovery debounce map (maxTracked) defaults to 4096', () => {
			const svc = new Libp2pFretService({}, { profile: 'core', k: 7 })
			const disc = svc[peerDiscoverySymbol] as any
			expect(disc.emitted.capacity).to.equal(4096)
		})

		it('Edge discovery debounce map (maxTracked) defaults to 1024', () => {
			const svc = new Libp2pFretService({}, { profile: 'edge', k: 7 })
			const disc = svc[peerDiscoverySymbol] as any
			expect(disc.emitted.capacity).to.equal(1024)
		})

		it('an explicit discoveryCfg.maxTracked overrides the profile default', () => {
			const svc = new Libp2pFretService({}, { profile: 'core', k: 7 }, { maxTracked: 77 })
			const disc = svc[peerDiscoverySymbol] as any
			expect(disc.emitted.capacity).to.equal(77)
		})
	})
})
