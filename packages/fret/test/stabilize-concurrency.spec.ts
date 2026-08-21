import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { buildMaintenanceRig, type MaintenanceRig, type PeerRig } from './helpers/maintenance-rig.js'
import type { FretService as CoreFretService } from '../src/service/fret-service.js'
import type { DigitreeStore } from '../src/store/digitree-store.js'
import { hashPeerId } from '../src/ring/hash.js'

// One stabilization tick runs its outbound RPCs *pooled* — at most `maintenanceConcurrency` in
// flight (Core 6 / Edge 2) — under one tick-wide budget (`STABILIZE_TICK_BUDGET_MS`), instead of
// walking every target serially. These tests pin the properties that design rests on:
//
// - a peer that never answers costs the tick its budget, not the other peers their turn;
// - phase 1 cannot starve phase 2: a near peer that answers its ping and then stalls the
//   snapshot fetch still leaves the classification and dead-re-probe arms their turn, tick
//   after tick;
// - a near peer whose ping did not answer is not snapshot-fetched at all;
// - the pool cap binds, and is actually reached (parallel, not merely bounded);
// - the ping → snapshot-fetch dependency survives per peer even though peers overlap;
// - the four candidate lists a tick pools are pairwise disjoint (what makes pooling safe against
//   the lost-increment race on the score/strike counters);
// - a tick cut short by its budget records nothing against anyone (our cancellation is not
//   evidence about the peer);
// - candidate lists rotate under truncation, so a budget-cut tick never re-derives the same head.
//
// The libp2p / stub-connection harness lives in `helpers/maintenance-rig.ts`, shared with the
// warm-up pass tests in `preconnect-concurrency.spec.ts`.

describe('stabilization tick: pooled RPCs under one tick budget', function () {
	this.timeout(10000)

	let harness: MaintenanceRig
	let svc: CoreFretService
	let store: DigitreeStore
	let rig: PeerRig

	async function build(profile: 'core' | 'edge'): Promise<void> {
		harness = await buildMaintenanceRig(profile)
		;({ svc, store, rig } = harness)
	}

	beforeEach(async () => {
		await build('core')
	})

	async function teardown(): Promise<void> {
		await harness.teardown()
	}

	afterEach(teardown)

	const setTickBudget = (ms: number): void => { harness.setTickBudget(ms) }
	const concurrency = (): number => harness.concurrency()
	const seedPeers: MaintenanceRig['seedPeers'] = (count, membership, patch) => harness.seedPeers(count, membership, patch)
	const ping = (): string => harness.ping()
	const neighbors = (): string => harness.neighbors()

	async function tick(): Promise<number> {
		const t0 = Date.now()
		await (svc as any).stabilizeOnce()
		return Date.now() - t0
	}

	/** The evidence a tick may record against a peer — snapshotted before, compared after. */
	function evidence(id: string): Record<string, unknown> {
		const e = store.getById(id)!
		return {
			contactFailures: e.contactFailures,
			failureCount: e.failureCount,
			negotiateFailures: e.negotiateFailures,
			membership: e.membership,
			state: e.state,
			backoff: (svc as any).backoffMap.get(id),
		}
	}

	// ----- headline regression -----

	// Four near peers, one of which never answers. Serially the hung one blocked the other three
	// for its full RPC timeout before any of them was pinged, let alone fetched; pooled, the three
	// complete while it hangs and the tick returns on its own budget.
	it('one unresponsive near peer costs the tick its budget, not the other peers their probe and fetch', async () => {
		const budget = 400
		setTickBudget(budget)
		await seedPeers(4, 'member')
		const near: string[] = await (svc as any).nearProbeTargets()
		expect(near, 'all four seeded members are near targets').to.have.length(4)
		// The *first* in ring order hangs — under a serial walk that is the one that blocks the rest.
		const hung = near[0]!
		rig.behavior.set(hung, 'hangs')

		const elapsed = await tick()

		expect(elapsed, `tick returned within its ${budget}ms budget plus slack`).to.be.at.most(budget + 1500)
		expect(elapsed, 'the hung peer really was in the tick and cut by the budget').to.be.at.least(budget / 2)
		for (const id of near.slice(1)) {
			expect(rig.protocolsSeenBy(id), `${id}: pinged then fetched`).to.deep.equal([ping(), neighbors()])
		}
		expect(rig.protocolsSeenBy(hung), 'hung peer: ping opened, fetch skipped after the cut').to.deep.equal([ping()])
		expect(svc.getDiagnostics().pingsOk, 'three pings answered').to.equal(3)
		expect(svc.getDiagnostics().snapshotsFetched, 'three snapshots fetched').to.equal(3)
	})

	// ----- phase-2 reserve -----

	// Same family as the headline case above: one stalled peer must not cost the tick its other
	// work. Here the stall is *inside* phase 1 rather than at the tick budget — the peer answers
	// the cheap ping and then hangs the snapshot fetch, which is the shape that made this an
	// outage rather than a hiccup: such a peer accrues no contact failures, so it is never marked
	// dead, so it stays in the near list and stalls again on every tick. Phase 2 is the only path
	// by which a `dead` peer is contacted again or an `unknown` one is classified, so a phase 1
	// that eats the whole tick means neither ever happens.
	//
	// Both cases run at the *real, unmutated* budgets on purpose (no `setTickBudget`): what is
	// being pinned is the arithmetic between the shipped constants, so a rig-shrunk budget would
	// pin nothing. A tick costs ~1.1s here — phase 1 ends on `MAINTENANCE_SNAPSHOT_TIMEOUT_MS`
	// (1000ms), well inside its own 3000ms sub-budget — and the raised per-case timeout is
	// insurance against a slow CI box, not the expected cost.
	async function expectPhaseTwoKeepsItsTurn(): Promise<void> {
		const [stalled] = await seedPeers(1, 'member')
		rig.setProtocolBehavior(stalled!, neighbors(), 'hangs')
		const [unknown] = await seedPeers(1, 'unknown')
		const [dead] = await seedPeers(1, 'member', { state: 'dead' })

		const near: string[] = await (svc as any).nearProbeTargets()
		expect(near, 'the stalling peer is the only near target this tick has').to.deep.equal([stalled!])

		const elapsed = await tick()

		// Bounds the *snapshot* timeout (1000ms), not phase 1's own sub-budget (3000ms): a tick here
		// costs ~1.05s, and losing the timeoutMs override lets phase 1 run to 3000ms instead. A bound
		// at the sub-budget's own value would separate those two by ~13ms, which is no separation at
		// all on shared CI. 2000 is ~2x the real cost and ~1000ms clear of the mutation.
		expect(elapsed, 'phase 1 ended on the 1000ms snapshot timeout, not on its 3000ms sub-budget').to.be.at.most(2000)
		expect(rig.protocolsSeenBy(stalled!), 'ping answered, then the fetch opened and stalled').to.deep.equal([ping(), neighbors()])
		expect(rig.protocolsSeenBy(unknown!), 'the classification arm still got its turn').to.deep.equal([ping()])
		expect(rig.protocolsSeenBy(dead!), 'the dead re-probe arm still got its turn').to.deep.equal([ping()])

		// Tick 1's probes answered, so both phase-2 peers were promoted to live members and would
		// be drawn into the *near* list on tick 2 — where they are pinged *and* fetched, which is
		// a different question. Re-pose the two labels so the second tick asks the same one.
		store.setMembership(unknown!, 'unknown')
		store.update(dead!, { state: 'dead' })

		await tick()

		// "...and it never gets a turn again" is the half that made this an outage; one tick is
		// not enough to pin it.
		expect(rig.protocolsSeenBy(unknown!), 'and again on the next tick').to.deep.equal([ping(), ping()])
		expect(rig.protocolsSeenBy(dead!), 'and again on the next tick').to.deep.equal([ping(), ping()])
	}

	it('Core: a near peer that stalls its snapshot fetch does not cost phase 2 its turn, tick after tick', async function () {
		this.timeout(20000)
		await expectPhaseTwoKeepsItsTurn()
	})

	// Edge caps the pool at 2, so phase 1 takes more rounds to drain and is likelier to reach its
	// sub-budget — the profile where a missing reserve would bite first.
	it('Edge: a near peer that stalls its snapshot fetch does not cost phase 2 its turn, tick after tick', async function () {
		this.timeout(20000)
		await teardown()
		await build('edge')
		await expectPhaseTwoKeepsItsTurn()
	})

	// The companion half of the fix: `probeAndFetch` gates the fetch on whether the ping actually
	// answered. Distinct from the headline case's hung peer, which is cut by the *tick budget*
	// (`wasCancelled`) — here the budget is untouched and the ping simply times out, so it is the
	// `!answered` gate alone that stops the fetch. Without it the fetch was still issued: the rig
	// gives every peer an open stub connection, so connection-only `fetchNeighbors` really would
	// open a neighbors stream that could only fail.
	it('a near peer whose ping never answers is not snapshot-fetched at all', async function () {
		this.timeout(20000)
		const [silent] = await seedPeers(1, 'member')
		rig.behavior.set(silent!, 'hangs')

		await tick()

		expect(rig.protocolsSeenBy(silent!), 'ping opened and timed out; no neighbors stream').to.deep.equal([ping()])
		expect(svc.getDiagnostics().snapshotsFetched, 'nothing fetched').to.equal(0)
	})

	// ----- pool cap -----

	// The high-water mark is asserted *equal* to the cap, not merely at-most: at-most also passes
	// for a serial walk, and the whole point is that the tick overlaps its peers. ≥ 8 targets so
	// the cap binds in at least one phase for both profiles.
	async function expectHighWaterAtCap(): Promise<void> {
		rig.holdMs = 30
		await seedPeers(4, 'member')
		// Enough unknowns for the classification budget (Core 8 / Edge 4) to fill the second phase.
		await seedPeers(8, 'unknown')
		const cap = concurrency()

		await tick()

		expect(rig.highWater, `in-flight high-water mark equals the ${cap}-wide pool`).to.equal(cap)
		expect(rig.inFlight, 'every stream released by the end of the tick').to.equal(0)
	}

	it('Core: never more than 6 outbound RPCs in flight, and 6 are reached', async () => {
		expect(concurrency()).to.equal(6)
		await expectHighWaterAtCap()
	})

	it('Edge: never more than 2 outbound RPCs in flight, and 2 are reached', async () => {
		await teardown()
		await build('edge')
		expect(concurrency()).to.equal(2)
		await expectHighWaterAtCap()
	})

	// ----- ping-before-fetch per peer -----

	// `fetchNeighbors` is connection-only and it is the ping that usually opens the connection, so
	// the two must stay ordered per peer even while peers overlap. `holdMs` makes the overlap real.
	it('pings a near peer before fetching its snapshot, for every near peer, while peers overlap', async () => {
		rig.holdMs = 20
		await seedPeers(4, 'member')
		const near: string[] = await (svc as any).nearProbeTargets()

		await tick()

		expect(near).to.have.length(4)
		for (const id of near) {
			expect(rig.protocolsSeenBy(id), `${id}: exactly one ping, then exactly one fetch`).to.deep.equal([ping(), neighbors()])
		}
		expect(svc.getDiagnostics().pingsOk).to.equal(4)
		expect(svc.getDiagnostics().snapshotsFetched).to.equal(4)
	})

	// ----- disjoint candidate lists -----

	// Pooling is safe against the lost-increment race on `applySuccess` / `applyFailure` only
	// because no peer appears in two pooled tasks of one tick. Asserted rather than trusted.
	it('selects pairwise-disjoint near / classify / re-probe targets, with no duplicate across the two re-probe arms', async () => {
		const [member] = await seedPeers(1, 'member')
		const [unknown] = await seedPeers(1, 'unknown')
		const [foreign] = await seedPeers(1, 'foreign')
		const [dead] = await seedPeers(1, 'member', { state: 'dead' })
		// Both foreign *and* dead: belongs to the dead arm alone.
		const [foreignDead] = await seedPeers(1, 'foreign', { state: 'dead' })

		const near: string[] = await (svc as any).nearProbeTargets()
		const classify: string[] = (svc as any).classifyTargets()
		const reprobe: string[] = (svc as any).reprobeExcludedTargets()

		expect(near, 'near = live members only').to.deep.equal([member])
		expect(classify, 'classify = non-dead unknowns only').to.deep.equal([unknown])
		expect(reprobe, 'no duplicates across the arms').to.have.length(new Set(reprobe).size)
		expect(reprobe, 'foreign arm picks the live foreign peer').to.include(foreign!)
		expect(reprobe, 'dead arm picks the dead peer').to.include(dead!)
		expect(reprobe, 'foreign-and-dead peer belongs to the dead arm, once').to.include(foreignDead!)
		expect(reprobe).to.have.length(3)

		const lists = [near, classify, reprobe]
		for (let a = 0; a < lists.length; a++) {
			for (let b = a + 1; b < lists.length; b++) {
				const overlap = lists[a]!.filter((id) => lists[b]!.includes(id))
				expect(overlap, `lists ${a} and ${b} share no peer`).to.deep.equal([])
			}
		}
	})

	// ----- truncation is not evidence -----

	// A budget expiry aborts in-flight RPCs and skips the rest; both must leave every peer exactly
	// as it was — no strike, no relevance decay, no backoff, no `dead`, no `pingsFail`.
	it('records nothing against any peer when the budget cuts the first phase and skips the second', async () => {
		setTickBudget(50)
		const members = await seedPeers(4, 'member')
		const unknowns = await seedPeers(2, 'unknown')
		const [foreign] = await seedPeers(1, 'foreign')
		const [dead] = await seedPeers(1, 'member', { state: 'dead' })
		const all = [...members, ...unknowns, foreign!, dead!]
		for (const id of all) rig.behavior.set(id, 'hangs')
		const before = new Map(all.map((id) => [id, evidence(id)]))
		const diagBefore = { ...svc.getDiagnostics() }

		await tick()

		for (const id of all) expect(evidence(id), `${id}: unchanged`).to.deep.equal(before.get(id))
		expect(svc.getDiagnostics().pingsFail, 'no ping failure counted').to.equal(diagBefore.pingsFail)
		expect(svc.getDiagnostics().pingsSent, 'no ping counted as sent').to.equal(diagBefore.pingsSent)
		// The second phase never started: its pool saw an already-expired signal and skipped every task.
		for (const id of [...unknowns, foreign!, dead!]) {
			expect(rig.protocolsSeenBy(id), `${id}: skipped, never opened`).to.deep.equal([])
		}
		expect(rig.inFlight, 'every hung open settled on the abort').to.equal(0)
	})

	it('records nothing against a peer whose membership probe the budget aborts mid-flight', async () => {
		setTickBudget(150)
		await seedPeers(4, 'member') // answer at once, so the second phase is reached well inside the budget
		const unknowns = await seedPeers(2, 'unknown')
		const [foreign] = await seedPeers(1, 'foreign')
		const [dead] = await seedPeers(1, 'member', { state: 'dead' })
		const offRing = [...unknowns, foreign!, dead!]
		for (const id of offRing) rig.behavior.set(id, 'hangs')
		const before = new Map(offRing.map((id) => [id, evidence(id)]))
		const diagBefore = { ...svc.getDiagnostics() }

		await tick()

		for (const id of offRing) {
			expect(rig.protocolsSeenBy(id), `${id}: probe was in flight when the budget expired`).to.deep.equal([ping()])
			expect(evidence(id), `${id}: unchanged`).to.deep.equal(before.get(id))
		}
		expect(svc.getDiagnostics().pingsFail, 'no ping failure counted').to.equal(diagBefore.pingsFail)
		expect(rig.inFlight, 'every hung open settled on the abort').to.equal(0)
	})

	// ----- rotation -----

	// A truncated tick must not re-derive the same head next tick. Unknowns are ordered by
	// ascending `lastAccess` before the budget slice, and a probed one is bumped (`applySuccess`)
	// or backed off, so it rotates to the back with no extra bookkeeping.
	it('classifyTargets rotates: oldest-touched unknowns first, and the unprobed tail leads the next tick', async () => {
		const ids = await seedPeers(12, 'unknown')
		const base = Date.now() - 60_000
		ids.forEach((id, i) => store.update(id, { lastAccess: base + i * 1000 }))
		const budget = 8 // Core classification budget

		const first: string[] = (svc as any).classifyTargets()
		expect(first, 'the 8 oldest, ascending').to.deep.equal(ids.slice(0, budget))

		// What `applySuccess` does to a probed unknown.
		const now = Date.now()
		for (const id of first) store.update(id, { lastAccess: now })

		const second: string[] = (svc as any).classifyTargets()
		expect(second.slice(0, ids.length - budget), 'the 4 never-probed lead').to.deep.equal(ids.slice(budget))
		expect(second, 'the rest of the budget is filled from the probed ones').to.have.length(budget)
		expect(new Set(second).size).to.equal(budget)
	})

	// ----- phase-2 target selection: shared walk behind an O(1) count gate -----

	// `phaseTwoTargets` is the tick's only phase-2 selector. It asks the store for three O(1)
	// per-label counts first: every arm's predicate narrows one single-field label (`unknown` /
	// `foreign` / `state === 'dead'`), so a zero count proves that arm selects nothing and the
	// tick can skip the walk outright. These tests are aimed at the *low* direction — a gate that
	// wrongly reads zero makes the pass silently stop selecting, and a dead peer that is never
	// re-probed never recovers.

	/** Count `store.list()` calls for the duration of `fn`; the walk is what the gate removes. */
	async function walksDuring<T>(fn: () => T | Promise<T>): Promise<{ result: T, walks: number }> {
		const real = store.list.bind(store)
		let walks = 0
		;(store as any).list = (...args: unknown[]) => { walks++; return (real as any)(...args) }
		try {
			return { result: await fn(), walks }
		} finally {
			;(store as any).list = real
		}
	}

	const phaseTwo = (): string[] => (svc as any).phaseTwoTargets() as string[]

	it('single-node ring: self alone in the table costs zero walks and selects nothing', async () => {
		// Self is seeded `member` and is never marked dead, so it contributes to none of the three
		// gated counters — the case the gate must not get wrong on a one-peer ring.
		const selfId = harness.node.peerId.toString()
		store.upsert(selfId, await hashPeerId(harness.node.peerId))
		store.setMembership(selfId, 'member')

		const { result, walks } = await walksDuring(phaseTwo)

		expect(result, 'nothing to probe').to.deep.equal([])
		expect(walks, 'the table was never walked').to.equal(0)
	})

	it('steady state — every peer a live member — costs zero store walks', async () => {
		await seedPeers(6, 'member')

		const { result, walks } = await walksDuring(phaseTwo)

		expect(result).to.deep.equal([])
		expect(walks, 'all three counts are zero, so no walk').to.equal(0)
	})

	it('one unknown + one foreign + one dead cost exactly one walk, and the arms select the same ids as before', async () => {
		const [unknown] = await seedPeers(1, 'unknown')
		const [foreign] = await seedPeers(1, 'foreign')
		const [dead] = await seedPeers(1, 'member', { state: 'dead' })

		const { result, walks } = await walksDuring(phaseTwo)

		expect(walks, 'one shared walk, not three').to.equal(1)
		// Same ids the two selectors return on their own, in the same order: only the walk is
		// shared, never the candidate lists.
		const separately = [...(svc as any).classifyTargets(), ...(svc as any).reprobeExcludedTargets()]
		expect(result).to.deep.equal(separately)
		expect(result, 'all three arms selected').to.have.members([unknown!, foreign!, dead!])
		expect(result, 'no id reaches the pool twice').to.have.length(new Set(result).size)
	})

	it('unknown → member re-arms the early return', async () => {
		const [unknown] = await seedPeers(1, 'unknown')
		await seedPeers(3, 'member')

		const first = await walksDuring(phaseTwo)
		expect(first.result, 'the unknown is selected while it is unclassified').to.deep.equal([unknown!])
		expect(first.walks).to.equal(1)

		// What a successful classification probe does to the entry.
		store.setMembership(unknown!, 'member')

		const second = await walksDuring(phaseTwo)
		expect(second.result, 'nothing left to classify').to.deep.equal([])
		expect(second.walks, 'the count gate re-arms — no walk at all').to.equal(0)
	})

	it('member → dead lifts the dead count off zero and the arm selects it on the very next call', async () => {
		const [peer] = await seedPeers(1, 'member')
		expect((await walksDuring(phaseTwo)).walks, 'zero walks while the table is all-member').to.equal(0)

		// The real escalation path: `deadAfterFailures` (3) failed contacts. They must be spread
		// over time to count as independent observations, so the spacing stamp is wound back
		// between strikes rather than sleeping through it (the spacing itself is pinned by
		// `dead-state.spec.ts`).
		for (let i = 0; i < 3; i++) {
			store.update(peer!, { lastContactFailureAt: 0 })
			;(svc as any).applyContactStrike(peer!)
		}
		expect(store.getById(peer!)!.state, 'the peer really is dead').to.equal('dead')

		const { result, walks } = await walksDuring(phaseTwo)
		expect(result, 'the dead arm selects it immediately, not one tick later').to.deep.equal([peer!])
		expect(walks).to.equal(1)
	})
})
