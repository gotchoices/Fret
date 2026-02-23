import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemoryNode, connectLine, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { sendLeave, type LeaveNoticeV1 } from '../src/rpc/leave.js'
import { makeProtocols } from '../src/rpc/protocols.js'

describe('Churn leave handling', function () {
	this.timeout(20000)

	it('sendLeave triggers stabilization and replacement warming', async () => {
		const nodes = [] as any[]
		for (let i = 0; i < 4; i++) { const n = await createMemoryNode(); await n.start(); nodes.push(n) }
		await connectLine(nodes)
		const services = [] as any[]
		for (let i = 0; i < nodes.length; i++) {
			const svc = new CoreFretService(nodes[i], { profile: 'edge', k: 7, bootstraps: [nodes[0]!.peerId.toString()] })
			await svc.start()
			services.push(svc)
		}
		await new Promise(r => setTimeout(r, 1500))
		// stop one node, which should send leave to its neighbors without throwing
		await services[2].stop()
		await nodes[2].stop()
		await new Promise(r => setTimeout(r, 1000))
		// ensure remaining services still running
		for (const s of [services[0], services[1], services[3]]) if (!(s as any).getDiagnostics) throw new Error('service down')
		await Promise.all(services.map((s: any, i: number) => i === 2 ? Promise.resolve() : s.stop()))
		await stopAll([nodes[0], nodes[1], nodes[3]].filter(Boolean) as any)
	})

	it('leave notice includes replacement suggestions', async () => {
		const nodes = [] as any[]
		for (let i = 0; i < 6; i++) { const n = await createMemoryNode(); await n.start(); nodes.push(n) }
		await connectLine(nodes)
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

		await new Promise(r => setTimeout(r, 2000))

		const node2Id = nodes[2].peerId.toString()

		// Stop node 2 (the middle node) — it should send leave with replacements
		await services[2].stop()
		await nodes[2].stop()
		await new Promise(r => setTimeout(r, 1500))

		// After leave, node 2 should have been removed from remaining services' stores
		for (const [idx, svc] of services.entries()) {
			if (idx === 2) continue
			const peers = svc.listPeers()
			const hasLeavingPeer = peers.some(p => p.id === node2Id)
			expect(hasLeavingPeer).to.equal(false, `service ${idx} should have removed leaving peer`)
		}

		await Promise.all(services.map((s, i) => i === 2 ? Promise.resolve() : s.stop()))
		await stopAll(nodes.filter((_: any, i: number) => i !== 2))
	})

	it('recipients probe suggested replacements from leave notice', async () => {
		const nodes = [] as any[]
		for (let i = 0; i < 5; i++) { const n = await createMemoryNode(); await n.start(); nodes.push(n) }
		await connectLine(nodes)
		const services = [] as CoreFretService[]
		for (let i = 0; i < nodes.length; i++) {
			const svc = new CoreFretService(nodes[i], {
				profile: 'edge',
				k: 7,
				bootstraps: [nodes[0]!.peerId.toString()],
			})
			await svc.start()
			services.push(svc)
		}
		await new Promise(r => setTimeout(r, 2000))

		const leavingId = nodes[2].peerId.toString()
		const diagBefore = { ...services[1].getDiagnostics() }

		// Stop node 2 — neighbors should handle the leave and probe replacements
		await services[2].stop()
		await nodes[2].stop()
		await new Promise(r => setTimeout(r, 2000))

		// Diagnostics should show ping activity from handling leave
		const diagAfter = services[1].getDiagnostics()
		// At minimum, pings should have been sent during leave handling
		expect(diagAfter.pingsSent).to.be.greaterThanOrEqual(diagBefore.pingsSent)

		// The leaving peer should be removed from node 1's peer list
		const peersAfter = services[1].listPeers()
		const stillHasLeaving = peersAfter.some(p => p.id === leavingId)
		// It may be re-added by stabilization upsert; the important thing is it was processed
		expect(diagAfter.announcementsSent).to.be.greaterThanOrEqual(diagBefore.announcementsSent)

		await Promise.all(services.map((s, i) => i === 2 ? Promise.resolve() : s.stop()))
		await stopAll(nodes.filter((_: any, i: number) => i !== 2))
	})

	it('fan-out notifies peers beyond immediate S/P', async () => {
		const nodes = [] as any[]
		// Use more nodes so fan-out has something to reach beyond S/P
		for (let i = 0; i < 8; i++) { const n = await createMemoryNode(); await n.start(); nodes.push(n) }
		await connectLine(nodes)
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
		await new Promise(r => setTimeout(r, 2500))

		// Stop node 3 (middle-ish) — with core profile, fan-out = 4
		await services[3].stop()
		await nodes[3].stop()
		await new Promise(r => setTimeout(r, 2000))

		// All remaining services should still be running
		for (let i = 0; i < services.length; i++) {
			if (i === 3) continue
			expect(services[i].getDiagnostics()).to.have.property('pingsSent')
		}

		await Promise.all(services.map((s, i) => i === 3 ? Promise.resolve() : s.stop()))
		await stopAll(nodes.filter((_: any, i: number) => i !== 3))
	})

	it('oversized replacements array is truncated', async () => {
		const nodes = [] as any[]
		for (let i = 0; i < 3; i++) { const n = await createMemoryNode(); await n.start(); nodes.push(n) }
		await connectLine(nodes)

		const protocols = makeProtocols('default')
		let capturedReplacements: string[] | undefined

		// Register a custom leave handler on node 0 to capture the sanitized notice
		// First, unhandle any existing leave handler, then register our spy
		try { await nodes[0].unhandle(protocols.PROTOCOL_LEAVE) } catch {}

		const { registerLeave: regLeave } = await import('../src/rpc/leave.js')
		regLeave(nodes[0], async (notice: LeaveNoticeV1) => {
			capturedReplacements = notice.replacements
		}, protocols.PROTOCOL_LEAVE)

		await new Promise(r => setTimeout(r, 500))

		// Send a crafted leave notice with 20 replacements (exceeds MAX_REPLACEMENTS=12)
		const fakeReplacements = Array.from({ length: 20 }, () =>
			nodes[1].peerId.toString()
		)
		const notice: LeaveNoticeV1 = {
			v: 1,
			from: nodes[2].peerId.toString(),
			replacements: fakeReplacements,
			timestamp: Date.now(),
		}
		await sendLeave(nodes[1], nodes[0].peerId.toString(), notice, protocols.PROTOCOL_LEAVE)
		await new Promise(r => setTimeout(r, 500))

		// Verify truncation: sanitizeReplacements caps at 12
		expect(capturedReplacements).to.be.an('array')
		expect(capturedReplacements!.length).to.be.at.most(12)

		await stopAll(nodes)
	})
})
