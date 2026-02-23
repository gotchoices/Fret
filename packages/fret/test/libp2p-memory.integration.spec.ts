import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { hashPeerId } from '../src/ring/hash.js'
import { fromString as u8FromString } from 'uint8arrays/from-string'
import type { Libp2p } from 'libp2p'
import type { NearAnchorV1, RouteAndMaybeActV1 } from '../src/index.js'

// Uses @libp2p/memory transport with plaintext encryption for fast,
// deterministic in-process testing (no TCP ports or TLS overhead).
// readAllBounded includes an idle-timeout to work around yamux
// failing to propagate remote-close EOF to the dialer's async iterator.

// --- helpers ---

async function makeMesh(n: number, opts?: { k?: number; profile?: 'edge' | 'core' }) {
	const k = opts?.k ?? 7
	const profile = opts?.profile ?? 'edge'
	const nodes: Libp2p[] = []
	for (let i = 0; i < n; i++) {
		const node = await createMemNode()
		await node.start()
		nodes.push(node)
	}
	// Start ALL services first so RPC handlers and peer:connect listeners
	// are registered before connections are established.
	const services: CoreFretService[] = []
	for (let i = 0; i < n; i++) {
		const boot = i === 0 ? [] : [nodes[0]!.peerId.toString()]
		const svc = new CoreFretService(nodes[i]!, { profile, k, bootstraps: boot })
		await svc.start()
		services.push(svc)
	}
	// Connect in a star AFTER services start — peer:connect events fire
	// and populate each node's store.  Star ensures bootstrap knows all
	// peers immediately and leave notices can reach it via direct connection.
	for (let i = 1; i < n; i++) {
		const ma = nodes[0]!.getMultiaddrs()[0]!
		await nodes[i]!.dial(ma)
	}
	return { nodes, services }
}

function makeRouteMsg(keyB64: string, ttl = 5): RouteAndMaybeActV1 {
	return {
		v: 1,
		key: keyB64,
		want_k: 7,
		wants: 5,
		ttl,
		min_sigs: 3,
		breadcrumbs: [],
		correlation_id: `corr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		timestamp: Date.now(),
		signature: '',
	}
}

/** Compute sorted ring positions for all nodes. */
async function ringPositions(nodes: Libp2p[]) {
	const entries = await Promise.all(
		nodes.map(async (n, i) => ({
			idx: i,
			id: n.peerId.toString(),
			coord: await hashPeerId(n.peerId),
		}))
	)
	entries.sort((a, b) => {
		for (let i = 0; i < 32; i++) {
			if (a.coord[i]! < b.coord[i]!) return -1
			if (a.coord[i]! > b.coord[i]!) return 1
		}
		return 0
	})
	return entries
}

// --- tests ---

describe('libp2p in-process integration', function () {
	this.timeout(30000)

	let nodes: Libp2p[] = []
	let services: CoreFretService[] = []

	afterEach(async () => {
		for (const s of services) {
			if (!s) continue
			try { await s.stop() } catch {}
		}
		await stopAll(nodes.filter(Boolean))
		nodes = []
		services = []
	})

	// 1. Neighbor exchange — 3 nodes
	it('3 nodes discover each other via neighbor exchange', async () => {
		const mesh = await makeMesh(3)
		nodes = mesh.nodes
		services = mesh.services

		// Stabilization needs several ticks (1.5s each in passive mode)
		await new Promise(r => setTimeout(r, 5000))

		// Each node should know at least 2 peers (self + at least 1 remote)
		for (let i = 0; i < 3; i++) {
			const peers = services[i]!.listPeers()
			expect(peers.length).to.be.at.least(2,
				`node ${i} should know at least 2 peers (self + neighbors)`)
		}

		// Node 0 (bootstrap, listener for all) should know all peers
		const node0Peers = services[0]!.listPeers().map(p => p.id)
		for (let j = 1; j < 3; j++) {
			expect(node0Peers).to.include(nodes[j]!.peerId.toString(),
				`bootstrap node should know node ${j}`)
		}

		// Total snapshot fetches should be non-zero (actual exchange happened)
		const totalSnaps = services.reduce((sum, svc) =>
			sum + svc.getDiagnostics().snapshotsFetched, 0)
		expect(totalSnaps).to.be.greaterThan(0, 'some snapshot exchanges should occur')
	})

	// 2. Neighbor exchange — 10 nodes
	it('10 nodes converge and populate S/P sets', async () => {
		const mesh = await makeMesh(10)
		nodes = mesh.nodes
		services = mesh.services

		await new Promise(r => setTimeout(r, 6000))

		const m = 4 // ceil(7/2)
		for (let i = 0; i < 10; i++) {
			const peers = services[i]!.listPeers()
			// Each node should know at least 2 peers (self + bootstrap/neighbor)
			expect(peers.length).to.be.at.least(2,
				`node ${i} should know at least 2 peers, has ${peers.length}`)

			const selfCoord = await hashPeerId(nodes[i]!.peerId)
			const right = services[i]!.getNeighbors(selfCoord, 'right', m)
			const left = services[i]!.getNeighbors(selfCoord, 'left', m)
			expect(right.length).to.be.greaterThan(0, `node ${i} has empty successor set`)
			expect(left.length).to.be.greaterThan(0, `node ${i} has empty predecessor set`)
		}

		// Bootstrap node (index 0) should discover the majority of peers
		const node0Peers = services[0]!.listPeers()
		expect(node0Peers.length).to.be.at.least(8,
			`bootstrap node should know most peers, has ${node0Peers.length}`)
	})

	// 3. routeAct — returns NearAnchor with anchors and cohort hints
	it('routeAct returns NearAnchor with anchors and cohort hints', async () => {
		const mesh = await makeMesh(5)
		nodes = mesh.nodes
		services = mesh.services

		await new Promise(r => setTimeout(r, 4000))

		const keyBytes = u8FromString('test-key-alpha', 'utf8')
		const keyB64 = Buffer.from(keyBytes).toString('base64url')
		const msg = makeRouteMsg(keyB64)
		const res = await services[1]!.routeAct(msg)

		expect(res).to.have.property('anchors')
		const anchor = res as NearAnchorV1
		expect(anchor.anchors.length).to.be.greaterThan(0, 'should return at least one anchor')
		expect(anchor.cohort_hint.length).to.be.greaterThan(0, 'should return cohort hints')
	})

	// 4. routeAct — activity handler fires at anchor
	it('routeAct with activity triggers handler at anchor node', async () => {
		const mesh = await makeMesh(5)
		nodes = mesh.nodes
		services = mesh.services

		await new Promise(r => setTimeout(r, 4000))

		const invocations: Array<{ nodeIdx: number; activity: string }> = []

		for (let i = 0; i < 5; i++) {
			const idx = i
			services[i]!.setActivityHandler(async (activity, _cohort, _minSigs, _corrId) => {
				invocations.push({ nodeIdx: idx, activity })
				return { commitCertificate: `cert-from-${idx}` }
			})
		}

		const keyBytes = u8FromString('activity-key', 'utf8')
		const keyB64 = Buffer.from(keyBytes).toString('base64url')
		const msg = makeRouteMsg(keyB64, 8)
		msg.activity = 'test-action'

		// Try from multiple source nodes until one reaches an anchor with handler
		let gotCert = false
		for (let src = 0; src < 5; src++) {
			const uniqueMsg = { ...msg, correlation_id: `corr-${src}-${Date.now()}` }
			const res = await services[src]!.routeAct(uniqueMsg)
			if ('commitCertificate' in res) {
				gotCert = true
				expect((res as any).commitCertificate).to.match(/^cert-from-/)
				break
			}
		}

		// The handler should fire at least once if any node is in-cluster for the key
		if (invocations.length > 0) {
			expect(invocations[0]!.activity).to.equal('test-action')
		}
		expect(gotCert || invocations.length > 0).to.equal(true,
			'activity handler should fire or cert should be returned')
	})

	// 5. Ring invariant — successors/predecessors match sorted ring order
	it('successor/predecessor sets match ring order after stabilization', async () => {
		const mesh = await makeMesh(6)
		nodes = mesh.nodes
		services = mesh.services

		await new Promise(r => setTimeout(r, 6000))

		const ring = await ringPositions(nodes)
		const m = 4 // ceil(7/2)

		// Check ring invariant for the bootstrap node (index 0) which has
		// the best view of the network since all nodes connect to it
		const boot = ring.find(r => r.idx === 0)!
		const bootSvc = services[0]!
		const bootRingIdx = ring.indexOf(boot)

		const succs = bootSvc.getNeighbors(boot.coord, 'right', m)
		const preds = bootSvc.getNeighbors(boot.coord, 'left', m)

		// Bootstrap should have non-trivial successor and predecessor sets
		expect(succs.length).to.be.greaterThan(0, 'bootstrap successors should be non-empty')
		expect(preds.length).to.be.greaterThan(0, 'bootstrap predecessors should be non-empty')

		// At least one successor should be a true ring successor
		const expectedSuccs = new Set<string>()
		for (let j = 1; j <= Math.min(m, ring.length - 1); j++) {
			expectedSuccs.add(ring[(bootRingIdx + j) % ring.length]!.id)
		}
		const succMatches = succs.filter(id => expectedSuccs.has(id))
		expect(succMatches.length).to.be.greaterThan(0,
			'bootstrap should have at least one correct ring successor')

		// Verify ALL nodes have non-empty S/P sets
		for (const entry of ring) {
			const svc = services[entry.idx]!
			const s = svc.getNeighbors(entry.coord, 'right', m)
			const p = svc.getNeighbors(entry.coord, 'left', m)
			expect(s.length + p.length).to.be.greaterThan(0,
				`node ${entry.idx} should have at least one neighbor`)
		}
	})

	// 6. Graceful leave — remaining peers continue to function
	it('graceful leave: remaining peers route and stabilize after departure', async () => {
		const mesh = await makeMesh(5)
		nodes = mesh.nodes
		services = mesh.services

		await new Promise(r => setTimeout(r, 4000))

		const leavingIdx = 2
		const leavingId = nodes[leavingIdx]!.peerId.toString()

		// Verify the leaving node is known by at least the bootstrap
		const knownBefore = services[0]!.listPeers().some(p => p.id === leavingId)
		expect(knownBefore).to.equal(true, 'leaving peer should be known before departure')

		const diagBefore = { ...services[0]!.getDiagnostics() }

		// Stop the leaving service (sends leave notice internally)
		await services[leavingIdx]!.stop()
		await nodes[leavingIdx]!.stop()

		await new Promise(r => setTimeout(r, 3000))

		// Remaining services should still be functioning
		for (let i = 0; i < 5; i++) {
			if (i === leavingIdx) continue
			expect(services[i]!.getDiagnostics()).to.have.property('pingsSent')
		}

		// Bootstrap should have continued stabilization (more pings after leave)
		const diagAfter = services[0]!.getDiagnostics()
		expect(diagAfter.pingsSent).to.be.greaterThan(diagBefore.pingsSent,
			'bootstrap should continue pinging after leave')

		// Remaining nodes should still have functioning S/P sets
		const m = 4
		for (let i = 0; i < 5; i++) {
			if (i === leavingIdx) continue
			const selfCoord = await hashPeerId(nodes[i]!.peerId)
			const right = services[i]!.getNeighbors(selfCoord, 'right', m)
			const left = services[i]!.getNeighbors(selfCoord, 'left', m)
			expect(right.length + left.length).to.be.greaterThan(0,
				`node ${i} should still have neighbors after leave`)
		}

		// Routing should still work among the remaining 4 nodes
		const keyBytes = u8FromString('post-leave-routing', 'utf8')
		const keyB64 = Buffer.from(keyBytes).toString('base64url')
		const msg = makeRouteMsg(keyB64, 8)
		const res = await services[0]!.routeAct(msg)
		expect(res).to.have.property('anchors')

		// Prevent afterEach from double-stopping
		services[leavingIdx] = null as any
		nodes[leavingIdx] = null as any
	})

	// 7. Scale routing — 10 nodes, multiple route requests
	it('10 nodes route multiple messages with bounded hops', async () => {
		const mesh = await makeMesh(10, { k: 7 })
		nodes = mesh.nodes
		services = mesh.services

		await new Promise(r => setTimeout(r, 6000))

		const keys = ['alpha', 'bravo', 'charlie', 'delta', 'echo']
		const results: Array<{ key: string; type: string }> = []

		for (let i = 0; i < keys.length; i++) {
			const keyBytes = u8FromString(keys[i]!, 'utf8')
			const keyB64 = Buffer.from(keyBytes).toString('base64url')
			const srcIdx = (i * 3) % 10 // spread across different source nodes
			const msg = makeRouteMsg(keyB64, 10)
			const res = await services[srcIdx]!.routeAct(msg)

			if ('anchors' in res) {
				results.push({ key: keys[i]!, type: 'NearAnchor' })
			} else if ('commitCertificate' in res) {
				results.push({ key: keys[i]!, type: 'commit' })
			}
		}

		// All should have returned a valid response
		expect(results.length).to.equal(keys.length)
		for (const r of results) {
			expect(['NearAnchor', 'commit']).to.include(r.type,
				`key "${r.key}" got unexpected response type`)
		}

		// Check forwarding diagnostics — total forwarded hops should be bounded
		const totalForwarded = services.reduce((sum, svc) => {
			if (!svc) return sum
			return sum + svc.getDiagnostics().maybeActForwarded
		}, 0)
		const maxExpected = Math.ceil(Math.log2(10) + 2) * keys.length
		expect(totalForwarded).to.be.at.most(maxExpected,
			`total forwarded hops ${totalForwarded} exceeds expected bound ${maxExpected}`)
	})
})
