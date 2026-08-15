import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode } from './helpers/libp2p.js'
import { FretService } from '../src/service/fret-service.js'
import { makeProtocols } from '../src/rpc/protocols.js'

// @types/node is not a dependency of this package; declare only the surface this spec needs.
declare const process: {
	on(event: 'unhandledRejection', listener: (reason: unknown) => void): void
	off(event: 'unhandledRejection', listener: (reason: unknown) => void): void
}

const NETWORK = 'lifecycle-test'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Protocols this service registers, so assertions ignore libp2p's own handlers. */
const ours = Object.values(makeProtocols(NETWORK))

function fretProtocols(node: Libp2p): string[] {
	return node.getProtocols().filter((p) => ours.includes(p))
}

/**
 * Count the listeners FretService attached, without reaching for a hardcoded number:
 * the service tracks each one in `nodeListeners`, and a duplicate-registration bug shows
 * up as growth in that array, not as a specific total.
 */
function listenerCount(svc: FretService): number {
	return (svc as unknown as { nodeListeners: unknown[] }).nodeListeners.length
}

describe('FretService start/stop lifecycle', function () {
	this.timeout(30000)

	let node: Libp2p
	let svc: FretService

	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
		svc = new FretService(node, { networkName: NETWORK })
	})

	afterEach(async () => {
		try { await svc.stop() } catch { /* already stopped */ }
		try { await node.stop() } catch { /* already stopped */ }
	})

	it('registers all protocol handlers on start and removes them on stop', async () => {
		expect(fretProtocols(node), 'before start').to.have.length(0)
		await svc.start()
		expect(fretProtocols(node), 'after start').to.have.length(ours.length)
		await svc.stop()
		expect(fretProtocols(node), 'after stop').to.have.length(0)
	})

	it('stop() on a never-started service is a no-op', async () => {
		await svc.stop()
		expect(fretProtocols(node)).to.have.length(0)
	})

	it('restarts without unhandled rejections and re-registers its handlers', async () => {
		const rejections: unknown[] = []
		const onRejection = (reason: unknown) => { rejections.push(reason) }
		process.on('unhandledRejection', onRejection)
		try {
			await svc.start()
			await svc.stop()
			await svc.start()
			await delay(300)
		} finally {
			process.off('unhandledRejection', onRejection)
		}
		expect(rejections, `unhandled rejections: ${rejections.map(String).join(', ')}`).to.have.length(0)
		expect(fretProtocols(node), 'after restart').to.have.length(ours.length)
	})

	it('leaves exactly one stabilization loop running after a stop/start cycle', async () => {
		let ticks = 0
		// Replace the tick body so the count reflects loop cadence, not network work.
		;(svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce = async () => { ticks++ }

		await svc.start()
		await svc.stop()
		await svc.start()

		ticks = 0
		await delay(3400)
		// 1500 ms passive cadence => ~2 ticks (3 allowing for the immediate leading tick and
		// scheduling slop). Two concurrent loops produced 5 before the fix.
		expect(ticks, 'stabilization ticks in 3.4 s').to.be.at.most(3)
	})

	it('stops the stabilization loop entirely after stop()', async () => {
		let ticks = 0
		;(svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce = async () => { ticks++ }

		await svc.start()
		await delay(1700)
		await svc.stop()

		ticks = 0
		await delay(3400)
		expect(ticks, 'ticks after stop').to.equal(0)
	})

	it('double start() does not duplicate listeners or re-register protocols', async () => {
		await svc.start()
		const listeners = listenerCount(svc)
		const protocols = fretProtocols(node).length
		await svc.start()
		expect(listenerCount(svc), 'listener count after second start').to.equal(listeners)
		expect(fretProtocols(node), 'protocol count after second start').to.have.length(protocols)
	})

	it('re-runs the first-tick proactive announce after a restart', async () => {
		let announces = 0
		const internals = svc as unknown as {
			proactiveAnnounceOnStart: () => Promise<void>
			postBootstrapAnnounced: boolean
		}
		internals.proactiveAnnounceOnStart = async () => { announces++ }

		await svc.start()
		await delay(200)
		expect(announces, 'announce on first run').to.equal(1)

		await svc.stop()
		// A restarted service must announce again rather than inherit the previous run's
		// "already announced" state.
		await svc.start()
		await delay(200)
		expect(announces, 'announce again on second run').to.equal(2)
		expect(internals.postBootstrapAnnounced, 'postBootstrapAnnounced reset').to.equal(false)
	})

	it('runs exactly one active-preconnect loop across setMode churn', async () => {
		const armed = () => (svc as unknown as { preconnectGen: number }).preconnectGen
		await svc.start()
		expect(armed(), 'no preconnect loop in passive mode').to.equal(-1)
		svc.setMode('active')
		const gen = armed()
		expect(gen, 'loop armed for the current run').to.be.at.least(0)
		svc.setMode('active')
		expect(armed(), 'repeated setMode does not arm a second loop').to.equal(gen)
		await svc.stop()
		expect(armed(), 'loop released on stop').to.equal(-1)
	})
})
