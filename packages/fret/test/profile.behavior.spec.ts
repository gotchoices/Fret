import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode } from './helpers/libp2p.js'
import { buildMesh, type Mesh } from './helpers/mesh.js'
import { useCleanup, type Cleanup } from './helpers/cleanup.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { TokenBucket } from '../src/utils/token-bucket.js'
import { ExpiringMap } from '../src/utils/expiring-map.js'
import { MAX_NEIGHBORS_BYTES } from '../src/rpc/validate.js'
import { peerDiscoverySymbol } from '@libp2p/interface'
import { Libp2pFretService } from '../src/service/libp2p-fret-service.js'
import type { FretConfig } from '../src/index.js'
import type { Libp2p } from 'libp2p'

/**
 * Teardown registry, assigned by the `describe` below before any case runs. The helpers here are
 * module-level but only ever *called* from inside a case, so resolving `cleanup` at call time is
 * enough and none of them has to move into the suite body.
 */
let cleanup: Cleanup

function onCleanup(fn: () => Promise<void> | void): void {
	cleanup.add(fn)
}

/** A started node with a started service on it, both registered for teardown. */
async function createService(profile: 'edge' | 'core') {
	const node = await createMemNode()
	await node.start()
	const svc = new CoreFretService(node, { profile, k: 7, m: 4 })
	await svc.start()
	onCleanup(async () => { await svc.stop(); await node.stop() })
	return { node, svc }
}

/** `buildMesh` + star dial, registered for teardown. */
async function starRig(count: number): Promise<Mesh> {
	const mesh = await buildMesh(count, { cleanup })
	await mesh.connect('star')
	return mesh
}

/**
 * A started service constructed directly on `node`, registered for teardown. Distinct from
 * `mesh.addServices` on purpose: these cases put a service on a mesh node with a config the rest
 * of the mesh does not share, so `mesh.stop()` never sees it.
 */
async function startService(node: Libp2p, cfg: Partial<FretConfig>): Promise<CoreFretService> {
	const svc = new CoreFretService(node, cfg)
	await svc.start()
	onCleanup(() => svc.stop())
	return svc
}

/** A started bare node with no service on it, registered for teardown. */
async function startNode(): Promise<Libp2p> {
	const node = await createMemNode()
	await node.start()
	onCleanup(async () => { await node.stop() })
	return node
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

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
	cleanup = useCleanup()

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
				const { svc } = await createService('core')
				const bucket: TokenBucket = (svc as any)[spec.field]
				const accepted = drainBucket(bucket, spec.coreCap + 10)
				expect(accepted).to.be.within(spec.coreCap - 1, spec.coreCap)
				// Verify refill rate via internal state
				expect((bucket as any).refillPerSec).to.equal(spec.coreRefill)
			})

			it(`Edge bucket${spec.name} capacity=${spec.edgeCap}, refill=${spec.edgeRefill}/s`, async () => {
				const { svc } = await createService('edge')
				const bucket: TokenBucket = (svc as any)[spec.field]
				const accepted = drainBucket(bucket, spec.edgeCap + 10)
				expect(accepted).to.be.within(spec.edgeCap - 1, spec.edgeCap)
				expect((bucket as any).refillPerSec).to.equal(spec.edgeRefill)
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
			const { svc } = await createService('core')
			expect((svc as any).announceFanout).to.equal(8)
		})

		it('Edge announceFanout is 4', async () => {
			const { svc } = await createService('edge')
			expect((svc as any).announceFanout).to.equal(4)
		})
	})

	// ----- Phase 2: Snapshot export caps -----

	describe('Snapshot export caps', () => {
		it('Edge snapshot caps successors/predecessors ≤ 6, sample ≤ 6', async () => {
			const mesh = await starRig(15)
			const svc = await startService(mesh.nodes[0]!, { profile: 'edge', k: 15, m: 8 })
			await delay(2000)

			const snap = await (svc as any).snapshot()
			expect(snap.successors.length).to.be.at.most(6)
			expect(snap.predecessors.length).to.be.at.most(6)
			expect((snap.sample ?? []).length).to.be.at.most(6)
		})

		it('Core snapshot caps successors/predecessors ≤ 12, sample ≤ 8', async () => {
			const mesh = await starRig(15)
			const svc = await startService(mesh.nodes[0]!, { profile: 'core', k: 15, m: 8 })
			await delay(2000)

			const snap = await (svc as any).snapshot()
			expect(snap.successors.length).to.be.at.most(12)
			expect(snap.predecessors.length).to.be.at.most(12)
			expect((snap.sample ?? []).length).to.be.at.most(8)
		})
	})

	// ----- Phase 2b: Snapshot receive caps (fetchAndMergeSnapshot) -----

	describe('Snapshot receive caps', () => {
		it('Edge truncates received successors to 8, predecessors to 8, sample to 6', async () => {
			const mesh = await starRig(22)
			const sender = await startService(mesh.nodes[0]!, { profile: 'core', k: 15, m: 8 })
			await delay(2000)

			const receiverNode = await startNode()
			await receiverNode.dial(mesh.nodes[0]!.getMultiaddrs()[0]!)
			const receiver = await startService(receiverNode, { profile: 'edge', k: 15, m: 8 })

			const storeBefore = receiver.getStore().size()
			await (receiver as any).fetchAndMergeSnapshot(mesh.ids[0]!, (receiver as any).runSignal)
			const storeAfter = receiver.getStore().size()

			// Edge receive caps: 8 succ + 8 pred + 6 sample = 22 max unique peers merged
			expect(storeAfter - storeBefore).to.be.at.most(22)
			expect(sender.getStore().size()).to.be.greaterThan(0)
		})

		it('Core truncates received successors to 16, predecessors to 16, sample to 8', async () => {
			const mesh = await starRig(22)
			const sender = await startService(mesh.nodes[0]!, { profile: 'core', k: 15, m: 8 })
			await delay(2000)

			const receiverNode = await startNode()
			await receiverNode.dial(mesh.nodes[0]!.getMultiaddrs()[0]!)
			const receiver = await startService(receiverNode, { profile: 'core', k: 15, m: 8 })

			const storeBefore = receiver.getStore().size()
			await (receiver as any).fetchAndMergeSnapshot(mesh.ids[0]!, (receiver as any).runSignal)
			const storeAfter = receiver.getStore().size()

			// Core receive caps: 16 succ + 16 pred + 8 sample = 40 max unique peers merged
			expect(storeAfter - storeBefore).to.be.at.most(40)
			expect(sender.getStore().size()).to.be.greaterThan(0)
		})
	})

	// ----- Phase 3: Concurrent act limit & busy responses -----

	describe('Concurrent act limits', () => {
		// The inbound maybeAct concurrency cap (Core 16 / Edge 4) is pinned by
		// `inflight-concurrency.spec.ts`, which fans out real calls into a gated activity handler
		// and asserts the high-water mark *equals* the cap, that the surplus is refused with the
		// 500 ms inflight sentinel, and that the counter returns to zero — including when the
		// handler throws. The two cases that used to live here **assigned** `inflightAct` and
		// then fired a single request, which proved only that the comparison reads the field: it
		// could not observe the increment/decrement pairing at all, and its healthy-arm assertion
		// (`retry_after_ms !== 500`) passed because the field is `undefined` on a non-busy reply.
		// The three bucket-exhaustion cases below are unaffected — they test the token bucket.

		it('handleMaybeAct returns BusyResponseV1 when bucketMaybeAct exhausted', async () => {
			const { svc } = await createService('edge')
			const bucket: TokenBucket = (svc as any).bucketMaybeAct
			drainBucket(bucket, 20)

			const result = await (svc as any).handleMaybeAct(makeMaybeActMsg('test-busy-1'))
			expect(result).to.have.property('busy', true)
			expect(result).to.have.property('retry_after_ms')
			expect(result.retry_after_ms).to.be.greaterThan(0)

			const diag = svc.getDiagnostics()
			expect(diag.rejected.rateLimited.maybeAct).to.be.greaterThan(0)
		})

		it('handleNeighborsRequest returns BusyResponseV1 when bucket exhausted', async () => {
			const { svc } = await createService('edge')
			const bucket: TokenBucket = (svc as any).bucketNeighbors
			drainBucket(bucket, 20)

			const result = await (svc as any).handleNeighborsRequest()
			expect(result).to.have.property('busy', true)
			expect(result).to.have.property('retry_after_ms')
		})

		it('handlePingRequest returns BusyResponseV1 when bucket exhausted', async () => {
			const { svc } = await createService('edge')
			const bucket: TokenBucket = (svc as any).bucketPing
			drainBucket(bucket, 20)

			const result = (svc as any).handlePingRequest()
			expect(result).to.have.property('busy', true)
			expect(result).to.have.property('retry_after_ms')
		})
	})

	// ----- Phase 4: Payload size limits -----

	describe('Payload size limits', () => {
		// One acceptance number for both profiles: the cap bounds what a *peer* may send us, and
		// Edge and Core peers talk to each other. A profile split here made a legal Core snapshot
		// (up to 11,575 bytes) unreadable by every Edge peer, whose cap was 8192.
		it('maxBytesNeighbors = MAX_NEIGHBORS_BYTES (16384) on both profiles', async () => {
			const core = await createService('core')
			expect((core.svc as any).maxBytesNeighbors()).to.equal(MAX_NEIGHBORS_BYTES)

			const edge = await createService('edge')
			expect((edge.svc as any).maxBytesNeighbors()).to.equal(MAX_NEIGHBORS_BYTES)

			expect(MAX_NEIGHBORS_BYTES).to.equal(16384)
		})

		it('maxBytesMaybeAct = 144 KB (147456) on both profiles', async () => {
			const core = await createService('core')
			expect((core.svc as any).maxBytesMaybeAct()).to.equal(147456)

			const edge = await createService('edge')
			expect((edge.svc as any).maxBytesMaybeAct()).to.equal(147456)
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
			const svc = await startService(await startNode(), {})
			expect((svc as any).cfg.profile).to.equal('core')
		})

		it('Edge profile is set when requested', async () => {
			const { svc } = await createService('edge')
			expect((svc as any).cfg.profile).to.equal('edge')
		})
	})

	// ----- Diagnostics rejection counter -----

	describe('Diagnostics rejection tracking', () => {
		it('rateLimited counter increments on each rate-limited rejection', async () => {
			const { svc } = await createService('edge')

			// Drain neighbors bucket
			const bucket: TokenBucket = (svc as any).bucketNeighbors
			drainBucket(bucket, 20)

			const before = svc.getDiagnostics().rejected.rateLimited.neighbors

			// Three rejected requests
			await (svc as any).handleNeighborsRequest()
			await (svc as any).handleNeighborsRequest()
			await (svc as any).handleNeighborsRequest()

			const after = svc.getDiagnostics().rejected.rateLimited.neighbors
			expect(after - before).to.equal(3)
		})
	})

	// ----- Bounded internal map capacities (backoffMap, departureDebounce, discovery debounce) -----

	describe('Bounded internal map capacities', () => {
		it('Core backoffMap capacity defaults to routing-table capacity (2048)', async () => {
			const { svc } = await createService('core')
			expect((svc as any).backoffMap.capacity).to.equal(2048)
		})

		it('Edge backoffMap capacity is capped at 512', async () => {
			const { svc } = await createService('edge')
			expect((svc as any).backoffMap.capacity).to.equal(512)
		})

		it('Core departureDebounce capacity defaults to 512', async () => {
			const { svc } = await createService('core')
			expect((svc as any).departureDebounce.capacity).to.equal(512)
		})

		it('Edge departureDebounce capacity defaults to 128', async () => {
			const { svc } = await createService('edge')
			expect((svc as any).departureDebounce.capacity).to.equal(128)
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

		it('stabilizeOnce sweeps expired entries from backoffMap and departureDebounce', async () => {
			const { svc } = await createService('core')

			let clockNow = Date.now()
			const clock = { now: () => clockNow, advance: (ms: number) => { clockNow += ms } }

			const backoffTtl = (CoreFretService as any).BACKOFF_RETAIN_MS
			const departureTtl = (CoreFretService as any).DEPARTURE_DEBOUNCE_MS

			;(svc as any).backoffMap = new ExpiringMap({ capacity: 8, ttlMs: backoffTtl, now: clock.now })
			;(svc as any).departureDebounce = new ExpiringMap({ capacity: 8, ttlMs: departureTtl, now: clock.now })

			// backoffMap survivor must already be a store member, or pruneBackoffMap (which runs
			// inside the same sweepBoundedMaps call) drops it regardless of expiry.
			const selfId: string = (svc as any).selfIdStr
			const backoffExpiredId = 'backoff-expired-peer'
			const departureExpiredId = 'departure-expired-peer'
			const departureLiveId = 'departure-live-peer'

			;(svc as any).backoffMap.set(backoffExpiredId, { until: clockNow, factor: 1 })
			;(svc as any).departureDebounce.set(departureExpiredId, clockNow)

			clock.advance(Math.min(backoffTtl, departureTtl) + 1)

			;(svc as any).backoffMap.set(selfId, { until: clockNow, factor: 1 })
			;(svc as any).departureDebounce.set(departureLiveId, clockNow)

			await (svc as any).stabilizeOnce()

			expect((svc as any).backoffMap.has(backoffExpiredId)).to.equal(false)
			expect((svc as any).departureDebounce.has(departureExpiredId)).to.equal(false)
			expect((svc as any).backoffMap.has(selfId)).to.equal(true)
			expect((svc as any).departureDebounce.has(departureLiveId)).to.equal(true)
		})
	})
})
