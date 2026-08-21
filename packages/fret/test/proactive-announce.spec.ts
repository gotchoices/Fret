import { describe, it } from 'mocha'
import { expect } from 'chai'
import { buildMesh } from './helpers/mesh.js'

describe('Proactive announcements', function () {
	this.timeout(30000)

	// NOTE: every test here still gates on a fixed 2-4 s sleep rather than on a condition, so each
	// one's premise ("announcements happened at all") is a wall-clock bet, not an observation. That
	// is tolerable today — announces fire on the first stabilization tick, so the sleeps carry
	// several ticks of headroom — but these are now the file's *load-bearing* assertions rather
	// than the throwaway `> 0` checks they replaced. If any of them starts flaking on slower CI,
	// the fix is a `waitFor` on the announce counters (see `helpers/wait-for.ts` and the converge
	// gates in `churn.leave.spec.ts`), not a longer sleep.

	it('on-start announce fires after first stabilization tick', async () => {
		const mesh = await buildMesh(3)
		await mesh.addServices({ profile: 'core', k: 7, bootstraps: [mesh.ids[0]!] })
		await mesh.connect('line')

		// Wait for first stabilization + announce
		await new Promise(r => setTimeout(r, 3000))

		// All services should have attempted announcements after stabilization
		const totalAttempted = mesh.services.reduce(
			(sum, svc) => sum + svc.getDiagnostics().announcementsSent + svc.getDiagnostics().announcementsSkipped, 0
		)
		expect(totalAttempted).to.be.greaterThan(0)

		await mesh.stop()
	})

	it('peer disconnect triggers proactive announcement to remaining neighbors', async () => {
		const mesh = await buildMesh(5)
		await mesh.addServices({ profile: 'core', k: 7, bootstraps: [mesh.ids[0]!] })
		await mesh.connect('full')

		// Wait for stabilization to populate tables
		await new Promise(r => setTimeout(r, 3000))

		// Record announcements before disconnect
		const diagBefore = mesh.services.map(s => ({ ...s.getDiagnostics() }))

		// Abruptly disconnect node 2 (no graceful leave)
		await mesh.nodes[2]!.stop()
		await new Promise(r => setTimeout(r, 2000))

		// At least one remaining service should have sent announcements after the departure
		let additionalAnnouncements = 0
		for (let i = 0; i < mesh.services.length; i++) {
			if (i === 2) continue
			const diag = mesh.services[i]!.getDiagnostics()
			additionalAnnouncements += diag.announcementsSent - diagBefore[i]!.announcementsSent
		}
		expect(additionalAnnouncements).to.be.greaterThan(0)

		await mesh.stop({ skip: [2] })
	})

	it('edge profile sends fewer announcements than core (bounded fanout)', async () => {
		const edgeMesh = await buildMesh(6)
		await edgeMesh.addServices({ profile: 'edge', k: 7, bootstraps: [edgeMesh.ids[0]!] })
		await edgeMesh.connect('full')

		const coreMesh = await buildMesh(6)
		await coreMesh.addServices({ profile: 'core', k: 7, bootstraps: [coreMesh.ids[0]!] })
		await coreMesh.connect('full')

		await new Promise(r => setTimeout(r, 4000))

		const edgeTotal = edgeMesh.services.reduce((sum, s) => sum + s.getDiagnostics().announcementsSent, 0)
		const coreTotal = coreMesh.services.reduce((sum, s) => sum + s.getDiagnostics().announcementsSent, 0)

		// Premise first: `coreTotal >= edgeTotal` holds when both are 0, so a total announce
		// outage on both clusters used to pass this test.
		expect(edgeTotal, 'premise: the edge cluster announced at all').to.be.greaterThan(0)
		expect(coreTotal, 'premise: the core cluster announced at all').to.be.greaterThan(0)

		// Core should send at least as many announcements as edge (larger fanout, higher rate
		// limits). Deliberately not strict `>`: fan-out is a *ceiling*, and on a six-node mesh
		// both profiles can legitimately saturate below it and tie.
		expect(coreTotal).to.be.greaterThanOrEqual(edgeTotal)

		await Promise.all([edgeMesh.stop(), coreMesh.stop()])
	})

	// NOTE: `rate limiting prevents announcement storms` used to sit here. It computed a
	// `totalSkipped` it never asserted on, leaving `totalSent > 0` as its only claim — which the
	// three tests around it already make. The announce bucket's actual contract (a burst stops at
	// the first skip, so one call adds at most +1 to `announcementsSkipped`) is pinned
	// deterministically by `stops the departure burst at the first empty-bucket skip` in
	// `churn.leave.spec.ts`.

	it('new peer discovery via gossip triggers announcement to non-connected peers', async () => {
		// Topology: A-B-C where A learns about C via B's snapshot (without direct connection)
		const mesh = await buildMesh(4)
		await mesh.addServices({ profile: 'core', k: 7, bootstraps: [mesh.ids[0]!] })
		await mesh.connect('line')

		// Wait for stabilization to propagate topology info via snapshot exchange
		await new Promise(r => setTimeout(r, 4000))

		// All services should have sent announcements as topology was discovered
		let totalAnnouncements = 0
		for (const svc of mesh.services) {
			totalAnnouncements += svc.getDiagnostics().announcementsSent
		}
		// With 4 nodes and line topology, announcements should be flowing
		expect(totalAnnouncements).to.be.greaterThan(0)

		// Node 0 should know about more peers than just node 1 (learned via gossip)
		const store0 = mesh.services[0]!.getStore()
		expect(store0.size()).to.be.greaterThan(2)

		await mesh.stop()
	})

	// NOTE: `diagnostics track announcementsSkipped counter` used to sit here. It stood up three
	// nodes and slept 2 s to assert that a diagnostics field exists and holds a number, which the
	// type system already states. The counter's behavior is pinned in `churn.leave.spec.ts` — see
	// the note above.
})
