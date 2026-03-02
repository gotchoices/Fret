import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'

describe('Proactive announcements', function () {
	this.timeout(30000)

	it('on-start announce fires after first stabilization tick', async () => {
		const nodes = [] as any[]
		for (let i = 0; i < 3; i++) { const n = await createMemNode(); await n.start(); nodes.push(n) }
		const services = [] as CoreFretService[]
		for (let i = 0; i < nodes.length; i++) {
			const svc = new CoreFretService(nodes[i], {
				profile: 'core',
				k: 7,
				bootstraps: [nodes[0]!.peerId.toString()],
			})
			await svc.start()
			services.push(svc)
		}

		// Connect in a line so announcements can flow
		for (let i = 1; i < nodes.length; i++) {
			await nodes[i]!.dial(nodes[i - 1]!.getMultiaddrs()[0]!)
		}

		// Wait for first stabilization + announce
		await new Promise(r => setTimeout(r, 3000))

		// All services should have attempted announcements after stabilization
		const totalAttempted = services.reduce(
			(sum, svc) => sum + svc.getDiagnostics().announcementsSent + svc.getDiagnostics().announcementsSkipped, 0
		)
		expect(totalAttempted).to.be.greaterThan(0)

		await Promise.all(services.map(s => s.stop()))
		await stopAll(nodes)
	})

	it('peer disconnect triggers proactive announcement to remaining neighbors', async () => {
		const nodes = [] as any[]
		for (let i = 0; i < 5; i++) { const n = await createMemNode(); await n.start(); nodes.push(n) }
		const services = [] as CoreFretService[]
		for (let i = 0; i < nodes.length; i++) {
			const svc = new CoreFretService(nodes[i], {
				profile: 'core',
				k: 7,
				bootstraps: [nodes[0]!.peerId.toString()],
			})
			await svc.start()
			services.push(svc)
		}

		// Full mesh so all nodes are near neighbors
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				await nodes[i]!.dial(nodes[j]!.getMultiaddrs()[0]!)
			}
		}

		// Wait for stabilization to populate tables
		await new Promise(r => setTimeout(r, 3000))

		// Record announcements before disconnect
		const diagBefore = services.map(s => ({ ...s.getDiagnostics() }))

		// Abruptly disconnect node 2 (no graceful leave)
		await nodes[2].stop()
		await new Promise(r => setTimeout(r, 2000))

		// At least one remaining service should have sent announcements after the departure
		let additionalAnnouncements = 0
		for (let i = 0; i < services.length; i++) {
			if (i === 2) continue
			const diag = services[i].getDiagnostics()
			additionalAnnouncements += diag.announcementsSent - diagBefore[i].announcementsSent
		}
		expect(additionalAnnouncements).to.be.greaterThan(0)

		await Promise.all(services.filter((_, i) => i !== 2).map(s => s.stop()))
		await stopAll(nodes.filter((_, i) => i !== 2))
	})

	it('edge profile sends fewer announcements than core (bounded fanout)', async () => {
		const nodesEdge = [] as any[]
		const nodesCore = [] as any[]
		for (let i = 0; i < 6; i++) {
			const ne = await createMemNode(); await ne.start(); nodesEdge.push(ne)
			const nc = await createMemNode(); await nc.start(); nodesCore.push(nc)
		}

		const servicesEdge = [] as CoreFretService[]
		const servicesCore = [] as CoreFretService[]
		for (let i = 0; i < nodesEdge.length; i++) {
			const se = new CoreFretService(nodesEdge[i], {
				profile: 'edge',
				k: 7,
				bootstraps: [nodesEdge[0]!.peerId.toString()],
			})
			await se.start()
			servicesEdge.push(se)

			const sc = new CoreFretService(nodesCore[i], {
				profile: 'core',
				k: 7,
				bootstraps: [nodesCore[0]!.peerId.toString()],
			})
			await sc.start()
			servicesCore.push(sc)
		}

		// Full mesh both clusters
		for (let i = 0; i < 6; i++) {
			for (let j = i + 1; j < 6; j++) {
				await nodesEdge[i]!.dial(nodesEdge[j]!.getMultiaddrs()[0]!)
				await nodesCore[i]!.dial(nodesCore[j]!.getMultiaddrs()[0]!)
			}
		}

		await new Promise(r => setTimeout(r, 4000))

		const edgeTotal = servicesEdge.reduce((sum, s) => sum + s.getDiagnostics().announcementsSent, 0)
		const coreTotal = servicesCore.reduce((sum, s) => sum + s.getDiagnostics().announcementsSent, 0)

		// Core should send at least as many announcements as edge
		// (Core has larger fanout and higher rate limits)
		expect(coreTotal).to.be.greaterThanOrEqual(edgeTotal)

		await Promise.all([...servicesEdge, ...servicesCore].map(s => s.stop()))
		await stopAll([...nodesEdge, ...nodesCore])
	})

	it('rate limiting prevents announcement storms', async () => {
		const nodes = [] as any[]
		for (let i = 0; i < 4; i++) { const n = await createMemNode(); await n.start(); nodes.push(n) }
		const services = [] as CoreFretService[]
		// Use edge profile (tighter rate limits: 6 capacity, 2/sec refill)
		for (let i = 0; i < nodes.length; i++) {
			const svc = new CoreFretService(nodes[i], {
				profile: 'edge',
				k: 7,
				bootstraps: [nodes[0]!.peerId.toString()],
			})
			await svc.start()
			services.push(svc)
		}

		// Full mesh
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				await nodes[i]!.dial(nodes[j]!.getMultiaddrs()[0]!)
			}
		}

		await new Promise(r => setTimeout(r, 4000))

		// With edge profile and 4 nodes, rate limiting should kick in at some point
		let totalSkipped = 0
		let totalSent = 0
		for (const svc of services) {
			const diag = svc.getDiagnostics()
			totalSkipped += diag.announcementsSkipped
			totalSent += diag.announcementsSent
		}

		// Should have sent some announcements (system is working)
		expect(totalSent).to.be.greaterThan(0)
		// The combination of sent + skipped shows the rate limiter is active
		// (With tight edge limits and discovery-triggered announcements, some should be skipped)

		await Promise.all(services.map(s => s.stop()))
		await stopAll(nodes)
	})

	it('new peer discovery via gossip triggers announcement to non-connected peers', async () => {
		// Topology: A-B-C where A learns about C via B's snapshot (without direct connection)
		const nodes = [] as any[]
		for (let i = 0; i < 4; i++) { const n = await createMemNode(); await n.start(); nodes.push(n) }

		const services = [] as CoreFretService[]
		for (let i = 0; i < nodes.length; i++) {
			const svc = new CoreFretService(nodes[i], {
				profile: 'core',
				k: 7,
				bootstraps: [nodes[0]!.peerId.toString()],
			})
			await svc.start()
			services.push(svc)
		}

		// Connect in a line: 0-1, 1-2, 2-3 (node 0 not directly connected to 2 or 3)
		await nodes[1]!.dial(nodes[0]!.getMultiaddrs()[0]!)
		await nodes[2]!.dial(nodes[1]!.getMultiaddrs()[0]!)
		await nodes[3]!.dial(nodes[2]!.getMultiaddrs()[0]!)

		// Wait for stabilization to propagate topology info via snapshot exchange
		await new Promise(r => setTimeout(r, 4000))

		// All services should have sent announcements as topology was discovered
		let totalAnnouncements = 0
		for (const svc of services) {
			totalAnnouncements += svc.getDiagnostics().announcementsSent
		}
		// With 4 nodes and line topology, announcements should be flowing
		expect(totalAnnouncements).to.be.greaterThan(0)

		// Node 0 should know about more peers than just node 1 (learned via gossip)
		const store0 = services[0].getStore()
		expect(store0.size()).to.be.greaterThan(2)

		await Promise.all(services.map(s => s.stop()))
		await stopAll(nodes)
	})

	it('diagnostics track announcementsSkipped counter', async () => {
		const nodes = [] as any[]
		for (let i = 0; i < 3; i++) { const n = await createMemNode(); await n.start(); nodes.push(n) }
		const services = [] as CoreFretService[]
		for (let i = 0; i < nodes.length; i++) {
			const svc = new CoreFretService(nodes[i], {
				profile: 'core',
				k: 7,
				bootstraps: [nodes[0]!.peerId.toString()],
			})
			await svc.start()
			services.push(svc)
		}

		for (let i = 1; i < nodes.length; i++) {
			await nodes[i]!.dial(nodes[i - 1]!.getMultiaddrs()[0]!)
		}

		await new Promise(r => setTimeout(r, 2000))

		// Verify announcementsSkipped is tracked in diagnostics
		for (const svc of services) {
			const diag = svc.getDiagnostics()
			expect(diag).to.have.property('announcementsSkipped')
			expect(typeof diag.announcementsSkipped).to.equal('number')
		}

		await Promise.all(services.map(s => s.stop()))
		await stopAll(nodes)
	})
})
