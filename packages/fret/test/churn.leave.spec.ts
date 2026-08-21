import { after, before, describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { buildMesh, type Mesh } from './helpers/mesh.js'
import { waitFor } from './helpers/wait-for.js'
import { ringOffset } from './helpers/ring.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { registerLeave, sendLeave, type LeaveNoticeV1 } from '../src/rpc/leave.js'
import { registerNeighbors } from '../src/rpc/neighbors.js'
import { makeProtocols } from '../src/rpc/protocols.js'
import { hashPeerId } from '../src/ring/hash.js'
import { TokenBucket } from '../src/utils/token-bucket.js'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id'
import type { NeighborSnapshotV1 } from '../src/index.js'
import type { Libp2p } from 'libp2p'

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
const protocols = makeProtocols('default')

/** A syntactically valid peer id nobody holds an address for — undialable by construction. */
async function ghostPeerId(): Promise<string> {
	const key = await generateKeyPair('Ed25519')
	return peerIdFromPrivateKey(key).toString()
}

describe('Churn leave handling', function () {
	this.timeout(20000)

	// These rigs used to sleep a fixed 1.5-2.5s per phase and hope the ring had converged, which
	// made them the file's whole runtime (4.5s of the failing test's 4.8s) and left them asserting
	// on a wall-clock guess rather than on the ring. Measured, convergence lands at ~1.4-2.0s on an
	// idle machine — one ~1.5s stabilization tick after the dials — so the guess carried under 2x
	// headroom and nothing downstream could tell a slow tick from a broken one. The gates below
	// wait for the condition instead: they return as soon as it holds and throw naming the stalled
	// phase, so a future stall fails at the phase that stalled instead of as an opaque mocha
	// timeout at a later assertion. Budgets are sized so the worst case of both waits still fits
	// the 20s describe timeout alongside the rig's own setup and teardown.
	// NOTE: this file was once reported failing at the 20s budget inside a full-suite run while
	// passing in isolation. That has not been reproduced since (full suite green; this file green
	// under 5 concurrent copies), and the ~15s of overshoot is more than the fixed sleeps can
	// account for on their own — so if it recurs, the waitFor label is the first thing to read: a
	// gate that timed out points at stabilization, and a clean pass that still overruns points at
	// setup or teardown (the leave fan-out and `stopAll`), which these gates do not cover.
	const CONVERGE_MS = 6000
	const PROGRESS_MS = 5000

	let mesh: Mesh | undefined
	/** Indices a test stopped itself mid-case; afterEach must not double-stop them. */
	let alreadyStopped: number[] = []

	// Teardown lives here rather than at the end of each body so a rig whose assertion or
	// `waitFor` gate throws still stops its nodes — otherwise the leaked libp2p handles surface
	// as an exit-watchdog dump stacked on top of the real failure.
	afterEach(async () => {
		await mesh?.stop({ skip: alreadyStopped })
		mesh = undefined
		alreadyStopped = []
	})

	/**
	 * Every service knows every other node and has completed at least one neighbour exchange.
	 * Remote peers only: a store holds its own entry from `start()`, so a self-inclusive count is
	 * already true at t=0 and would wait on nothing (see `helpers/wait-for.ts`).
	 */
	const allConverged = (services: any[], selfIds: string[]) => () =>
		services.every((svc, i) =>
			svc.listPeers().filter((p: { id: string }) => p.id !== selfIds[i]).length >= services.length - 1
			&& svc.getDiagnostics().snapshotsFetched > 0)

	/** At least one survivor ran a stabilization tick after the departure. */
	const anyProgressed = (services: any[], before: Array<{ pingsSent: number }>, departed: number) => () =>
		services.some((svc, i) => i !== departed && svc.getDiagnostics().pingsSent > before[i]!.pingsSent)

	it('a graceful stop sends leave notices to its neighbors without throwing', async () => {
		mesh = await buildMesh(4)
		await mesh.addServices((_i, m) => ({ profile: 'edge', k: 7, bootstraps: [m.ids[0]!] }))
		await mesh.connect('star')
		await waitFor(allConverged(mesh.services, mesh.ids),
			CONVERGE_MS, 25, 'star of 4 converges before the leave')
		const diagsBefore = mesh.services.map((s: any) => ({ ...s.getDiagnostics() }))
		// stop one node, which should send leave to its neighbors without throwing
		await mesh.services[2]!.stop()
		await mesh.nodes[2]!.stop()
		// Recorded before the assertions below, so a failure there still leaves afterEach
		// skipping the index rather than double-stopping it.
		alreadyStopped.push(2)
		await waitFor(anyProgressed(mesh.services, diagsBefore, 2),
			PROGRESS_MS, 25, 'a survivor stabilizes after the leave')
		// ensure remaining services still running
		for (const s of [mesh.services[0], mesh.services[1], mesh.services[3]]) if (!(s as any).getDiagnostics) throw new Error('service down')
	})

	// NOTE: a `leave notice includes replacement suggestions` mesh test used to sit here. It spent
	// ~7 s converging six nodes to assert that `getDiagnostics()` has a `pingsSent` property and
	// that `listPeers()` is non-empty — neither of which is about replacements, and both of which
	// the deterministic specs below cover properly. What a six-node mesh at `k: 7` could never
	// observe is the replacement list itself: every remote peer sits inside the departing node's
	// own S/P window, so the pool is empty and the notice ships `replacements: undefined`. See
	// `Leave notice replacements (sender side)` at the bottom of this file.

	it('fan-out notifies peers beyond immediate S/P', async () => {
		mesh = await buildMesh(8)
		await mesh.addServices((_i, m) => ({ profile: 'core', k: 7, bootstraps: [m.ids[0]!] }))
		await mesh.connect('star')
		await waitFor(allConverged(mesh.services, mesh.ids),
			CONVERGE_MS, 25, 'star of 8 converges before the leave')

		const diagsBefore = mesh.services.map(s => ({ ...s.getDiagnostics() }))

		// Stop node 3 (middle-ish) — with core profile, fan-out = 4.
		// NOTE: what this rig can observe is the departure being survived, not the fan-out itself.
		// The extra (beyond-S/P) leave targets are `isConnected`-only, and the S/P targets are
		// `isDoomedDial`-filtered; a memory-transport node runs no `identify`, so a peer learned
		// only through gossip has no peerStore address and is undialable (`docs/fret.md`,
		// *Dialability*). In a star, node 3 is connected to node 0 alone, so the notice reaches
		// node 0 and nobody else. Observing a real beyond-S/P fan-out needs `createIdentifyNode`
		// plus a topology where the departing node holds several connections.
		await mesh.services[3]!.stop()
		await mesh.nodes[3]!.stop()
		alreadyStopped.push(3)
		await waitFor(anyProgressed(mesh.services, diagsBefore, 3),
			PROGRESS_MS, 25, 'a survivor stabilizes after the leave')

		// All remaining services should still be running
		for (let i = 0; i < mesh.services.length; i++) {
			if (i === 3) continue
			expect(mesh.services[i]!.getDiagnostics()).to.have.property('pingsSent')
		}
	})

	it('oversized replacements array is truncated', async () => {
		mesh = await buildMesh(3)
		await mesh.connect('star')

		let capturedReplacements: string[] | undefined

		// Register a custom leave handler on node 0 to capture the sanitized notice
		// First, unhandle any existing leave handler, then register our spy
		try { await mesh.nodes[0]!.unhandle(protocols.PROTOCOL_LEAVE) } catch {}

		const { registerLeave: regLeave } = await import('../src/rpc/leave.js')
		await regLeave(mesh.nodes[0]!, async (notice: LeaveNoticeV1) => {
			capturedReplacements = notice.replacements
		}, protocols.PROTOCOL_LEAVE)

		await new Promise(r => setTimeout(r, 500))

		// Send a crafted leave notice with 20 replacements (exceeds MAX_REPLACEMENTS=12)
		const replacementId = mesh.ids[1]!
		const fakeReplacements = Array.from({ length: 20 }, () => replacementId)
		// `from` must match the transport-authenticated sender (mesh.nodes[1]); the handler
		// now drops leaves whose `from` is spoofed, so this exercises replacement
		// truncation rather than the identity gate.
		const notice: LeaveNoticeV1 = {
			v: 1,
			from: mesh.ids[1]!,
			replacements: fakeReplacements,
			timestamp: Date.now(),
		}
		await sendLeave(mesh.nodes[1]!, mesh.ids[0]!, notice, protocols.PROTOCOL_LEAVE)
		await new Promise(r => setTimeout(r, 500))

		// Verify truncation: sanitizeReplacements caps at 12
		expect(capturedReplacements).to.be.an('array')
		expect(capturedReplacements!.length).to.be.at.most(12)
	})
})

/**
 * One inbound leave notice used to answer with up to twenty outbound RPCs (six pings, six
 * announces, four neighbor fetches, four more announces). These specs pin the replacement
 * contract: the notice's suggested ids are *recorded* as untrusted local hints and probed later
 * by the stabilization tick's classification pass, and the only outbound traffic a leave may
 * still cause is one debounced announce burst.
 */
describe('Leave amplification cap', function () {
	this.timeout(30000)

	interface LeaveRig {
		receiver: Libp2p
		svc: CoreFretService
		departing: Libp2p
		/** Ring coordinate of the departing peer — where `announceOnDeparture` centres its walk. */
		departingCoord: Uint8Array
		/** Start another memory node, torn down with the rig. */
		addNode(): Promise<Libp2p>
		/** Send one real leave notice from `departing`, then let the handler settle. */
		leave(replacements?: string[], settleMs?: number): Promise<void>
		stop(): Promise<void>
	}

	/**
	 * A receiver that answers *real* leave notices from a real second node — so
	 * `registerLeave`'s transport identity check passes rather than being bypassed — but whose
	 * `FretService` is deliberately never started. Every ping, neighbor fetch and announce these
	 * specs count therefore came from `handleLeave` and nothing else; a started service's
	 * stabilization loop would make the same deltas unattributable.
	 */
	async function makeLeaveRig(profile: 'core' | 'edge' = 'core'): Promise<LeaveRig> {
		const nodes: Libp2p[] = []
		const addNode = async (): Promise<Libp2p> => {
			const n = await createMemNode()
			await n.start()
			nodes.push(n)
			return n
		}
		const receiver = await addNode()
		const departing = await addNode()
		const svc = new CoreFretService(receiver, { profile, k: 7 })
		await registerLeave(receiver, async (notice) => (svc as any).handleLeave(notice), protocols.PROTOCOL_LEAVE)
		await departing.dial(receiver.getMultiaddrs()[0]!)
		return {
			receiver,
			svc,
			departing,
			departingCoord: await hashPeerId(departing.peerId),
			addNode,
			async leave(replacements?: string[], settleMs = 250): Promise<void> {
				const notice: LeaveNoticeV1 = {
					v: 1, from: departing.peerId.toString(), replacements, timestamp: Date.now()
				}
				await sendLeave(departing, receiver.peerId.toString(), notice, protocols.PROTOCOL_LEAVE)
				// The announce is detached, so settle rather than assert straight off the send.
				await delay(settleMs)
			},
			async stop(): Promise<void> { await stopAll(nodes) }
		}
	}

	/** A replacement the receiver can reach: connected, therefore dialable. */
	async function dialableReplacement(rig: LeaveRig): Promise<string> {
		const node = await rig.addNode()
		await rig.receiver.dial(node.getMultiaddrs()[0]!)
		return node.peerId.toString()
	}

	const emptySnapshot = (node: Libp2p): NeighborSnapshotV1 => ({
		v: 1, from: node.peerId.toString(), timestamp: Date.now(), successors: [], predecessors: [], sig: ''
	})

	// The core regression guard. Against the old handler this fails loudly: a leave carrying a
	// dialable replacement fired a ping, and (when the ping left the peer unconnected) an announce
	// and a neighbor fetch on top.
	it('an accepted leave sends no ping and no neighbor fetch', async () => {
		const rig = await makeLeaveRig()
		try {
			const replacement = await dialableReplacement(rig)
			const before = { ...rig.svc.getDiagnostics() }

			await rig.leave([replacement])

			const after = rig.svc.getDiagnostics()
			expect(after.pingsSent, 'no replacement was pinged').to.equal(before.pingsSent)
			expect(after.snapshotsFetched, 'no neighbor snapshot was fetched').to.equal(before.snapshotsFetched)
			expect(after.leaveReplacementsRecorded - before.leaveReplacementsRecorded,
				'premise: the replacement really was processed').to.equal(1)
		} finally { await rig.stop() }
	})

	// A replacement is a name we were handed, not a peer we contacted. It must arrive
	// unclassified (so the ring views exclude it until vetted) and take the general hearsay
	// score: a one-off baseline from its own empty counters, and *flat in mention count* — being
	// named again buys nothing, so an attacker cannot pump a named id past a genuine peer when
	// `enforceCapacity` evicts by relevance. The baseline itself is not zero on purpose: a
	// zero-relevance entry is the first thing evicted on a full table, so a never-scored
	// replacement would be dropped before any pass could probe it.
	it('records a dialable replacement as an unclassified entry, scored once and only once', async () => {
		const rig = await makeLeaveRig()
		try {
			const replacement = await dialableReplacement(rig)

			await rig.leave([replacement])

			const entry = rig.svc.getStore().getById(replacement)
			expect(entry, 'replacement recorded').to.not.equal(undefined)
			expect(entry!.membership, 'recorded as an untrusted hint, not as a member').to.equal('unknown')
			expect(entry!.relevance, 'scored, so it is not the first eviction victim').to.be.greaterThan(0)
			expect(entry!.accessCount, 'no frequency credit for a peer we never contacted').to.equal(0)

			// Naming it again must move nothing at all — the property the whole rule exists for.
			await rig.leave([replacement])
			await rig.leave([replacement])

			const after = rig.svc.getStore().getById(replacement)!
			expect(after.relevance, 'flat in mention count').to.equal(entry!.relevance)
			expect(after.accessCount, 'still no frequency credit').to.equal(0)
			expect(after.lastAccess, 'not even lastAccess is refreshed').to.equal(entry!.lastAccess)
		} finally { await rig.stop() }
	})

	// The bound on table pollution: an attacker cannot add peerStore addresses for ids it
	// invents, and an id no pass could ever probe has no business consuming a table slot.
	it('drops a replacement libp2p holds no address for', async () => {
		const rig = await makeLeaveRig()
		try {
			const ghost = await ghostPeerId()

			await rig.leave([ghost])

			expect(rig.svc.getStore().getById(ghost), 'undialable id never enters the table').to.equal(undefined)
			expect(rig.svc.getDiagnostics().leaveReplacementsRecorded, 'nothing inserted').to.equal(0)
		} finally { await rig.stop() }
	})

	// `upsert` preserves an existing entry, so a leave notice can never be used to demote or
	// re-zero an established peer by naming it.
	it('does not demote or re-zero an established member named as a replacement', async () => {
		const rig = await makeLeaveRig()
		try {
			const replacement = await dialableReplacement(rig)
			const store = rig.svc.getStore()
			store.upsert(replacement, await hashPeerId(peerIdFromString(replacement)))
			store.setMembership(replacement, 'member')
			store.update(replacement, { relevance: 4.25 })

			await rig.leave([replacement])

			const entry = store.getById(replacement)
			expect(entry!.membership, 'membership preserved').to.equal('member')
			expect(entry!.relevance, 'relevance preserved').to.equal(4.25)
		} finally { await rig.stop() }
	})

	// Self would be recreated as `unknown` and drop out of every member-only ring view; the
	// departing peer would be re-added moments after `handleLeave` removed it.
	it('never inserts self or the departing peer from the replacement list', async () => {
		const rig = await makeLeaveRig()
		try {
			const replacement = await dialableReplacement(rig)
			const selfId = rig.receiver.peerId.toString()
			const departingId = rig.departing.peerId.toString()
			const store = rig.svc.getStore()
			store.upsert(selfId, await hashPeerId(rig.receiver.peerId))
			store.setMembership(selfId, 'member')
			// libp2p never holds self in its own peerStore, so without this the dialability filter
			// would drop self first and the self guard would go untested.
			;(rig.svc as any).setAddressKnown(selfId, true)

			await rig.leave([selfId, departingId, replacement])

			expect(store.getById(selfId)!.membership, 'self stays a member of its own network').to.equal('member')
			expect(rig.svc.getDiagnostics().leaveReplacementsRecorded,
				'only the third id was recorded').to.equal(1)
		} finally { await rig.stop() }
	})

	// `isDialable`, not `isDoomedDial`: we are not dialing, so a locally `foreign` (or `dead`)
	// replacement is still worth recording — `upsert` preserves the label, and the matching
	// `reprobeOffRingTargets` arm owns re-probing it with its backoff intact. Filtering it out here
	// would instead make a leave notice able to *erase* our own classification work.
	it('records a foreign replacement without clearing its label', async () => {
		const rig = await makeLeaveRig()
		try {
			const replacement = await dialableReplacement(rig)
			const store = rig.svc.getStore()
			store.upsert(replacement, await hashPeerId(peerIdFromString(replacement)))
			store.setMembership(replacement, 'foreign')

			await rig.leave([replacement])

			expect(store.getById(replacement)!.membership, 'foreign label survives').to.equal('foreign')
			expect(rig.svc.getDiagnostics().leaveReplacementsRecorded,
				'recorded rather than skipped as a doomed dial').to.equal(1)
		} finally { await rig.stop() }
	})

	// `handleLeave` calls `store.remove(notice.from)`. Scoring helpers no longer resurrect a
	// removed peer (`applyTouch`/`applySuccess`/`applyFailure` return early on a miss — see
	// `docs/fret.md`, *Relevance scoring and table management*), so removal is durable through the
	// `peer:disconnect` that follows a graceful departure too, not just observable in isolation.
	// This rig's receiver service is never started, so this test covers the leave notice alone.
	// The real-`peer:disconnect` half is covered against a *started* service in
	// `test/scoring-never-creates.spec.ts` ('does not resurrect a peer that was removed while
	// connected'). Still uncovered: both halves driven in one sequence against one started
	// receiver - a real leave notice removing the peer, then that peer's real disconnect.
	it('removes the departing peer from the id map and from the ring window', async () => {
		const rig = await makeLeaveRig()
		try {
			const store = rig.svc.getStore()
			const departingId = rig.departing.peerId.toString()
			// Seeded at its true coordinate as a live member, so it genuinely occupies a ring slot
			// rather than merely an id-map slot.
			store.upsert(departingId, rig.departingCoord)
			store.setMembership(departingId, 'member')

			const selfCoord = await hashPeerId(rig.receiver.peerId)
			// Window width from `cfg.m` (= ceil(k / 2)), not a literal: a changed default k must
			// re-derive it rather than silently stop this assertion binding.
			const spWindow = () =>
				rig.svc.getNeighbors(selfCoord, 'both', Math.max(2, (rig.svc as any).cfg.m as number))
			expect(spWindow(), 'premise: the departing peer is in the S/P window before the notice')
				.to.include(departingId)

			await rig.leave()

			expect(store.getById(departingId), 'gone from the id index').to.equal(undefined)
			// The tree and the id index are separate views of one population; a removal that
			// updated only one is silently corrupting (see *Routing store* in `docs/fret.md`), and
			// the id-map check above cannot see it.
			expect(spWindow(), 'gone from the ring walk too, not only from the id map')
				.to.not.include(departingId)
		} finally { await rig.stop() }
	})

	// The 12-id cap bounds the work only if repeats are free: twelve copies of one id must cost
	// one hash and one upsert.
	it('collapses duplicate replacement ids to a single entry', async () => {
		const rig = await makeLeaveRig()
		try {
			const replacement = await dialableReplacement(rig)

			await rig.leave(Array.from({ length: 12 }, () => replacement))

			expect(rig.svc.getDiagnostics().leaveReplacementsRecorded, 'one insert, not twelve').to.equal(1)
			expect(rig.svc.getStore().getById(replacement), 'the single entry exists').to.not.equal(undefined)
		} finally { await rig.stop() }
	})

	/**
	 * Place `count` announce-eligible neighbors immediately either side of the departing peer's
	 * coordinate — addressable but not connected, which is the arm `announceTargetsAround`
	 * prefers. Returns their ids.
	 *
	 * Coordinates alternate ±1, ±2, … so both halves of the two-sided walk find candidates even
	 * when `count` exceeds what one side returns.
	 */
	async function seedAnnounceTargets(rig: LeaveRig, count: number): Promise<string[]> {
		const nodes: Libp2p[] = []
		for (let i = 0; i < count; i++) {
			const target = await rig.addNode()
			await registerNeighbors(target, () => emptySnapshot(target), () => {}, protocols)
			await rig.receiver.peerStore.merge(target.peerId, { multiaddrs: target.getMultiaddrs() })
			nodes.push(target)
		}
		// Populate `addressKnown` first: the seed walk re-upserts every peerStore peer at its
		// *hashed* coordinate, which would undo the placement below if it ran after.
		await (rig.svc as any).seedFromPeerStore()
		const store = rig.svc.getStore()
		return nodes.map((target, i) => {
			const id = target.peerId.toString()
			const step = Math.floor(i / 2) + 1
			store.upsert(id, ringOffset(rig.departingCoord, i % 2 === 0 ? step : -step))
			return id
		})
	}

	// A graceful departure fires the leave notice *and* the `peer:disconnect` that follows it.
	// Routing both through the debounced `announceOnDeparture` collapses them into one burst; two
	// notices from the same peer inside the window must therefore announce exactly once.
	it('announces at most one debounced burst per departing peer', async () => {
		const rig = await makeLeaveRig()
		try {
			const targets = await seedAnnounceTargets(rig, 2)
			const before = rig.svc.getDiagnostics().announcementsSent

			await rig.leave(undefined, 500)
			const afterFirst = rig.svc.getDiagnostics().announcementsSent
			await rig.leave(undefined, 500)
			const afterSecond = rig.svc.getDiagnostics().announcementsSent

			expect(afterFirst - before, 'one burst reached both seeded neighbors').to.equal(targets.length)
			expect(afterSecond, 'a second leave inside the debounce window adds nothing').to.equal(afterFirst)
		} finally { await rig.stop() }
	})

	// The other half of the announce ceiling: the debounce spec seeds fewer targets than the
	// fan-out, so on its own it cannot tell a clamp from an empty candidate list. Here the ring
	// offers more neighbors than `announceFanout`, so the burst size is decided by the clamp.
	it('clamps the departure burst to announceFanout when more neighbors are eligible', async () => {
		const rig = await makeLeaveRig('edge')
		try {
			const fanout = (rig.svc as any).announceFanout as number
			const targets = await seedAnnounceTargets(rig, fanout + 2)
			expect(targets.length, 'premise: more eligible neighbors than the fan-out').to.be.greaterThan(fanout)
			const before = rig.svc.getDiagnostics().announcementsSent

			await rig.leave(undefined, 500)

			expect(rig.svc.getDiagnostics().announcementsSent - before,
				'exactly announceFanout announces, not one per eligible neighbor').to.equal(fanout)
		} finally { await rig.stop() }
	})

	// `sendAnnouncementsRateLimited` increments `announcementsSkipped` **once** and then `break`s,
	// so a burst that outruns the bucket costs at most +1 skip however many targets are left. That
	// was stated nowhere: the two `proactive-announce.spec.ts` tests that reached for the counter
	// asserted only that the field existed and was a number.
	it('stops the departure burst at the first empty-bucket skip', async () => {
		const rig = await makeLeaveRig('edge')
		try {
			const fanout = (rig.svc as any).announceFanout as number
			// The burst is clamped to `announceFanout` before the bucket ever sees it, so the
			// premise that produces a skip is `fanout > tokens` — not the seeded count. Asserting
			// the seeded count instead would let a profile whose fan-out dropped to 2 spend both
			// tokens, skip nothing, and fail at the `announcementsSkipped` assertion with no hint
			// that the fan-out was what changed.
			expect(fanout, 'premise: the fan-out outruns the two tokens seeded below').to.be.greaterThan(2)
			const targets = await seedAnnounceTargets(rig, fanout + 2)
			expect(targets.length, 'premise: more eligible neighbors than the fan-out').to.be.greaterThan(fanout)
			// Exactly two tokens. Replacing the bucket rather than draining the profile's own is
			// what makes the level exact — `TokenBucket` can be emptied but not drained *to* a
			// level, and an emptied bucket then races its own refill. The rate stays at edge's
			// 2/s (one token per 500 ms) while the burst below completes in milliseconds, so no
			// token returns mid-burst; the 500 ms settle after it only refills a bucket nobody
			// reads again.
			;(rig.svc as any).bucketAnnounce = new TokenBucket(2, 2)
			const before = { ...rig.svc.getDiagnostics() }

			await rig.leave(undefined, 500)

			const after = rig.svc.getDiagnostics()
			expect(after.announcementsSent - before.announcementsSent,
				'exactly the two tokens the bucket held, not the whole fan-out').to.equal(2)
			expect(after.announcementsSkipped - before.announcementsSkipped,
				'one skip for the whole burst, not one per remaining target').to.equal(1)
		} finally { await rig.stop() }
	})

	// The hand-off the whole redesign rests on: recording a replacement as `unknown` is not a
	// dead end, because `classifyTargets` selects exactly that set on the next tick.
	it('the classification pass probes and promotes a replacement recorded by a leave', async () => {
		const rig = await makeLeaveRig()
		let replacementSvc: CoreFretService | undefined
		try {
			const replacementNode = await rig.addNode()
			replacementSvc = new CoreFretService(replacementNode, { profile: 'core', k: 7 })
			await replacementSvc.start()
			await rig.receiver.dial(replacementNode.getMultiaddrs()[0]!)
			const replacement = replacementNode.peerId.toString()

			await rig.leave([replacement])
			expect(rig.svc.getStore().getById(replacement)!.membership,
				'starts out unclassified').to.equal('unknown')

			await (rig.svc as any).stabilizeOnce()

			expect(rig.svc.getStore().getById(replacement)!.membership,
				'one stabilization tick promotes it to member').to.equal('member')
			expect(rig.svc.getDiagnostics().pingsOk,
				'promoted by a real namespaced ping, not by assumption').to.be.greaterThan(0)
		} finally {
			await replacementSvc?.stop()
			await rig.stop()
		}
	})
})

/**
 * The *sending* half of the leave protocol: what a departing node puts in the notice.
 *
 * `computeReplacements` (`src/service/fret-service.ts`) had no test at all, and a live mesh cannot
 * give it one — at `k: 7` on six nodes every remote peer falls inside the departing node's own
 * successor/predecessor window, so the replacement pool is empty and the notice ships
 * `replacements: undefined`. These specs seed the ring by hand instead, at a small `k` so the two
 * windows are separable and every expected set is derivable from the offsets.
 */
describe('Leave notice replacements (sender side)', function () {
	this.timeout(30000)

	interface SenderRig {
		/** The departing node's service — deliberately never started; its store is seeded by hand. */
		svc: CoreFretService
		/** The peer id seeded at `ringOffset(selfCoord, offset)`. */
		idAt(offset: number): string
		/** Run one real `sendLeaveToNeighbors` and return the notice the real receiver got. */
		send(): Promise<LeaveNoticeV1>
		/** Every notice each real receiver got, by its ring offset — so a missing side is visible. */
		noticesAt(offset: number): LeaveNoticeV1[]
		stop(): Promise<void>
	}

	/** The one seeded peer that is a real, dialable node — so it is a notice target that can answer. */
	const RECEIVER_OFFSET = 1

	/**
	 * A departing node whose routing table holds exactly `count` live members, at ring offsets
	 * `+1 … +count` from its own coordinate.
	 *
	 * Two properties the specs below read off those offsets:
	 *
	 * - Every seeded coordinate is *above* self's, so the clockwise walk from self runs
	 *   `+1, +2, …` in order and the counter-clockwise walk finds nothing at or below self, wraps,
	 *   and runs `+count, +count-1, …`. Both windows are therefore stated by offset alone.
	 * - Only the peer at {@link RECEIVER_OFFSET} is a real node. The rest are bare keys libp2p
	 *   holds no address for, so `isDoomedDial` skips them as notice *targets* — which is fine and
	 *   intended: they are still live members, so they remain replacement candidates, and the
	 *   assertions are about what the notice carries rather than about who received it.
	 */
	async function makeSenderRig(
		k: number,
		count: number,
		realOffsets: number[] = [RECEIVER_OFFSET]
	): Promise<SenderRig> {
		const nodes: Libp2p[] = []
		const departing = await createMemNode(); await departing.start(); nodes.push(departing)

		const received = new Map<number, LeaveNoticeV1[]>()
		const realIds = new Map<number, string>()
		for (const offset of realOffsets) {
			const receiver = await createMemNode(); await receiver.start(); nodes.push(receiver)
			const log: LeaveNoticeV1[] = []
			received.set(offset, log)
			realIds.set(offset, receiver.peerId.toString())
			await registerLeave(receiver, (notice) => { log.push(notice) }, protocols.PROTOCOL_LEAVE)
			// The dial is what makes the receiver `isConnected`, and therefore dialable. It also
			// makes the notice's `from` match the transport-authenticated sender, so
			// `registerLeave`'s identity gate passes rather than being what the spec accidentally
			// exercises.
			await departing.dial(receiver.getMultiaddrs()[0]!)
		}
		const primary = received.get(realOffsets[0]!)!

		const svc = new CoreFretService(departing, { profile: 'core', k })
		const selfCoord = await hashPeerId(departing.peerId)
		const store = svc.getStore()
		const byOffset = new Map<number, string>()
		for (let offset = 1; offset <= count; offset++) {
			const id = realIds.get(offset) ?? await ghostPeerId()
			byOffset.set(offset, id)
			store.upsert(id, ringOffset(selfCoord, offset))
			store.setMembership(id, 'member')
		}
		return {
			svc,
			idAt: (offset: number) => byOffset.get(offset)!,
			noticesAt: (offset: number) => received.get(offset) ?? [],
			async send(): Promise<LeaveNoticeV1> {
				await (svc as any).sendLeaveToNeighbors()
				// `sendLeave` is write-only — it closes the stream rather than awaiting a reply —
				// so the receiver's handler runs after the send resolves.
				await waitFor(() => primary.length > 0, 5000, 10, 'the real receiver got a leave notice')
				return primary[0]!
			},
			async stop(): Promise<void> { await stopAll(nodes) }
		}
	}

	// The three rules `computeReplacements` encodes: the pool is the 2m-per-side walk, the notice's
	// own targets are excluded from it, and the walk is live-member-scoped (the
	// transitive-propagation guard documented under *Leave* in `docs/fret.md`).
	it('advertises the live members just outside the S/P window, and only those', async () => {
		const rig = await makeSenderRig(3, 9)
		try {
			const m = (rig.svc as any).cfg.m as number
			expect(m, 'premise: m = ceil(k / 2), so k of 3 gives a two-wide window per side').to.equal(2)

			const store = rig.svc.getStore()
			// A live-member walk *skips and keeps advancing*, so excluding +3 and +4 pulls the
			// clockwise 2m-walk out to +5 and +6 rather than shortening it to two ids.
			store.setMembership(rig.idAt(3), 'foreign')
			store.setState(rig.idAt(4), 'dead')

			const notice = await rig.send()

			// Targets: clockwise {+1, +2}, counter-clockwise {+9, +8}.
			// Replacement pool: clockwise 2m = {+1, +2, +5, +6}, counter-clockwise 2m =
			// {+9, +8, +7, +6}; minus the targets, that leaves {+5, +6, +7}.
			const expected = [5, 6, 7].map((o) => rig.idAt(o))
			expect([...notice.replacements!].sort(),
				'the 2m-per-side live-member walk minus the notice targets')
				.to.deep.equal([...expected].sort())
			expect(notice.replacements, 'a peer we know serves another network is never advertised')
				.to.not.include(rig.idAt(3))
			expect(notice.replacements, 'a peer a run of failed contacts killed is never advertised')
				.to.not.include(rig.idAt(4))
			for (const offset of [1, 2, 9, 8]) {
				expect(notice.replacements, `+${offset} is a notice target, so never its own replacement`)
					.to.not.include(rig.idAt(offset))
			}
		} finally { await rig.stop() }
	})

	// `maxReplacements` in `computeReplacements`. The spec above cannot reach it — at m = 2 the
	// pool tops out at 2m = 4 candidates — so the cap needs a wider ring.
	it('caps the replacement list at six ids', async () => {
		const rig = await makeSenderRig(7, 20)
		try {
			const m = (rig.svc as any).cfg.m as number
			expect(m, 'premise: k of 7 gives a four-wide window per side').to.equal(4)

			const notice = await rig.send()

			// Targets: {+1..+4} and {+20..+17}. The replacement walk asks for 2m = 8 per side
			// *after* excluding those eight, so the pool reaches out to {+5..+16} — twelve
			// eligible ids for six slots. The helper interleaves the two sides, so the cap takes
			// the innermost peers on each side alternately rather than emptying one side first.
			const innermost = [5, 6, 7, 14, 15, 16].map((o) => rig.idAt(o))
			expect(notice.replacements!.length, 'maxReplacements, not one per eligible peer').to.equal(6)
			for (const id of notice.replacements!) {
				expect(innermost, 'the cap takes the innermost peers on both sides, not one whole side')
					.to.include(id)
			}
		} finally { await rig.stop() }
	})

	/**
	 * The shipped default, and the only width at which the old bug bit.
	 *
	 * `sendLeaveToNeighbors` used to walk side-major (all successors, then all predecessors) and
	 * cap the *concatenation* at 8. At `k: 15` the window is m = 8 per side, so those 8 slots were
	 * spent entirely on the clockwise side: no predecessor was ever notified, and the same
	 * truncated array was then handed to `computeReplacements` as "our own S/P window", so six
	 * genuine predecessors read as outside it and were advertised to our own neighbors as
	 * replacements for us.
	 *
	 * The specs above run at `k: 3` / `k: 7`, where m is 2 / 4 and both windows together fit
	 * inside 8 — the cap never bit, so neither could see any of this.
	 */
	describe('at the shipped k of 15', function () {
		// Windows at m = 8 over 40 seeded peers: clockwise {+1..+8}, counter-clockwise
		// {+40..+33}. The replacement walk reaches 16 per side beyond those, so the pool is
		// {+9..+24} clockwise and {+32..+17} counter-clockwise — and {+25..+32} is reachable
		// **only** counter-clockwise, which is what makes the interleave observable at all.
		const COUNT = 40
		const SUCC_WINDOW = [1, 2, 3, 4, 5, 6, 7, 8]
		const PRED_WINDOW = [40, 39, 38, 37, 36, 35, 34, 33]
		const OUTSIDE = Array.from({ length: 24 }, (_, i) => i + 9)
		/** Reachable counter-clockwise only: a side-major cap can never include one of these. */
		const PRED_ONLY = [25, 26, 27, 28, 29, 30, 31, 32]
		/** One real, dialable node per side of the window, plus one outside it. */
		const SUCC_RECEIVER = 1
		const PRED_RECEIVER = 40
		// Outside the S/P window but still inside the beyond-S/P arm's reach: that arm asks
		// `expandCohort` for `ids.length + fanOut` = 20 ids around self, which the alternating
		// walk fills 10 per side, i.e. {+1..+10} and {+40..+31}. +9 leaves a slot of margin;
		// a peer past +10 is outside the window *and* outside the fan-out, so it tests nothing.
		// NOTE: this offset assumes `expandCohort`'s reach rather than asserting it; a future
		// change to `fanOut` or to its over-fetch would make the fan-out case vacuous rather
		// than fail. Assert the reach here if that ever bites.
		const OUTSIDE_RECEIVER = 9

		let rig: SenderRig | undefined
		let notice: LeaveNoticeV1
		// One departure shared by the four assertions below: `sendLeaveToNeighbors` is a
		// once-per-lifetime call, and re-running it per case would cost four meshes to observe
		// the same notice.
		before(async function () {
			this.timeout(30000)
			rig = await makeSenderRig(15, COUNT, [SUCC_RECEIVER, PRED_RECEIVER, OUTSIDE_RECEIVER])
			expect((rig.svc as any).cfg.m,
				'premise: m = ceil(k / 2), so k of 15 gives an eight-wide window per side').to.equal(8)
			notice = await rig.send()
		})
		after(async () => { await rig?.stop(); rig = undefined })

		it('notifies the predecessor side, not only the successors', () => {
			expect(rig!.noticesAt(SUCC_RECEIVER).length,
				'the clockwise side was reached even under the old cap').to.equal(1)
			expect(rig!.noticesAt(PRED_RECEIVER).length,
				'the counter-clockwise side — nothing arrived here under the old side-major slice')
				.to.equal(1)
		})

		it('advertises no peer that is inside its own S/P window', () => {
			const window = [...SUCC_WINDOW, ...PRED_WINDOW].map((o) => rig!.idAt(o))
			for (const id of notice.replacements ?? []) {
				expect(window, 'a peer we are notifying is never also advertised as our replacement')
					.to.not.include(id)
			}
		})

		it('draws every replacement from beyond that window, both sides', () => {
			const idsAt = (offsets: number[]) => offsets.map((o) => rig!.idAt(o))
			// 16 ids excluded from a 2m = 16-per-side walk: without the helper's `+ exclude.size`
			// over-fetch, a side the exclusions blanket yields nothing and the list comes from one
			// side only.
			expect(notice.replacements!.length, 'maxReplacements, filled').to.equal(6)
			for (const id of notice.replacements!) {
				expect(idsAt(OUTSIDE), 'the pool is the wider walk minus the window').to.include(id)
			}
			// The discriminating half. {+25..+32} is past the clockwise walk's 16-id trim, so it
			// is reachable only counter-clockwise: under the side-major ordering this change
			// replaced, the six-id cap fills from {+9..+14} and none of these can appear.
			const fromPredOnly = notice.replacements!.filter((id) => idsAt(PRED_ONLY).includes(id))
			expect(fromPredOnly.length,
				'interleaved, so the cap takes from both sides rather than emptying the clockwise one')
				.to.be.greaterThan(0)
		})

		it('sends each peer exactly one notice, S/P and beyond-S/P together', () => {
			// The third reader of the same array: the beyond-S/P fan-out filters on
			// `!spSet.has(id)`. Widening `spSet` to the true window *shrinks* that arm — a
			// connected predecessor is now reached as an S/P member instead of as fan-out. Either
			// way it must be reached exactly once, which is what one shared array buys and two
			// divergent copies cannot.
			expect(rig!.noticesAt(OUTSIDE_RECEIVER).length,
				'a connected peer outside the window is still reached, by the fan-out arm').to.equal(1)
			for (const offset of [SUCC_RECEIVER, PRED_RECEIVER, OUTSIDE_RECEIVER]) {
				expect(rig!.noticesAt(offset).length, `+${offset} got exactly one notice`).to.equal(1)
			}
		})
	})
})
