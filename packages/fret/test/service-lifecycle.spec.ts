import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode } from './helpers/libp2p.js'
import { FretService } from '../src/service/fret-service.js'
import { makeProtocols, isUnsupportedProtocolError } from '../src/rpc/protocols.js'
import { sendPing } from '../src/rpc/ping.js'

const NETWORK = 'lifecycle-test'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const PROTOCOLS = makeProtocols(NETWORK)
/** Protocols this service registers, so assertions ignore libp2p's own handlers. */
const ours = Object.values(PROTOCOLS)

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

	it('stops answering namespaced RPCs after stop(), not merely deregistering them', async () => {
		// getProtocols() going empty is the registrar's view; a peer holding an open
		// connection is the view that matters, so assert from the far side of the wire.
		const peer = await createMemNode()
		await peer.start()
		try {
			await peer.dial(node.getMultiaddrs()[0]!)
			await svc.start()
			const live = await sendPing(peer, node.peerId.toString(), PROTOCOLS.PROTOCOL_PING)
			expect(live.ok, 'ping answered while running').to.equal(true)

			await svc.stop()
			let failure: unknown
			try {
				await sendPing(peer, node.peerId.toString(), PROTOCOLS.PROTOCOL_PING)
			} catch (err) { failure = err }
			expect(failure, 'ping after stop must not be answered').to.not.equal(undefined)
			expect(isUnsupportedProtocolError(failure), `unexpected error: ${String(failure)}`).to.equal(true)
		} finally {
			await peer.stop()
		}
	})

	it('does not re-arm the stabilization timer when stop() lands mid-tick', async () => {
		// Exercises the *second* generation guard — the one after the tick's awaits, which
		// the cadence specs above cannot reach (they only cover the guard at the top of the
		// tick). Assert on the timer handle, not on tick counts: a tick armed after stop()
		// still short-circuits at the top guard, so the count stays 0 either way.
		let unpark: (() => void) | undefined
		const parked = new Promise<void>((tickEntered) => {
			;(svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce = async () => {
				tickEntered()
				await new Promise<void>((resume) => { unpark = resume })
			}
		})
		const timer = () => (svc as unknown as { stabilizeTimer: unknown }).stabilizeTimer

		await svc.start()
		await parked
		await svc.stop()
		expect(timer(), 'timer cleared by stop()').to.equal(null)

		unpark!()
		await delay(50)
		expect(timer(), 'interrupted tick must not re-arm the timer').to.equal(null)
	})

	it('double stop() does not repeat the shutdown work', async () => {
		let leaves = 0
		;(svc as unknown as { sendLeaveToNeighbors: () => Promise<void> }).sendLeaveToNeighbors = async () => { leaves++ }

		await svc.start()
		await svc.stop()
		await svc.stop()
		expect(leaves, 'leave fan-out runs once per started run').to.equal(1)
	})
})
