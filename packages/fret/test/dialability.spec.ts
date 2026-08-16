import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { ringOffset } from './helpers/ring.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { registerMaybeAct } from '../src/rpc/maybe-act.js'
import { makeProtocols } from '../src/rpc/protocols.js'
import { hashKey, hashPeerId } from '../src/ring/hash.js'
import { minDistance, lexLess } from '../src/ring/distance.js'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { fromString as u8FromString } from 'uint8arrays/from-string'
import { toString as u8ToString } from 'uint8arrays/to-string'
import type { NearAnchorV1, RouteProgress } from '../src/index.js'
import type { Libp2p } from 'libp2p'

// Every FRET outbound RPC ends at `openRpcStream`, which reuses an open connection and
// otherwise dials a *bare peer id*. FRET's wire messages carry peer-id strings only and
// contribute no multiaddrs, so that dial can only succeed when libp2p's own peerStore
// happens to hold an address. These specs cover the two halves of the guard: that
// `hasAddresses` answers honestly from the peerStore, and that the dial sites consult it.

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A syntactically valid peer id nobody holds an address for — an undialable "ghost". */
async function ghostPeerId(): Promise<string> {
	const key = await generateKeyPair('Ed25519')
	return peerIdFromPrivateKey(key).toString()
}

/**
 * Count `dialProtocol` calls on a node. A dial is the *only* way an addressless peer can be
 * contacted (a connected peer's stream is opened on the existing connection), so a zero count
 * is the witness that the guard skipped it rather than failing the dial.
 */
function countDials(node: Libp2p): () => number {
	let dials = 0
	const orig = (node as unknown as { dialProtocol: (...a: unknown[]) => unknown }).dialProtocol.bind(node)
	;(node as unknown as { dialProtocol: (...a: unknown[]) => unknown }).dialProtocol = (...args: unknown[]) => {
		dials++
		return orig(...args)
	}
	return () => dials
}

/** Place `id` in the service's store at `coord`, labelled a same-network member (ring views are member-only). */
function seedMember(svc: CoreFretService, id: string, coord: Uint8Array): void {
	svc.getStore().upsert(id, coord)
	svc.getStore().setMembership(id, 'member')
}

const base64url = (s: string): string => u8ToString(u8FromString(s), 'base64url')

describe('hasAddresses (peerStore-backed dialability)', function () {
	this.timeout(30000)

	// The contract, asserted without reference to any libp2p internal: a peer whose
	// multiaddrs are in the peerStore is address-known; one that is absent is not.
	it('is true for a peer the peerStore holds an address for, false for an absent peer', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		try {
			const svcA = new CoreFretService(nodeA, { profile: 'core', k: 7 })
			await nodeA.peerStore.merge(nodeB.peerId, { multiaddrs: nodeB.getMultiaddrs() })
			const absent = await ghostPeerId()

			await (svcA as any).seedFromPeerStore()

			expect((svcA as any).hasAddresses(nodeB.peerId.toString()), 'peerStore-known peer').to.equal(true)
			expect((svcA as any).hasAddresses(absent), 'peer absent from the peerStore').to.equal(false)
		} finally {
			await stopAll([nodeA, nodeB])
		}
	})

	// The set is rebuilt wholesale from each peerStore walk rather than merged into, so it
	// prunes itself: a peer whose peerStore record went away stops reading as dialable.
	it('drops a peer whose peerStore record is gone on the next rebuild', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		try {
			const svcA = new CoreFretService(nodeA, { profile: 'core', k: 7 })
			const idB = nodeB.peerId.toString()
			await nodeA.peerStore.merge(nodeB.peerId, { multiaddrs: nodeB.getMultiaddrs() })
			await (svcA as any).seedFromPeerStore()
			expect((svcA as any).hasAddresses(idB)).to.equal(true)

			await nodeA.peerStore.delete(nodeB.peerId)
			await (svcA as any).seedFromPeerStore()

			expect((svcA as any).hasAddresses(idB), 'pruned by the wholesale rebuild').to.equal(false)
		} finally {
			await stopAll([nodeA, nodeB])
		}
	})

	// Regression for the path the broken helper switched off entirely: announceToNewPeers
	// targets peers that are NOT connected but ARE address-known, so an always-false
	// hasAddresses made the whole method a no-op. The service under test is deliberately not
	// started — its stabilization loop would otherwise dial B and race the "non-connected" premise.
	it('announceToNewPeers reaches an address-known, non-connected peer', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		const svcB = new CoreFretService(nodeB, { profile: 'core', k: 7 })
		await svcB.start()
		try {
			const svcA = new CoreFretService(nodeA, { profile: 'core', k: 7 })
			const idA = nodeA.peerId.toString()
			const idB = nodeB.peerId.toString()
			await nodeA.peerStore.merge(nodeB.peerId, { multiaddrs: nodeB.getMultiaddrs() })
			await (svcA as any).seedFromPeerStore()
			expect(nodeA.getConnections(nodeB.peerId).length, 'premise: not connected').to.equal(0)

			await (svcA as any).announceToNewPeers([idB])

			expect(svcA.getDiagnostics().announcementsSent, 'announce sent to the address-known peer').to.equal(1)
			await delay(200)
			expect(svcB.getStore().getById(idA), 'B merged the announce').to.not.equal(undefined)
		} finally {
			await svcB.stop()
			await stopAll([nodeA, nodeB])
		}
	})
})

describe('dialability guard on outbound RPC', function () {
	this.timeout(30000)

	// Leave notices carry suggested replacements as bare peer-id strings straight off the
	// wire, so most are peers we hold no address for. Warming them can only end in
	// NoValidAddressesError.
	it('handleLeave does not dial a replacement peer we hold no address for', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		try {
			const svcA = new CoreFretService(nodeA, { profile: 'core', k: 7 })
			const departing = await ghostPeerId()
			const replacement = await ghostPeerId()
			const dials = countDials(nodeA)

			await (svcA as any).handleLeave({ v: 1, from: departing, replacements: [replacement], timestamp: Date.now() })
			await delay(100)

			expect(dials(), 'zero dials for an addressless replacement').to.equal(0)
			expect(svcA.getStore().getById(replacement), 'and it never enters the table').to.equal(undefined)
		} finally {
			await stopAll([nodeA])
		}
	})

	// Positive control for the spec above: the guard must skip only the undialable peers.
	// A leave notice no longer warms anything (see `churn.leave.spec.ts` — the replacement list is
	// recorded and probed later by the classification pass), so what separates the two arms is
	// whether the id is *recorded*, not whether it is dialed.
	it('handleLeave records a replacement whose address the peerStore holds', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		const svcB = new CoreFretService(nodeB, { profile: 'core', k: 7 })
		await svcB.start()
		try {
			const svcA = new CoreFretService(nodeA, { profile: 'core', k: 7 })
			await nodeA.peerStore.merge(nodeB.peerId, { multiaddrs: nodeB.getMultiaddrs() })
			await (svcA as any).seedFromPeerStore()
			// A replacement is only "new" if it is not already a ring neighbor; drop the store
			// entry the peerStore seed created so B arrives as a genuinely new suggestion whose
			// address we nonetheless hold.
			svcA.getStore().remove(nodeB.peerId.toString())
			const departing = await ghostPeerId()

			await (svcA as any).handleLeave({
				v: 1, from: departing, replacements: [nodeB.peerId.toString()], timestamp: Date.now()
			})

			expect(svcA.getStore().getById(nodeB.peerId.toString()), 'address-known replacement recorded').to.not.equal(undefined)
			expect(svcA.getDiagnostics().leaveReplacementsInserted, 'exactly one').to.equal(1)
		} finally {
			await svcB.stop()
			await stopAll([nodeA, nodeB])
		}
	})

	// Dialability is a hard filter on the candidate list, so the selector picks the best
	// *reachable* hop instead of dead-ending on an unreachable nearest one. Ghosts sit closest
	// to the key; B is farther but connected, and must be the hop that gets used.
	// NOTE: the forward below is a real request/response over two libp2p nodes, bounded by
	// `readAllBounded`'s 5s overall read deadline (src/rpc/protocols.ts) with no retry. Not
	// observed to fail; this spec's success still depends on that deadline in principle.
	it('routeAct forwards to the reachable candidate when nearer ones are undialable', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		const svcB = new CoreFretService(nodeB, { profile: 'core', k: 7 })
		await svcB.start()
		try {
			await nodeA.dial(nodeB.getMultiaddrs()[0]!)
			const svcA = new CoreFretService(nodeA, { profile: 'core', k: 7 })
			const keyB64 = base64url('route-key')
			const coord = await hashKey(u8FromString(keyB64, 'base64url'))
			const idA = nodeA.peerId.toString()
			const idB = nodeB.peerId.toString()
			const ghostSucc = await ghostPeerId()
			const ghostPred = await ghostPeerId()
			seedMember(svcA, ghostSucc, ringOffset(coord, 1))
			seedMember(svcA, ghostPred, ringOffset(coord, -1))
			const idBCoord = ringOffset(coord, 2)
			seedMember(svcA, idB, idBCoord)
			// Seed self at its real ring position, not a fabricated one. The store entry and the
			// selector must agree on where self sits: the strict-improvement floor reads
			// `FretService.selfCoord()` (the hashed peer id) and never the store, while the
			// in-cluster test reads the store's self entry — a fabricated coordinate makes the
			// two disagree and silently defeats this spec's own premise. A uniformly random self
			// coordinate is essentially never among the key's two nearest members when candidates
			// sit this close to the key, so this stays out-of-cluster as intended.
			const selfCoord = await hashPeerId(nodeA.peerId)
			seedMember(svcA, idA, selfCoord)
			// Assert the premise `routeAct` relies on instead of assuming it: self must be
			// farther from the key than the hop we expect it to forward to.
			expect(lexLess(minDistance(idBCoord, coord), minDistance(selfCoord, coord)), 'premise: hop nearer than self').to.equal(true)
			const dials = countDials(nodeA)

			const res = await svcA.routeAct({
				v: 1, key: keyB64, want_k: 2, ttl: 3, min_sigs: 1,
				breadcrumbs: [], correlation_id: 'dialability-route', timestamp: Date.now(), signature: ''
			})

			expect('anchors' in res, 'route produced a NearAnchor rather than dead-ending').to.equal(true)
			expect(dials(), 'no dial attempted for the addressless nearer candidates').to.equal(0)
			expect(svcA.getStore().getById(idB)?.successCount ?? 0, 'forwarded to the reachable hop').to.be.greaterThan(0)
			// A hop skipped for unreachability is not evidence of a foreign peer: the ghosts are
			// filtered out before selection, so they can never take a negotiate-failure strike.
			expect(svcA.getStore().getById(ghostSucc)?.negotiateFailures, 'no strike for a skipped hop').to.equal(0)
			expect(svcA.getStore().getById(ghostSucc)?.membership, 'still a member').to.equal('member')
		} finally {
			await svcB.stop()
			await stopAll([nodeA, nodeB])
		}
	})

	// The guard belongs to the ring walk's predicate, not to the assembled cohort: with the
	// whole requested cohort width (max(4, m) = 4 here) filled by unreachable peers on both
	// sides of the key, post-filtering the result empties it and the route dead-ends even
	// though a reachable hop sits just past the ghosts.
	it('routeAct still finds a hop when unreachable peers fill the whole cohort width', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		const svcB = new CoreFretService(nodeB, { profile: 'core', k: 7 })
		await svcB.start()
		try {
			await nodeA.dial(nodeB.getMultiaddrs()[0]!)
			const svcA = new CoreFretService(nodeA, { profile: 'core', k: 7 })
			const keyB64 = base64url('crowded-key')
			const coord = await hashKey(u8FromString(keyB64, 'base64url'))
			const idB = nodeB.peerId.toString()
			// Two ghosts each side, so the alternating walk fills all four cohort slots.
			for (const delta of [1, 2, -1, -2]) seedMember(svcA, await ghostPeerId(), ringOffset(coord, delta))
			const idBCoord = ringOffset(coord, 5)
			seedMember(svcA, idB, idBCoord)
			// Seed self at its real ring position — see the route-key spec above for why.
			const selfCoord = await hashPeerId(nodeA.peerId)
			seedMember(svcA, nodeA.peerId.toString(), selfCoord)
			expect(lexLess(minDistance(idBCoord, coord), minDistance(selfCoord, coord)), 'premise: hop nearer than self').to.equal(true)
			const dials = countDials(nodeA)

			await svcA.routeAct({
				v: 1, key: keyB64, want_k: 2, ttl: 3, min_sigs: 1,
				breadcrumbs: [], correlation_id: 'dialability-crowded', timestamp: Date.now(), signature: ''
			})

			expect(svcA.getStore().getById(idB)?.successCount ?? 0, 'forwarded past the ghosts').to.be.greaterThan(0)
			expect(dials(), 'no dial attempted for the ghosts').to.equal(0)
		} finally {
			await svcB.stop()
			await stopAll([nodeA, nodeB])
		}
	})

	// Leave notices run inside stop(), where a stack of doomed dials also delays shutdown.
	// nodeB is the positive control: address-known and not connected, so it must still be dialed.
	it('sendLeaveToNeighbors dials only the reachable neighbors', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		try {
			const svcA = new CoreFretService(nodeA, { profile: 'core', k: 7 })
			await nodeA.peerStore.merge(nodeB.peerId, { multiaddrs: nodeB.getMultiaddrs() })
			await (svcA as any).seedFromPeerStore()
			const selfCoord = await hashPeerId(nodeA.peerId)
			seedMember(svcA, await ghostPeerId(), ringOffset(selfCoord, 1))
			seedMember(svcA, await ghostPeerId(), ringOffset(selfCoord, -1))
			seedMember(svcA, nodeB.peerId.toString(), ringOffset(selfCoord, 2))
			expect(nodeA.getConnections(nodeB.peerId).length, 'premise: not connected').to.equal(0)
			const dials = countDials(nodeA)

			await (svcA as any).sendLeaveToNeighbors()

			expect(dials(), 'one dial — the address-known neighbor, none of the ghosts').to.equal(1)
		} finally {
			await stopAll([nodeA, nodeB])
		}
	})

	// The announce choke point is the one place FRET dials on purpose, so it owns both skips.
	it('the announce choke point skips undialable and confirmed-foreign targets', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		try {
			const svcA = new CoreFretService(nodeA, { profile: 'core', k: 7 })
			const idB = nodeB.peerId.toString()
			await nodeA.peerStore.merge(nodeB.peerId, { multiaddrs: nodeB.getMultiaddrs() })
			await (svcA as any).seedFromPeerStore()
			svcA.getStore().setMembership(idB, 'foreign')
			const snap = await (svcA as any).snapshot()
			const dials = countDials(nodeA)

			await (svcA as any).sendAnnouncementsRateLimited([await ghostPeerId(), idB], snap)

			expect(svcA.getDiagnostics().announcementsSent, 'neither target announced to').to.equal(0)
			expect(dials(), 'no dials').to.equal(0)
		} finally {
			await stopAll([nodeA, nodeB])
		}
	})

	it('iterativeLookup yields exhausted without dialing when every candidate is undialable', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		try {
			const svcA = new CoreFretService(nodeA, { profile: 'core', k: 7 })
			const key = u8FromString('lookup-key')
			const coord = await hashKey(key)
			seedMember(svcA, await ghostPeerId(), ringOffset(coord, 1))
			seedMember(svcA, await ghostPeerId(), ringOffset(coord, -1))
			seedMember(svcA, nodeA.peerId.toString(), await hashPeerId(nodeA.peerId))
			const dials = countDials(nodeA)

			const events: RouteProgress[] = []
			for await (const evt of svcA.iterativeLookup(key, { wantK: 1, minSigs: 1, ttl: 2 })) events.push(evt)

			expect(events.map(e => e.type), 'empty candidate set is the exhausted outcome').to.deep.equal(['exhausted'])
			expect(dials(), 'no dials attempted').to.equal(0)
		} finally {
			await stopAll([nodeA])
		}
	})

	// The anchors in a NearAnchor reply are remote-supplied ids; the sender contributes no
	// address for them. B is a stub responder that always answers with an addressless anchor.
	it('iterativeLookup does not dial an addressless anchor from a NearAnchor reply', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		try {
			const protocols = makeProtocols('anchor-net')
			const ghostAnchor = await ghostPeerId()
			const reply: NearAnchorV1 = {
				v: 1, anchors: [ghostAnchor], cohort_hint: [], estimated_cluster_size: 1, confidence: 0
			}
			await registerMaybeAct(nodeB, async () => reply, protocols.PROTOCOL_MAYBE_ACT)
			await nodeA.dial(nodeB.getMultiaddrs()[0]!)

			const svcA = new CoreFretService(nodeA, { profile: 'core', k: 7, networkName: 'anchor-net' })
			const key = u8FromString('anchor-key')
			const coord = await hashKey(key)
			seedMember(svcA, nodeB.peerId.toString(), ringOffset(coord, 1))
			seedMember(svcA, nodeA.peerId.toString(), await hashPeerId(nodeA.peerId))
			const dials = countDials(nodeA)

			const events: RouteProgress[] = []
			for await (const evt of svcA.iterativeLookup(key, {
				wantK: 1, minSigs: 1, activity: 'payload', ttl: 1
			})) events.push(evt)

			const types = events.map(e => e.type)
			expect(types, 'the reply was consumed').to.include('near_anchor')
			expect(types, 'no activity resend to an addressless anchor').to.not.include('activity_sent')
			expect(dials(), 'the anchor was never dialed').to.equal(0)
			expect(types[types.length - 1], 'walk still terminates').to.equal('exhausted')
		} finally {
			await stopAll([nodeA, nodeB])
		}
	})
})
