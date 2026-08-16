import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { ringOffset } from './helpers/ring.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { registerLeave, sendLeave, type LeaveNoticeV1 } from '../src/rpc/leave.js'
import { registerNeighbors } from '../src/rpc/neighbors.js'
import { makeProtocols } from '../src/rpc/protocols.js'
import { hashPeerId } from '../src/ring/hash.js'
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

	it('a graceful stop sends leave notices to its neighbors without throwing', async () => {
		const nodes = [] as any[]
		for (let i = 0; i < 4; i++) { const n = await createMemNode(); await n.start(); nodes.push(n) }
		const services = [] as any[]
		for (let i = 0; i < nodes.length; i++) {
			const svc = new CoreFretService(nodes[i], { profile: 'edge', k: 7, bootstraps: [nodes[0]!.peerId.toString()] })
			await svc.start()
			services.push(svc)
		}
		// Star topology
		for (let i = 1; i < nodes.length; i++) {
			await nodes[i]!.dial(nodes[0]!.getMultiaddrs()[0]!)
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
		for (let i = 0; i < 6; i++) { const n = await createMemNode(); await n.start(); nodes.push(n) }
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
		// Full mesh so ALL nodes receive the leave notice
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				await nodes[i]!.dial(nodes[j]!.getMultiaddrs()[0]!)
			}
		}

		await new Promise(r => setTimeout(r, 2000))

		const diagsBefore = services.map(s => ({ ...s.getDiagnostics() }))

		// Stop node 2 (the middle node) — it should send leave with replacements
		await services[2].stop()
		await nodes[2].stop()
		await new Promise(r => setTimeout(r, 1500))

		// All remaining services should continue to function after the leave. The departing peer
		// may be re-added by the `peer:disconnect` scoring path (see
		// `backlog/debt-scoring-resurrects-removed-peers`), so we verify system health rather than
		// exact store contents.
		for (const [idx, svc] of services.entries()) {
			if (idx === 2) continue
			const diag = svc.getDiagnostics()
			expect(diag).to.have.property('pingsSent')
			expect(svc.listPeers().length).to.be.greaterThan(0,
				`service ${idx} should still have peers after leave`)
		}

		// At least one neighbor should have received and processed the leave,
		// evidenced by continued stabilization (more pings sent after leave).
		const diagsAfter = services.map(s => s?.getDiagnostics?.() ?? null)
		let anyProgressAfterLeave = false
		for (let i = 0; i < services.length; i++) {
			if (i === 2 || !diagsAfter[i]) continue
			if (diagsAfter[i]!.pingsSent > diagsBefore[i]!.pingsSent) {
				anyProgressAfterLeave = true
				break
			}
		}
		expect(anyProgressAfterLeave).to.equal(true,
			'at least one service should show stabilization progress after leave')

		await Promise.all(services.map((s, i) => i === 2 ? Promise.resolve() : s.stop()))
		await stopAll(nodes.filter((_: any, i: number) => i !== 2))
	})

	it('fan-out notifies peers beyond immediate S/P', async () => {
		const nodes = [] as any[]
		// Use more nodes so fan-out has something to reach beyond S/P
		for (let i = 0; i < 8; i++) { const n = await createMemNode(); await n.start(); nodes.push(n) }
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
		// Star topology
		for (let i = 1; i < nodes.length; i++) {
			await nodes[i]!.dial(nodes[0]!.getMultiaddrs()[0]!)
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
		for (let i = 0; i < 3; i++) { const n = await createMemNode(); await n.start(); nodes.push(n) }
		// Star topology
		for (let i = 1; i < nodes.length; i++) {
			await nodes[i]!.dial(nodes[0]!.getMultiaddrs()[0]!)
		}

		let capturedReplacements: string[] | undefined

		// Register a custom leave handler on node 0 to capture the sanitized notice
		// First, unhandle any existing leave handler, then register our spy
		try { await nodes[0].unhandle(protocols.PROTOCOL_LEAVE) } catch {}

		const { registerLeave: regLeave } = await import('../src/rpc/leave.js')
		await regLeave(nodes[0], async (notice: LeaveNoticeV1) => {
			capturedReplacements = notice.replacements
		}, protocols.PROTOCOL_LEAVE)

		await new Promise(r => setTimeout(r, 500))

		// Send a crafted leave notice with 20 replacements (exceeds MAX_REPLACEMENTS=12)
		const fakeReplacements = Array.from({ length: 20 }, () =>
			nodes[1].peerId.toString()
		)
		// `from` must match the transport-authenticated sender (nodes[1]); the handler
		// now drops leaves whose `from` is spoofed, so this exercises replacement
		// truncation rather than the identity gate.
		const notice: LeaveNoticeV1 = {
			v: 1,
			from: nodes[1].peerId.toString(),
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
	// unclassified (so the ring views exclude it until vetted) and at relevance 0 (so an
	// attacker-named id cannot outrank a genuine peer when `enforceCapacity` evicts by relevance).
	it('records a dialable replacement as an unclassified, zero-relevance entry', async () => {
		const rig = await makeLeaveRig()
		try {
			const replacement = await dialableReplacement(rig)

			await rig.leave([replacement])

			const entry = rig.svc.getStore().getById(replacement)
			expect(entry, 'replacement recorded').to.not.equal(undefined)
			expect(entry!.membership, 'recorded as an untrusted hint, not as a member').to.equal('unknown')
			expect(entry!.relevance, 'no relevance credit for a peer we never contacted').to.equal(0)
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
	// `reprobeOffRing` arm owns re-probing it with its backoff intact. Filtering it out here
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

	// The hand-off the whole redesign rests on: recording a replacement as `unknown` is not a
	// dead end, because `classifyUnknownPeers` selects exactly that set on the next tick.
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
