import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { createIdentifyNode, createMemNode, stopAll } from './helpers/libp2p.js'
import { waitFor } from './helpers/wait-for.js'
import { sendPing } from '../src/rpc/ping.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { ExpiringMap } from '../src/utils/expiring-map.js'
import { makeProtocols } from '../src/rpc/protocols.js'
import { hashPeerId } from '../src/ring/hash.js'
import type { Libp2p } from 'libp2p'
import type { NeighborSnapshotV1 } from '../src/index.js'

// A peer goes unreachable, its neighbor down-ranks it, gives up on it, and re-admits it once it
// returns. `dead-state.spec.ts` already pins every step of that at the *seam*: the strike counter
// and its 500 ms spacing, what does and does not count as a failed contact, ring-view exclusion,
// eviction, and resurrection from each proof-of-life site. This spec sits one level up and owns
// the three things a seam-level test cannot see:
//
//   1. the whole stabilization tick — `stabilizeOnce` → `nearProbeTargets` → pooled `probeAndFetch`
//      → `probeNeighborLatency` → `noteRpcFailure` — so a regression in *target selection* fails
//      here rather than passing every hand-written probe loop;
//   2. the handoff between passes across ticks: while a peer is alive the near pass verifies it
//      every tick with no backoff; once it is `dead` it leaves the near list entirely and only the
//      backed-off dead arm of `reprobeExcludedTargets` will touch it again;
//   3. the arc on two real nodes — take the remote down, watch the view degrade to `dead`, bring it
//      back, watch the view recover.
//
// That split is the one `dead-state.spec.ts`'s own header asks for: by evidence source, not by test
// count. Nothing here re-derives a seam-level fact.
//
// Two idioms recur, both borrowed rather than re-invented: rewind `lastContactFailureAt` instead of
// sleeping out the strike-spacing window, and rewind a backoff entry's `until` instead of sleeping
// out its window (`ring-membership.spec.ts`). Ticks are driven by hand — the observing service is
// constructed and never started — so its own loop cannot race the assertions.

describe('failure recovery: a real peer goes down, dies, and comes back', function () {
	this.timeout(20000)

	let a: Libp2p
	let b: Libp2p
	let svcA: CoreFretService
	let svcB: CoreFretService
	let store: DigitreeStore
	let bId: string
	const spareNodes: Libp2p[] = []
	const spareSvcs: CoreFretService[] = []

	/** The peerStore re-seed the real stabilization loop runs before every tick. */
	const seed = (): Promise<void> => (svcA as any).seedFromPeerStore()

	/**
	 * One whole stabilization tick, exactly as `startStabilizationLoop` drives it.
	 *
	 * The re-seed is not decoration: it rebuilds the dialability set wholesale from
	 * `peerStore.all()`, and a peer that is not dialable is in neither the near list nor either
	 * re-probe arm — so a tick without it would silently test an empty target list.
	 */
	const tick = async (): Promise<void> => {
		await seed()
		await (svcA as any).stabilizeOnce()
	}

	/**
	 * Rewind both spaced-run stamps so the next failure counts as an independent observation.
	 * Hand-driven ticks land microseconds apart, far inside the 500 ms spacing window, so a
	 * multi-tick escalation that forgets this tests nothing (which "cannot kill a neighbor in a
	 * burst of back-to-back ticks" below turns into an assertion of its own).
	 */
	const unspace = (id: string): void => {
		store.update(id, { lastContactFailureAt: 0, lastNegotiateFailureAt: 0 })
	}

	const backoffMap = (): ExpiringMap<{ until: number; factor: number }> =>
		(svcA as any).backoffMap as ExpiringMap<{ until: number; factor: number }>

	/** Expire a backoff window without sleeping it out, keeping the escalation factor intact. */
	const expireBackoff = (id: string): void => {
		const cur = backoffMap().get(id)
		if (cur) backoffMap().set(id, { ...cur, until: Date.now() - 1 })
	}

	const near = (): Promise<string[]> => (svcA as any).nearProbeTargets() as Promise<string[]>
	const reprobe = (): string[] => (svcA as any).reprobeExcludedTargets() as string[]
	const entry = (id: string = bId) => store.getById(id)

	/** Take the remote all the way down — service first, then its node, as a real shutdown does. */
	const stopRemote = async (): Promise<void> => {
		await svcB.stop()
		await b.stop()
	}

	/** Bring it back on the same peer id and the same memory multiaddr. */
	const startRemote = async (): Promise<void> => {
		await b.start()
		await svcB.start()
	}

	/** Three spaced ticks: the run that takes a downed near peer to `dead`. */
	const driveToDead = async (): Promise<void> => {
		for (let i = 0; i < 3; i++) {
			unspace(bId)
			await tick()
		}
	}

	const advertised = (snap: NeighborSnapshotV1): string[] =>
		[...snap.successors, ...snap.predecessors, ...(snap.sample ?? []).map((s) => s.id)]

	beforeEach(async () => {
		a = await createMemNode()
		b = await createMemNode()
		await a.start()
		await b.start()
		// The observer is constructed but never started: `stabilizeOnce()` is driven explicitly
		// below, and a live loop would probe B on its own schedule. The remote *is* started, so it
		// registers this network's protocol handlers.
		svcA = new CoreFretService(a, { profile: 'core', networkName: 'net-test' })
		svcB = new CoreFretService(b, { profile: 'core', networkName: 'net-test' })
		await svcB.start()
		store = svcA.getStore()
		bId = b.peerId.toString()

		await a.dial(b.getMultiaddrs()[0]!)
		// The dial is what puts B's address in A's peerStore, and the seed is what copies it into
		// FRET's own dialability set. Membership is set by hand because memory nodes run no
		// `identify`, so nothing else would classify B before the first probe.
		await seed()
		store.setMembership(bId, 'member')
	})

	afterEach(async () => {
		for (const s of [svcA, svcB, ...spareSvcs.splice(0)]) {
			try { await s.stop() } catch { /* already stopped by the test */ }
		}
		// Includes any node a test deliberately stopped mid-run; `stopAll` swallows the repeat.
		await stopAll([a, b, ...spareNodes.splice(0)])
	})

	// ---------------------------------------------------------------------------------------
	// Block 1 — one whole tick of soft failure.
	//
	// The near pass decays relevance and counts one strike; it records **no** backoff, and the near
	// list carries no backoff filter, so a live member is re-verified on every tick. Escalation is
	// staged (at most 3 strikes, then exclusion plus a backed-off dead arm), not per-failure.
	// ---------------------------------------------------------------------------------------

	it('decays relevance, strikes once, and records no backoff on the first failed tick', async () => {
		await tick() // B alive: a real success gives relevance a baseline to fall from
		const before = entry()!
		expect(before.successCount, 'the warm-up tick really pinged B').to.equal(1)
		expect(await near(), 'B is a near-probe target before the failing tick').to.include(bId)

		await stopRemote()
		const failsBefore = svcA.getDiagnostics().pingsFail
		await tick()

		const after = entry()!
		expect(after.relevance, 'relevance decayed').to.be.lessThan(before.relevance)
		expect(after.failureCount, 'one relevance decay').to.equal(1)
		expect(svcA.getDiagnostics().pingsFail, 'one failed ping counted').to.equal(failsBefore + 1)
		expect(after.contactFailures, 'one strike').to.equal(1)
		expect(after.state, 'one failed contact is not a verdict').to.not.equal('dead')
		// The assertion that pins the shipped staging: backoff belongs to the off-ring probe passes
		// and to routing, never to the near pass, which is why a live member is re-verified every
		// tick rather than dropping into a growing window after its first miss.
		expect(backoffMap().get(bId), 'the near pass records no backoff').to.equal(undefined)
	})

	it('keeps a softly-failing peer in every ring view and in the near list', async () => {
		await tick()
		await stopRemote()
		await tick()

		const selfCoord = await hashPeerId(a.peerId)
		expect(svcA.getNeighbors(selfCoord, 'both', 8), 'still a neighbor').to.include(bId)
		expect(svcA.assembleCohort(selfCoord, 4), 'still a cohort member').to.include(bId)
		expect(await near(), 'still verified next tick, with no backoff to wait out').to.include(bId)
		expect(entry()?.membership, 'a failed dial says nothing about which network it serves').to.equal('member')
	})

	// ---------------------------------------------------------------------------------------
	// Block 2 — escalation, and the handoff from the near pass to the dead arm across ticks.
	// ---------------------------------------------------------------------------------------

	it('drives a downed near peer to dead in three spaced ticks, membership untouched', async () => {
		await stopRemote()
		expect(await near(), 'the address outlives the outage, so B is still selected').to.include(bId)

		for (let i = 0; i < 2; i++) {
			unspace(bId)
			await tick()
			expect(entry()?.state, `still alive after ${i + 1} strike(s)`).to.not.equal('dead')
		}
		unspace(bId)
		await tick()

		expect(entry()?.contactFailures).to.equal(3)
		expect(entry()?.state).to.equal('dead')
		expect(entry()?.membership, 'a dial that never landed is not membership evidence').to.equal('member')
	})

	it('hands the peer from the near pass to the dead arm when it dies', async () => {
		await stopRemote()
		await driveToDead()

		expect(await near(), 'no longer a live member, so the near pass drops it').to.not.include(bId)
		// Phase 2 of the very tick that killed it already selected it into the dead arm, probed it,
		// failed, and backed it off — so the immediately following tick skips it. A recovery test
		// that runs one tick straight after a restart observes no change for exactly this reason.
		expect(reprobe(), 'still inside the window the killing tick opened').to.not.include(bId)
		expireBackoff(bId)
		expect(reprobe(), 'the dead arm is the only pass that will ever touch it again').to.include(bId)
	})

	it('cannot kill a neighbor in a burst of back-to-back ticks', async () => {
		await stopRemote()
		// No rewind: three hand-driven ticks land well inside the 500 ms spacing window, so they are
		// one observation. This is what stops a live service under mass failure from killing every
		// neighbor in a single burst.
		//
		// NOTE: the only wall-clock-shaped assertion in this file. Three failing ticks against a
		// stopped memory node measure ~50 ms, so the margin against the 500 ms window is ~10× — but
		// it is a margin, not a guarantee, and there is no fake clock here. If this ever flakes,
		// stamp `Date.now()` around the three ticks and assert the elapsed span is under
		// `NEGOTIATE_FAILURE_MIN_SPACING_MS` as a precondition, so a slow machine reports "the
		// premise did not hold" instead of "the spacing guard is broken".
		await tick()
		await tick()
		await tick()

		expect(entry()?.contactFailures, 'one independent observation').to.equal(1)
		expect(entry()?.state).to.not.equal('dead')
		expect(entry()?.failureCount, 'relevance decay is not spacing-guarded').to.equal(3)
	})

	it('backs the dead arm off and doubles its window on each failed re-probe', async () => {
		await stopRemote()
		await driveToDead()

		expect(backoffMap().get(bId)?.factor, 'the killing tick backed it off at factor 1').to.equal(1)
		expect(reprobe()).to.not.include(bId)
		expireBackoff(bId)
		expect(reprobe()).to.include(bId)

		await tick() // the dead arm probes, fails again
		expect(backoffMap().get(bId)?.factor, 'window doubles per confirmed failure').to.equal(2)
	})

	it('strikes each of two unreachable near peers exactly once in one tick', async () => {
		const c = await createMemNode()
		spareNodes.push(c)
		await c.start()
		const svcC = new CoreFretService(c, { profile: 'core', networkName: 'net-test' })
		spareSvcs.push(svcC)
		await svcC.start()
		await a.dial(c.getMultiaddrs()[0]!)
		const cId = c.peerId.toString()
		await seed()
		store.setMembership(cId, 'member')

		await stopRemote()
		await svcC.stop()
		await c.stop()
		expect(await near(), 'both are phase-1 targets of the same tick').to.have.members([bId, cId])

		await tick()

		// The pooled phase-1 tasks are disjoint by construction — one task per near peer — so
		// concurrency must not turn one tick into two strikes for either of them.
		expect(entry(bId)?.contactFailures, 'B struck once').to.equal(1)
		expect(entry(cId)?.contactFailures, 'C struck once').to.equal(1)
	})

	// ---------------------------------------------------------------------------------------
	// Block 3 — the whole arc on two real nodes.
	// ---------------------------------------------------------------------------------------

	it('drops the peer from neighbors, cohort, and the outgoing snapshot once it is dead', async () => {
		const selfCoord = await hashPeerId(a.peerId)
		await tick()
		expect(svcA.getNeighbors(selfCoord, 'both', 8), 'non-vacuity: it was there').to.include(bId)
		expect(advertised(await (svcA as any).snapshot()), 'non-vacuity: it was advertised').to.include(bId)

		await stopRemote()
		await driveToDead()

		expect(svcA.getNeighbors(selfCoord, 'both', 8)).to.not.include(bId)
		expect(svcA.assembleCohort(selfCoord, 4)).to.not.include(bId)
		expect(advertised(await (svcA as any).snapshot()), 'nor advertised to anyone else').to.not.include(bId)
	})

	it('restores the peer through the dead arm once it comes back', async () => {
		await tick()
		await stopRemote()
		await driveToDead()

		await startRemote() // same peer id, same memory multiaddr
		expireBackoff(bId)
		const pingsBefore = svcA.getDiagnostics().pingsSent
		await tick()

		const after = entry()!
		expect(after.state).to.equal('connected')
		expect(after.contactFailures).to.equal(0)
		expect(after.membership).to.equal('member')
		// The restarted remote is given no bootstraps, so it never dials back; without this
		// assertion an incidental inbound RPC or `peer:connect` could resurrect B and the dead arm
		// would go untested.
		expect(svcA.getDiagnostics().pingsSent, 'the dead arm is what reached it').to.be.greaterThan(pingsBefore)

		const selfCoord = await hashPeerId(a.peerId)
		expect(svcA.getNeighbors(selfCoord, 'both', 8), 'back in the ring').to.include(bId)
		expect(svcA.assembleCohort(selfCoord, 4)).to.include(bId)
	})

	// The dead arm is the path back for a peer that never dials us. The other one — and the one a
	// restarted peer with bootstraps actually takes — is the peer reaching *us*, which costs no
	// probe budget at all. `dead-state.spec.ts` pins that at the seam (`noteInboundRpc`); here it
	// rides a real ping over a real connection, so a handler that stopped applying proof of life
	// fails here rather than passing every seam-level call.
	//
	// This is the one test in the block that needs A's inbound handlers: the observer is
	// deliberately never started, so nothing else in this file registers them — and by the same
	// token, no `peer:connect` listener is attached either, which is what leaves the inbound RPC
	// as the only thing that could have resurrected B.
	it('re-admits a dead peer that dials us, without a probe of our own', async () => {
		await tick()
		await stopRemote()
		await driveToDead()
		await (svcA as any).registerRpcHandlers()

		await startRemote()
		const pingsBefore = svcA.getDiagnostics().pingsSent
		await b.dial(a.getMultiaddrs()[0]!)
		const res = await sendPing(b, a.peerId.toString(), makeProtocols('net-test').PROTOCOL_PING)
		expect(res.ok, 'the inbound ping really reached A').to.equal(true)

		const after = entry()!
		expect(after.state, 'proof of life clears the verdict').to.not.equal('dead')
		expect(after.contactFailures, 'and the run behind it').to.equal(0)
		expect(after.membership).to.equal('member')
		expect(svcA.getDiagnostics().pingsSent, 'A sent nothing; B came to us').to.equal(pingsBefore)

		const selfCoord = await hashPeerId(a.peerId)
		expect(svcA.getNeighbors(selfCoord, 'both', 8), 'back in the ring').to.include(bId)
	})

	it('keeps the failure history across recovery', async () => {
		await tick()
		await stopRemote()
		await driveToDead()
		await startRemote()
		expireBackoff(bId)
		await tick()

		const after = entry()!
		expect(after.state, 'the arc really completed').to.equal('connected')
		// Recovery clears the contact-failure run and nothing else: ordinary success scoring is what
		// up-ranks the peer, and wiping the health counters would erase the record of one that flaps.
		expect(after.failureCount, 'decay history survives').to.be.at.least(3)
		expect(after.successCount, 'success history survives').to.be.greaterThan(1)
		expect(after.relevance, 'not reset to a fresh-entry baseline').to.be.greaterThan(0)
	})
})

// The contrast that makes the liveness/membership distinction sharp: the remote's *node* stays up
// and only its FRET service stops, so every dial lands and fails at protocol negotiation. That is
// evidence about which network the remote serves and proof that it is alive, so the run goes to
// `membership` and `contactFailures` never moves.
//
// It needs TCP + `identify` + `identifyPush` nodes rather than the memory nodes above, and the
// reason is behavior worth stating rather than a harness quirk: `seedFromPeerStore` re-classifies
// every peer off its peerStore protocol list on *every* tick, and a list containing one of ours is
// strong positive evidence that resets the negotiate run (see *Evidence strength* in
// `docs/fret.md`). On a memory node that list is filled in by the first successful negotiation and
// can never go stale-negative, because nothing pushes an update — so the reset fires every tick and
// the run never completes. `identifyPush` is what propagates the shortened list when the remote
// unhandles its protocols, which is what lets the run accumulate here. See the NOTE at
// `classifyByProtocols`.
describe('failure recovery: a service-only outage is membership evidence, not a liveness verdict', function () {
	this.timeout(20000)

	let observer: Libp2p
	let remote: Libp2p
	let svcObserver: CoreFretService
	let svcRemote: CoreFretService

	afterEach(async () => {
		for (const s of [svcObserver, svcRemote]) {
			try { await s?.stop() } catch { /* already stopped by the test */ }
		}
		await stopAll([observer, remote])
	})

	it('demotes to foreign without ever striking the dead-state run', async () => {
		observer = await createIdentifyNode()
		remote = await createIdentifyNode()
		await observer.start()
		await remote.start()
		svcObserver = new CoreFretService(observer, { profile: 'core', networkName: 'net-test' })
		svcRemote = new CoreFretService(remote, { profile: 'core', networkName: 'net-test' })
		await svcRemote.start()
		const store = svcObserver.getStore()
		const id = remote.peerId.toString()
		const ping = makeProtocols('net-test').PROTOCOL_PING

		/** Does the observer's peerStore currently advertise the remote as serving this network? */
		const serving = async (): Promise<boolean> => {
			try { return (await observer.peerStore.get(remote.peerId)).protocols.includes(ping) }
			catch { return false }
		}
		const tick = async (): Promise<void> => {
			await (svcObserver as any).seedFromPeerStore()
			await (svcObserver as any).stabilizeOnce()
		}

		await observer.dial(remote.getMultiaddrs()[0]!)
		await waitFor(serving, 8000, 25, 'identify reports the remote serving this network')
		await (svcObserver as any).seedFromPeerStore()
		store.setMembership(id, 'member')
		await tick()
		expect(store.getById(id)?.successCount, 'the warm-up tick really reached it').to.equal(1)

		// Node stays up, connection stays open; only this network's five handlers go away.
		await svcRemote.stop()
		await waitFor(async () => !(await serving()), 8000, 25, 'identifyPush propagates the shortened protocol list')

		for (let i = 0; i < 3; i++) {
			store.update(id, { lastNegotiateFailureAt: 0, lastContactFailureAt: 0 })
			await tick()
		}

		const after = store.getById(id)!
		expect(after.negotiateFailures, 'a completed run of negotiate failures').to.equal(3)
		expect(after.membership).to.equal('foreign')
		expect(after.contactFailures, 'the dial landed, so nothing about liveness was learned').to.equal(0)
		expect(after.state, 'never dead').to.not.equal('dead')
	})
})
