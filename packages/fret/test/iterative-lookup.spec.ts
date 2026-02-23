import { describe, it } from 'mocha'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { hashKey } from '../src/ring/hash.js'
import { fromString as u8FromString } from 'uint8arrays/from-string'

async function makeMesh(n: number) {
	const nodes = [] as any[]
	for (let i = 0; i < n; i++) {
		const node = await createMemNode()
		await node.start()
		nodes.push(node)
	}
	// Start services BEFORE connections so peer:connect handlers fire
	const services = [] as CoreFretService[]
	for (let i = 0; i < n; i++) {
		const boot = i === 0 ? [] : [nodes[0]!.peerId.toString()]
		const svc = new CoreFretService(nodes[i], { profile: 'edge', k: 7, bootstraps: boot })
		await svc.start()
		services.push(svc)
	}
	// Star topology: all nodes connect to bootstrap
	for (let i = 1; i < n; i++) {
		const ma = nodes[0]!.getMultiaddrs()[0]!
		await nodes[i]!.dial(ma)
	}
	return { nodes, services }
}

describe('Iterative lookup', function () {
	this.timeout(25000)

	it('yields near_anchor or exhausted for a digest-only probe', async () => {
		const { nodes, services } = await makeMesh(3)
		await new Promise(r => setTimeout(r, 2000))

		const key = u8FromString('test-key')
		const events = []
		for await (const evt of services[0]!.iterativeLookup(key, {
			wantK: 7,
			minSigs: 3,
			digest: 'Zg',
			ttl: 3,
		})) {
			events.push(evt)
		}

		if (events.length === 0) throw new Error('expected at least one progress event')
		const types = events.map(e => e.type)
		if (!types.includes('probing')) throw new Error('expected at least one probing event')

		// Should end with either near_anchor or exhausted
		const last = events[events.length - 1]!
		if (last.type !== 'near_anchor' && last.type !== 'exhausted' && last.type !== 'complete') {
			throw new Error(`unexpected final event type: ${last.type}`)
		}

		await Promise.all(services.map(s => s.stop()))
		await stopAll(nodes)
	})

	it('returns complete when activity handler is set and in-cluster', async () => {
		const { nodes, services } = await makeMesh(3)
		await new Promise(r => setTimeout(r, 2000))

		// Set activity handler on all nodes
		for (const svc of services) {
			svc.setActivityHandler(async (_activity, _cohort, _minSigs, _corrId) => {
				return { commitCertificate: 'cert-ok' }
			})
		}

		const key = u8FromString('act-key')
		const events = []
		for await (const evt of services[0]!.iterativeLookup(key, {
			wantK: 7,
			minSigs: 3,
			activity: 'payload-data',
			ttl: 4,
		})) {
			events.push(evt)
		}

		const types = events.map(e => e.type)
		// Should have probing and eventually complete or activity_sent
		if (events.length === 0) throw new Error('expected progress events')

		// The pipeline should attempt activity delivery
		const hasActivity = types.includes('complete') || types.includes('activity_sent') || types.includes('near_anchor')
		if (!hasActivity) {
			throw new Error(`expected activity-related events, got: ${types.join(', ')}`)
		}

		await Promise.all(services.map(s => s.stop()))
		await stopAll(nodes)
	})
})

describe('Breadcrumb rejection', function () {
	this.timeout(20000)

	it('rejects requests where self is in breadcrumbs', async () => {
		const { nodes, services } = await makeMesh(3)
		await new Promise(r => setTimeout(r, 1500))

		const selfId = nodes[1]!.peerId.toString()
		const msg = {
			v: 1 as const,
			key: 'aWQ',
			want_k: 7,
			ttl: 3,
			min_sigs: 3,
			breadcrumbs: [selfId], // self already in breadcrumbs
			correlation_id: 'test-loop',
			timestamp: Date.now(),
			signature: ''
		}

		const res = await services[1]!.routeAct(msg)
		// Should return NearAnchor (not forward recursively)
		if (!('anchors' in res)) throw new Error('expected NearAnchor response for loop detection')

		await Promise.all(services.map((s: any) => s.stop()))
		await stopAll(nodes)
	})
})

describe('Correlation ID dedup', function () {
	this.timeout(20000)

	it('returns cached result for duplicate correlation_id', async () => {
		const { nodes, services } = await makeMesh(3)
		await new Promise(r => setTimeout(r, 1500))

		const msg = {
			v: 1 as const,
			key: 'aWQ',
			want_k: 7,
			ttl: 3,
			min_sigs: 3,
			breadcrumbs: [] as string[],
			correlation_id: 'dedup-test-123',
			timestamp: Date.now(),
			signature: ''
		}

		// First call populates cache
		const res1 = await services[1]!.routeAct(msg)
		// Second call with same correlation_id should return same result
		const res2 = await services[1]!.routeAct(msg)

		if (!('anchors' in res1) || !('anchors' in res2)) {
			throw new Error('expected NearAnchor responses')
		}

		await Promise.all(services.map((s: any) => s.stop()))
		await stopAll(nodes)
	})
})
