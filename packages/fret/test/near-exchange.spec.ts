import { afterEach, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { buildMaintenanceRig, type MaintenanceRig } from './helpers/maintenance-rig.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { hashPeerId, coordToBase64url, COORD_BYTES } from '../src/ring/hash.js'
import { NEAR_PROBE_MAX_SKIPS, SNAPSHOT_DIGEST_CHARS, snapshotDigest } from '../src/service/near-exchange.js'
import type { NeighborSnapshotV1 } from '../src/index.js'

// gotchoices/Fret#2: on an idle two-phone strand every stabilization pass pinged the other phone
// and downloaded its whole neighbour list, although the other phone had pinged *us* a moment ago
// and its list had not changed. Two skips, both from what earlier passes already learned
// (`src/service/near-exchange.ts`): the probe is skipped on fresh RPC evidence, the fetch is
// skipped when the ping reply's snapshot digest matches the content already merged.
//
// Three cases, kept to the ticket's list:
//   1. what the digest covers — pure, no network;
//   2. the reproduction — two real memory nodes driven pass by pass, alternately;
//   3. strike accounting on the stub-connection rig — a skip records nothing, and a peer whose
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
	async function member(): Promise<{ node: Libp2p; svc: CoreFretService }> {
		const node = await createMemNode()
		await node.start()
		nodes.push(node)
		const svc = new CoreFretService(node, { profile: 'core', networkName: 'net-test' })
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
})

describe('strike accounting across a skipped pass', function () {
	this.timeout(20000)

	let harness: MaintenanceRig | undefined

	afterEach(async () => {
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

		// Its traffic stops: every open now settles only on the ping's own 2 s deadline (`timeout`).
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
