import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { PeerId, Stream } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { createMemNode } from './helpers/libp2p.js'
import { waitFor } from './helpers/wait-for.js'
import { FretService } from '../src/service/fret-service.js'
import { makeProtocols } from '../src/rpc/protocols.js'
import { sendPing } from '../src/rpc/ping.js'
import { hashPeerId } from '../src/ring/hash.js'

const NETWORK = 'lifecycle-test'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * `private static` on the service. Read off the class rather than restating the numbers, so the
 * shutdown bounds below track the constants instead of drifting from them.
 */
const { SHUTDOWN_BUDGET_MS, LEAVE_NOTICE_TIMEOUT_MS } = FretService as unknown as {
	SHUTDOWN_BUDGET_MS: number
	LEAVE_NOTICE_TIMEOUT_MS: number
}

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

/**
 * A peer libp2p holds an address for but that nothing answers at.
 *
 * Seeded through the peerStore rather than the service's `addressKnown` set because the
 * stabilization tick rebuilds that set wholesale from the peerStore on every pass — a
 * directly-poked entry would be dropped again before `stop()` ran. Returns the ghost's id.
 */
async function createGhost(node: Libp2p): Promise<string> {
	const ghost = await createMemNode()
	await ghost.start()
	await node.peerStore.merge(ghost.peerId, { multiaddrs: ghost.getMultiaddrs() })
	await ghost.stop()
	return ghost.peerId.toString()
}

interface HangingDials {
	/** Dials to a ghost that were actually issued. */
	attempted: number
	/** Ghost dials that arrived with no abort signal — see below; must stay 0. */
	unsignaled: number
	restore: () => void
}

/**
 * Make dials to `ghosts` settle *only* on signal abort — libp2p's `AbortOptions` contract for
 * `dialProtocol`, and therefore the only thing that can end a stalled open (see `hangsUntilAbort`
 * in `rpc.protocols.spec.ts`). Non-ghost peers pass straight through.
 *
 * A ghost dial arriving with **no** signal is counted in `unsignaled` and rejected rather than
 * left to hang. Hanging would also fail the run, but only as an opaque 30 s mocha timeout; the
 * counter names the regression it guards — dropping `signal` from `openRpcStream`'s
 * `NewStreamOptions`, which is what makes a stalled dial unbounded in the first place.
 */
function hangGhostDials(node: Libp2p, ghosts: Set<string>): HangingDials {
	const originalDial = node.dialProtocol.bind(node)
	const state: HangingDials = {
		attempted: 0,
		unsignaled: 0,
		restore: () => { (node as unknown as { dialProtocol: unknown }).dialProtocol = originalDial },
	}
	;(node as unknown as { dialProtocol: unknown }).dialProtocol = (pid: PeerId, protocols: string[], opts: { signal?: AbortSignal }) => {
		if (!ghosts.has(pid.toString())) return originalDial(pid, protocols, opts)
		state.attempted++
		const signal = opts?.signal
		if (signal == null) {
			state.unsignaled++
			return Promise.reject(new Error('ghost dial issued with no abort signal'))
		}
		return new Promise<Stream>((_resolve, reject) => {
			const fail = (): void => { reject(new Error('ghost dial aborted')) }
			if (signal.aborted) { fail(); return }
			signal.addEventListener('abort', fail, { once: true })
		})
	}
	return state
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
			if (live.kind !== 'ok') throw new Error(`expected ok, got ${live.kind}`)
			expect(live.value.ok, 'ping answered while running').to.equal(true)

			await svc.stop()
			const after = await sendPing(peer, node.peerId.toString(), PROTOCOLS.PROTOCOL_PING)
			expect(after.kind, 'ping after stop must not be answered').to.equal('foreign-protocol')
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

	it('stays inside its shutdown budget when a dial hangs, and still notifies reachable neighbors', async () => {
		// The leave fan-out runs *after* stop() aborted the run signal, so it carries its own
		// budget instead. This asserts that budget actually binds: one neighbor whose dial never
		// settles on its own must not hold the teardown open, and must not cost the reachable
		// neighbor its notice.
		const peer = await createMemNode()
		await peer.start()
		const peerSvc = new FretService(peer, { networkName: NETWORK })
		let dials: HangingDials | undefined
		try {
			await peerSvc.start()
			// Connected, hence dialable and not a doomed dial: the notice to this one must land.
			await node.dial(peer.getMultiaddrs()[0]!)

			const ghostId = await createGhost(node)

			// The tick's own probe passes would dial the ghost on their own schedule; the
			// assertions here are about stop(), so keep the loop from racing them. `seedFromPeerStore`
			// is deliberately left alone — it is what puts both peers in the ring.
			;(svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce = async () => {}
			await svc.start()
			expect(svc.getStore().getById(ghostId), 'ghost seeded into the routing table').to.not.equal(undefined)

			// Only the ghost is intercepted; the connected peer never reaches `dialProtocol` at all,
			// since `openRpcStream` reuses its connection.
			dials = hangGhostDials(node, new Set([ghostId]))

			// `registerLeave` bound the closure `(notice) => this.handleLeave(notice)` at start(), so
			// overriding `handleLeave` now is still picked up. Counting here beats asserting "the
			// departing id left the receiver's store": the receiver re-seeds from its own peerStore
			// every tick and would put the id straight back.
			let leaves = 0
			const originalHandleLeave = (peerSvc as unknown as { handleLeave: (n: unknown) => Promise<void> }).handleLeave.bind(peerSvc)
			;(peerSvc as unknown as { handleLeave: unknown }).handleLeave = async (n: unknown) => { leaves++; await originalHandleLeave(n) }

			const started = Date.now()
			await svc.stop()
			const elapsed = Date.now() - started

			// Generous on purpose (the per-notice timeout on top of the whole-fan-out budget): the
			// property under test is "bounded at all", not scheduler precision. Do not swap it for a
			// bare "stop() resolved" — that is exactly the assertion an unbounded dial would pass.
			expect(elapsed, `stop() elapsed ${elapsed}ms`).to.be.at.most(SHUTDOWN_BUDGET_MS + 1500)
			expect(dials.attempted, 'the hanging dial was actually attempted').to.be.at.least(1)
			expect(dials.unsignaled, 'every ghost dial carried an abort signal').to.equal(0)
			// `sendLeave` is write-only — it does not await the remote handler — so the delivery is
			// observed after stop() returns rather than by the time it does.
			await waitFor(() => leaves === 1, 5000, 25, 'leave notice delivered to the reachable neighbor')
			expect(leaves, 'exactly one notice per reachable neighbor').to.equal(1)
		} finally {
			dials?.restore()
			try { await peerSvc.stop() } catch { /* already stopped */ }
			await peer.stop()
		}
	})

	it('cuts the whole leave fan-out short once the shutdown budget expires', async () => {
		// The test above pins the *per-notice* timeout: with one hanging neighbor that is what
		// binds, since LEAVE_NOTICE_TIMEOUT_MS < SHUTDOWN_BUDGET_MS. Five hanging neighbors cost
		// 5 × LEAVE_NOTICE_TIMEOUT_MS of per-notice timeouts, well past the whole-fan-out budget,
		// so here it is SHUTDOWN_BUDGET_MS that has to bind — and the fan-out abandoning notices
		// it never got to is the direct, clock-independent evidence that it did.
		const GHOSTS = 5
		expect(GHOSTS * LEAVE_NOTICE_TIMEOUT_MS, 'enough hanging notices to overrun the budget').to.be.above(SHUTDOWN_BUDGET_MS)

		// Silence both passes that dial on their own schedule — the probe tick and the first-tick
		// announce, which dials deliberately — so every dial counted below is the leave fan-out's.
		;(svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce = async () => {}
		;(svc as unknown as { proactiveAnnounceOnStart: () => Promise<void> }).proactiveAnnounceOnStart = async () => {}

		const ghosts = new Set<string>()
		for (let i = 0; i < GHOSTS; i++) ghosts.add(await createGhost(node))
		await svc.start()
		for (const id of ghosts) expect(svc.getStore().getById(id), `ghost ${id} seeded into the routing table`).to.not.equal(undefined)

		const dials = hangGhostDials(node, ghosts)
		try {
			const started = Date.now()
			await svc.stop()
			const elapsed = Date.now() - started
			expect(elapsed, `stop() elapsed ${elapsed}ms`).to.be.at.most(SHUTDOWN_BUDGET_MS + 1500)
			expect(dials.attempted, 'fan-out issued notices').to.be.at.least(1)
			expect(dials.attempted, 'fan-out gave up before dialing every neighbor').to.be.below(GHOSTS)
			expect(dials.unsignaled, 'every ghost dial carried an abort signal').to.equal(0)
		} finally {
			dials.restore()
		}
	})

	it('issues no dials and strikes nobody when stop() lands mid-tick', async () => {
		// The tick captures `runSignal` inside each pass, and `stabilizeOnce` re-checks nothing
		// between them — so an interrupted tick is stopped by the *signal*, not by a flag. That is
		// why `stop()` keeps the aborted controller instead of nulling it; without this test the
		// service can silently regress to a null and every pass would resume dialing after stop().
		const store = svc.getStore()
		// A well-formed, address-known member, so the resumed tick has a genuine probe target and
		// the "nothing happened" assertions below are not vacuous.
		const targetPid = peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
		const targetId = targetPid.toString()
		store.upsert(targetId, await hashPeerId(targetPid))
		store.setMembership(targetId, 'member')
		;(svc as unknown as { setAddressKnown: (id: string, known: boolean) => void }).setAddressKnown(targetId, true)

		// Park `seedFromPeerStore`: it is the only awaited seam ahead of every signal capture, so
		// parking there is what puts stop() *before* the passes rather than after them. start()
		// awaits it once itself before arming the loop, so the second call is the tick's — that is
		// the one to park. The stub does no seeding: the real one rebuilds `addressKnown` wholesale
		// from the peerStore, which would drop the synthetic target above.
		let seedCalls = 0
		let unpark: (() => void) | undefined
		const parked = new Promise<void>((tickEntered) => {
			;(svc as unknown as { seedFromPeerStore: () => Promise<void> }).seedFromPeerStore = async () => {
				if (++seedCalls < 2) return
				tickEntered()
				await new Promise<void>((resume) => { unpark = resume })
			}
		})
		// Count completions of the real pass, so "the tick resumed and touched nothing" is
		// distinguishable from "the tick never resumed".
		let ticksCompleted = 0
		const realStabilizeOnce = (svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce.bind(svc)
		;(svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce = async () => {
			await realStabilizeOnce()
			ticksCompleted++
		}

		await svc.start()
		await parked

		const selfCoord = await hashPeerId(node.peerId)
		const ring = (svc as unknown as { getNeighbors: (c: Uint8Array, s: string, n: number) => string[] }).getNeighbors(selfCoord, 'both', 8)
		expect(ring, 'seeded peer is a live probe target for the parked tick').to.include(targetId)

		await svc.stop()
		const before = { ...svc.getDiagnostics() }

		// The target has no connection, so `dialProtocol` is the only way any pass could reach it —
		// which makes this the direct form of "issues no dials", rather than inferring it from a
		// diagnostics counter. Installed after stop() so it measures the resumed tick alone.
		let dials = 0
		const originalDial = node.dialProtocol.bind(node)
		;(node as unknown as { dialProtocol: unknown }).dialProtocol = (pid: PeerId, protocols: string[], opts: unknown) => {
			dials++
			return originalDial(pid, protocols, opts as never)
		}
		try {
			unpark!()
			// Wait on the tick actually finishing rather than sleeping a fixed span and hoping:
			// `ticksCompleted` is the same completion signal the assertions below rest on, so a
			// slow box makes this wait longer instead of making the test wrong.
			await waitFor(() => ticksCompleted === 1, 5000, 10, 'interrupted tick ran to completion')
		} finally {
			;(node as unknown as { dialProtocol: unknown }).dialProtocol = originalDial
		}

		expect(ticksCompleted, 'the interrupted tick ran its passes to completion').to.equal(1)
		expect(dials, 'no dials issued by the resumed tick').to.equal(0)
		const diag = svc.getDiagnostics()
		expect(diag.pingsSent, 'no pings issued after stop()').to.equal(before.pingsSent)
		expect(diag.pingsFail, 'no ping failures recorded after stop()').to.equal(before.pingsFail)
		// NOTE: `snapshotsFetched` is deliberately *not* asserted unchanged. `fetchNeighbors`
		// swallows the abort into an empty snapshot rather than rethrowing, so the counter still
		// ticks for a fetch that never opened a stream — the same diagnostics overcount already
		// noted at `stabilizeOnce`'s call site. Nothing is merged and nothing is dialed, which is
		// what `dials` above pins.
		// The peer is healthy; our own cancellation is not evidence about it. Read once and assert
		// the entry exists first — `?.state` on a missing entry passes the `not.equal('dead')`
		// check vacuously.
		const target = store.getById(targetId)
		expect(target, 'target still in the routing table').to.not.equal(undefined)
		expect(target?.contactFailures, 'no contact strike against a healthy peer').to.equal(0)
		expect(target?.state, 'healthy peer not marked dead').to.not.equal('dead')
		// stop() clears the backoff map *before* the tick resumes, so an entry here is the tick's doing.
		const backoff = (svc as unknown as { backoffMap: { get: (id: string) => unknown } }).backoffMap
		expect(backoff.get(targetId), 'no backoff recorded against a peer we never dialed').to.equal(undefined)
	})

	it('mints a fresh run signal per start and leaves the stopped run aborted', async () => {
		const signal = (): AbortSignal | undefined => (svc as unknown as { runSignal: AbortSignal | undefined }).runSignal

		expect(signal(), 'no run signal before the first start()').to.equal(undefined)
		await svc.start()
		expect(signal()?.aborted, 'live run signal while running').to.equal(false)
		await svc.stop()
		// The aborted controller is deliberately kept rather than nulled, so a late read from an
		// interrupted tick still reports "cancelled" instead of "no signal at all".
		expect(signal()?.aborted, 'run signal aborted by stop()').to.equal(true)
		await svc.start()
		expect(signal()?.aborted, 'restart mints a fresh controller').to.equal(false)
	})
})
