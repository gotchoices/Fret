import { afterEach, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { buildMaintenanceRig, type MaintenanceRig } from './helpers/maintenance-rig.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { hashPeerId, coordToBase64url, COORD_BYTES } from '../src/ring/hash.js'
import { NEAR_PROBE_MAX_SKIPS, SNAPSHOT_DIGEST_CHARS, snapshotDigest } from '../src/service/near-exchange.js'
import { makeProtocols } from '../src/rpc/protocols.js'
import { sendPing } from '../src/rpc/ping.js'
import type { FretConfig, NeighborSnapshotV1 } from '../src/index.js'

// gotchoices/Fret#2: on an idle two-phone strand every stabilization pass pinged the other phone
// and downloaded its whole neighbour list, although the other phone had pinged *us* a moment ago
// and its list had not changed. Two skips, both from what earlier passes already learned
// (`src/service/near-exchange.ts`): the probe is skipped on fresh RPC evidence, the fetch is
// skipped when the ping reply's snapshot digest matches the content already merged.
//
// Four cases:
//   1. what the digest covers — pure, no network;
//   2. the reproduction — two real memory nodes driven pass by pass, alternately;
//   3. the idle backoff on that same strand (the issue's suggestion 1): both sides' passive
//      interval climbs to the cap while they keep pinging each other, and a real change on one
//      side resets that side alone;
//   4. strike accounting on the stub-connection rig — a skip records nothing, and a peer whose
//      traffic stops is still struck dead on the usual schedule.

describe('snapshotDigest covers what a receiver acts on, and nothing else', () => {
	const coord = coordToBase64url(new Uint8Array(COORD_BYTES).fill(1))
	const base: NeighborSnapshotV1 = {
		v: 1, from: 'from', timestamp: 1,
		successors: ['s1', 's2'],
		predecessors: ['p1'],
		sample: [{ id: 'a', coord, relevance: 0.1 }, { id: 'b', coord, relevance: 0.2 }],
		size_estimate: 10, confidence: 0.5, sig: '',
		metadata: { k: 1 },
		hints: [{ id: 's1', record: 'AAAA' }],
	}
	type Mutation = [string, (s: NeighborSnapshotV1) => NeighborSnapshotV1]
	const changes: Mutation[] = [
		['a successor added', (s) => ({ ...s, successors: [...s.successors, 's3'] })],
		['a predecessor removed', (s) => ({ ...s, predecessors: [] })],
		['a sample id swapped', (s) => ({ ...s, sample: [s.sample![0]!, { ...s.sample![1]!, id: 'c' }] })],
		['metadata changed', (s) => ({ ...s, metadata: { k: 2 } })],
		["a hint's record bytes replaced, as a re-seal does", (s) => ({ ...s, hints: [{ id: 's1', record: 'BBBB' }] })],
		['a hint added', (s) => ({ ...s, hints: [...s.hints!, { id: 'p1', record: 'CCCC' }] })],
	]
	const invariants: Mutation[] = [
		['timestamp', (s) => ({ ...s, timestamp: 2 })],
		['size_estimate', (s) => ({ ...s, size_estimate: 11 })],
		['confidence', (s) => ({ ...s, confidence: 0.9 })],
		['sample relevance values', (s) => ({ ...s, sample: s.sample!.map((e) => ({ ...e, relevance: e.relevance + 1 })) })],
		['sample order', (s) => ({ ...s, sample: [s.sample![1]!, s.sample![0]!] })],
	]

	it('changes on every acted-on field and on nothing else', async () => {
		const d0 = await snapshotDigest(base)
		expect(d0, 'the emitted width').to.have.lengthOf(SNAPSHOT_DIGEST_CHARS)
		for (const [what, mutate] of changes) {
			expect(await snapshotDigest(mutate(base)), `${what} changes the digest`).to.not.equal(d0)
		}
		for (const [what, mutate] of invariants) {
			expect(await snapshotDigest(mutate(base)), `${what} leaves the digest equal`).to.equal(d0)
		}
	})
})

describe('idle two-node strand: the reproduction', function () {
	this.timeout(30000)

	let nodes: Libp2p[] = []
	let svcs: CoreFretService[] = []

	afterEach(async () => {
		for (const s of svcs.splice(0)) { try { await s.stop() } catch { /* never started */ } }
		await stopAll(nodes.splice(0))
	})

	/**
	 * One node with its service constructed and its inbound handlers registered, never started:
	 * no loop races the hand-driven passes, and no listener admits the other side — membership is
	 * set by hand below, the way `failure-recovery.spec.ts` drives its remote.
	 */
	async function member(cfg: Partial<FretConfig> = {}): Promise<{ node: Libp2p; svc: CoreFretService }> {
		const node = await createMemNode()
		await node.start()
		nodes.push(node)
		const svc = new CoreFretService(node, { profile: 'core', networkName: 'net-test', ...cfg })
		svcs.push(svc)
		await (svc as any).registerRpcHandlers()
		return { node, svc }
	}

	/** Seed self and admit `other` as a live member, dialable through the open connection. */
	async function admit(svc: CoreFretService, other: Libp2p): Promise<void> {
		await (svc as any).seedFromPeerStore()
		const id = other.peerId.toString()
		svc.getStore().upsert(id, await hashPeerId(other.peerId))
		svc.getStore().setMembership(id, 'member')
	}

	const pass = (svc: CoreFretService): Promise<void> => (svc as any).stabilizeOnce()

	it('settles into skipped probes and no fetches, then refetches within four passes of a content change', async () => {
		const a = await member()
		const b = await member()
		await a.node.dial(b.node.getMultiaddrs()[0]!)
		await admit(a.svc, b.node)
		await admit(b.svc, a.node)
		const dA = a.svc.getDiagnostics()
		const dB = b.svc.getDiagnostics()
		const alternate = async (passes: number): Promise<void> => {
			for (let i = 0; i < passes; i++) { await pass(a.svc); await pass(b.svc) }
		}

		await alternate(2) // warm-up: the first pass of each side probes and fetches the other
		expect(dA.snapshotsFetched, 'premise: A fetched B at least once').to.be.greaterThan(0)
		expect(dB.snapshotsFetched, 'premise: B fetched A at least once').to.be.greaterThan(0)
		const before = {
			fetchedA: dA.snapshotsFetched, fetchedB: dB.snapshotsFetched,
			pingsA: dA.pingsSent, pingsB: dB.pingsSent,
			skippedA: { ...dA.nearExchangeSkipped }, skippedB: { ...dB.nearExchangeSkipped },
		}

		await alternate(10)

		expect(dA.snapshotsFetched, 'A fetched nothing on a stable ring').to.equal(before.fetchedA)
		expect(dB.snapshotsFetched, 'B fetched nothing on a stable ring').to.equal(before.fetchedB)
		expect(dA.nearExchangeSkipped.probes, 'A skipped probes').to.be.greaterThan(before.skippedA.probes)
		expect(dA.nearExchangeSkipped.fetches, 'A skipped fetches').to.be.greaterThan(before.skippedA.fetches)
		expect(dB.nearExchangeSkipped.probes, 'B skipped probes').to.be.greaterThan(before.skippedB.probes)
		expect(dB.nearExchangeSkipped.fetches, 'B skipped fetches').to.be.greaterThan(before.skippedB.fetches)
		// Tracing the rules by hand, each side settles into pinging every third pass: our own
		// answered ping is evidence for the next pass, the other side's ping for the one after, and
		// rule 3 forces the probe on the third. Bounded at half the passes so a regression to
		// every-other-pass still fails here.
		expect(dA.pingsSent - before.pingsA, 'A pinged at most every other pass').to.be.at.most(5)
		expect(dB.pingsSent - before.pingsB, 'B pinged at most every other pass').to.be.at.most(5)
		expect(dA.pingsSent, 'non-vacuity: A still pinged at all').to.be.greaterThan(before.pingsA)
		expect(dB.pingsSent, 'non-vacuity: B still pinged at all').to.be.greaterThan(before.pingsB)

		// A content change on B: rule 3 forces A's probe within NEAR_PROBE_MAX_SKIPS + 1 passes, and
		// the probe's digest mismatch forces the fetch. A fetch does not store metadata (only an
		// announce does), so the fetch itself is what is asserted.
		b.svc.setMetadata({ changed: true })
		const fetchedBefore = dA.snapshotsFetched
		let passes = 0
		while (dA.snapshotsFetched === fetchedBefore && passes < NEAR_PROBE_MAX_SKIPS + 1) {
			await pass(a.svc)
			await pass(b.svc)
			passes++
		}
		expect(dA.snapshotsFetched, `A refetched within ${NEAR_PROBE_MAX_SKIPS + 1} passes of B's content change`).to.equal(fetchedBefore + 1)
	})

	it('backs the passive interval off to the cap on both sides, and a change on one side resets only that side', async () => {
		// A small cap so the ladder (1.5 → 3 → 6 → 12 s) reaches it in three quiet passes.
		const CAP = 12_000
		const BASE = (CoreFretService as any).PASSIVE_INTERVAL_MS as number
		const a = await member({ maxPassiveIntervalMs: CAP })
		const b = await member({ maxPassiveIntervalMs: CAP })
		await a.node.dial(b.node.getMultiaddrs()[0]!)
		await admit(a.svc, b.node)
		await admit(b.svc, a.node)
		const dA = a.svc.getDiagnostics()
		const dB = b.svc.getDiagnostics()
		// The loop's pass body, not the bare tick: it is what brackets the pass with the backoff.
		const cycle = (svc: CoreFretService): Promise<number> => (svc as any).runStabilizationPass()
		const live = (svc: CoreFretService): number => (svc as any).idle.delayMs

		// Every pass pings the other side at most every third pass and fetches nothing (the case
		// above) — and what the other side's ping lands as, an inbound RPC from a peer already
		// held, writes nothing through the change seams. So every pass is quiet on both sides.
		let passes = 0
		while ((dA.loop.delayMs < CAP || dB.loop.delayMs < CAP) && passes < 8) {
			await cycle(a.svc); await cycle(b.svc)
			passes++
		}
		expect(dA.loop.delayMs, `A reached the cap (after ${passes} alternating passes)`).to.equal(CAP)
		expect(dB.loop.delayMs, `B reached the cap (after ${passes} alternating passes)`).to.equal(CAP)
		expect(passes, 'non-vacuity: the warm-up pass and the climb were real passes').to.be.at.least(3)
		expect(dA.pingsSent, 'non-vacuity: A pinged B during the climb').to.be.greaterThan(0)
		expect(dB.pingsSent, 'non-vacuity: B pinged A during the climb').to.be.greaterThan(0)

		// A real change on B's side only: a stranger connects to B and calls one of its namespaced
		// protocols, which creates an entry (the one path by which a new peer reaches a table that
		// is not started — the `peer:connect` listener is attached by `start()`). Read live, before
		// the ring propagates it: B's next pass labels the stranger and its snapshot then names it,
		// which is how A would legitimately learn of it and reset too.
		const stranger = await createMemNode()
		await stranger.start()
		nodes.push(stranger)
		await stranger.dial(b.node.getMultiaddrs()[0]!)
		const pong = await sendPing(stranger, b.node.peerId.toString(), makeProtocols('net-test').PROTOCOL_PING)
		expect(pong.kind, 'premise: the stranger reached B').to.equal('ok')
		await new Promise((r) => setTimeout(r, 50)) // `noteInboundRpc` is detached from the handler
		expect(live(b.svc), 'B is back at the base').to.equal(BASE)
		expect(live(a.svc), 'A is still at the cap').to.equal(CAP)
		// And B's next pass settles at the base too — the stranger is `unknown`, so phase 2 selects
		// it (pending) and the probe moves its label (a change).
		await cycle(b.svc)
		expect(dB.loop.delayMs, "B's next pass arms the base").to.equal(BASE)
	})

	/**
	 * Drive both sides through the loop's pass body (the ladder included) and require the
	 * near-exchange probe skip to still fire: the no-stacking rule spares the skip only on a pass
	 * the backoff *delayed*, and in both configurations below every pass is a base-interval pass.
	 */
	async function expectSkipsUnderTheLadder(cfg: Partial<FretConfig>, prepare: (svc: CoreFretService) => void): Promise<void> {
		const a = await member(cfg)
		const b = await member(cfg)
		prepare(a.svc); prepare(b.svc)
		await a.node.dial(b.node.getMultiaddrs()[0]!)
		await admit(a.svc, b.node)
		await admit(b.svc, a.node)
		const dA = a.svc.getDiagnostics()
		const cycle = (svc: CoreFretService): Promise<number> => (svc as any).runStabilizationPass()
		await cycle(a.svc); await cycle(b.svc) // warm-up: first passes probe and fetch
		const before = { pings: dA.pingsSent, skipped: dA.nearExchangeSkipped.probes }
		for (let i = 0; i < 6; i++) { await cycle(a.svc); await cycle(b.svc) }
		expect(dA.loop.delayMs, 'premise: the loop never left the base').to.equal((CoreFretService as any).PASSIVE_INTERVAL_MS)
		expect(dA.nearExchangeSkipped.probes, 'A still skipped probes with the ladder running').to.be.greaterThan(before.skipped)
		expect(dA.pingsSent - before.pings, 'A pinged at most every other pass').to.be.at.most(3)
	}

	it('keeps the probe skip when the host disabled backoff (cap at the base)', async () => {
		await expectSkipsUnderTheLadder({ maxPassiveIntervalMs: (CoreFretService as any).PASSIVE_INTERVAL_MS }, () => {})
	})

	it('keeps the probe skip in active mode, where the loop runs at 300 ms whatever the ladder says', async () => {
		// The mode field directly: `setMode` would also start the active preconnect loop, which is
		// not under test here and would outlive these never-started services.
		await expectSkipsUnderTheLadder({}, (svc) => { (svc as any).mode = 'active' })
	})
})

describe('strike accounting across a skipped pass', function () {
	this.timeout(20000)

	let harness: MaintenanceRig | undefined

	// The silent ticks below each end on the ping's own deadline — `timeout`, the strike arm,
	// whatever its length — so the shipped 2 s is shrunk the way `fetch-snapshot-failure-arms.spec.ts`
	// shrinks the snapshot timeout, saving ~6 s. Only the RPC timeout: shrinking the *tick* budget
	// instead would turn the same hang into `cancelled`, which records nothing.
	const REAL_RPC_TIMEOUT = (CoreFretService as any).MAINTENANCE_RPC_TIMEOUT_MS as number
	beforeEach(() => { (CoreFretService as any).MAINTENANCE_RPC_TIMEOUT_MS = 100 })
	afterEach(async () => {
		;(CoreFretService as any).MAINTENANCE_RPC_TIMEOUT_MS = REAL_RPC_TIMEOUT
		if (harness != null) await harness.teardown()
		harness = undefined
	})

	it('skips exactly one pass after fresh evidence, then strikes the silent peer dead on the usual schedule', async () => {
		harness = await buildMaintenanceRig('core')
		const { svc, store, rig } = harness
		const [id] = await harness.seedPeers(1, 'member') as [string]
		rig.digest.set(id, 'd'.repeat(SNAPSHOT_DIGEST_CHARS))
		const diag = svc.getDiagnostics()
		const tick = (): Promise<void> => (svc as any).stabilizeOnce()
		/** Hand-driven ticks land inside the 500 ms strike-spacing window; rewind it as `failure-recovery.spec.ts` does. */
		const unspace = (): void => { store.update(id, { lastContactFailureAt: 0 }) }
		const entry = () => store.getById(id)!

		await tick() // 1: nothing cached → pinged and fetched, digest cached
		expect(rig.protocolsSeenBy(id), 'pinged then fetched').to.deep.equal([harness.ping(), harness.neighbors()])
		expect(diag.snapshotsFetched).to.equal(1)
		expect(diag.pingsSent).to.equal(1)

		await tick() // 2: heard during pass 1 (our own answered ping), digest fresh → skipped outright
		expect(rig.protocolsSeenBy(id), 'nothing opened on the skipped pass').to.have.lengthOf(2)
		expect(diag.pingsSent, 'no ping counted').to.equal(1)
		expect(diag.nearExchangeSkipped.probes).to.equal(1)
		expect(entry().contactFailures, 'no strike').to.equal(0)
		expect(entry().failureCount, 'no decay').to.equal(0)

		// Its traffic stops: every open now settles only on the ping's own deadline (`timeout`).
		rig.behavior.set(id, 'hangs')
		for (let i = 0; i < 3; i++) {
			unspace()
			await tick() // 3, 4, 5: the heard stamp is stale, so each probes and strikes once
			expect(entry().contactFailures, `strike ${i + 1}`).to.equal(i + 1)
		}
		expect(entry().state, 'dead on tick 5').to.equal('dead')
		expect(diag.nearExchangeSkipped.probes, 'exactly one skipped pass in the whole run').to.equal(1)
	})
})
