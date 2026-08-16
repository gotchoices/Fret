import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { ringOffset } from './helpers/ring.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { hashKey, hashPeerId } from '../src/ring/hash.js'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { fromString as u8FromString } from 'uint8arrays/from-string'
import { toString as u8ToString } from 'uint8arrays/to-string'
import type { RouteAndMaybeActV1 } from '../src/index.js'
import type { Libp2p } from 'libp2p'

// `routeAct`'s "am I in the cluster for this key?" test is the doc's local membership test:
// self must appear among the first `max(2, min(wants ?? want_k, want_k))` entries of the key's
// alternating two-sided cohort. It used to admit only cohort indices 0 and 1 — the two
// key-adjacent anchors — so a genuine cluster member at index 3 forwarded instead of acting,
// spending a hop the sender never budgeted for (it attached the activity precisely because
// `shouldIncludePayload` judged the receiver near enough to act).
//
// Every spec here drives `routeAct` directly on an **unstarted** service, so no stabilization
// timer runs and the store holds exactly what each spec seeds.

/** A syntactically valid peer id nobody holds an address for — an undialable "ghost". */
async function ghostPeerId(): Promise<string> {
	const key = await generateKeyPair('Ed25519')
	return peerIdFromPrivateKey(key).toString()
}

/** Count `dialProtocol` calls: a peer that acts locally must never reach out. */
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

/**
 * Seed `index` undialable ghosts so that self lands at exactly cohort index `index` for `coord`.
 *
 * The alternating walk fills slot i from the successor side when i is even and the predecessor
 * side when i is odd, so filling slots 0…index-1 means ghosts at key+1, key−1, key+2, key−2, …
 * Self's coordinate is the SHA-256 of its peer id — uniformly random, so it is never within a
 * handful of ring units of the key and therefore always sorts *behind* every ghost on both
 * walks. That puts it at the first unfilled slot, `index`.
 *
 * The ghosts are addressless on purpose: when a spec expects a forward, the forward must find no
 * dialable hop, so the observable outcome is the NearAnchor fallback and a dial count of zero.
 */
async function seedGhostsBefore(svc: CoreFretService, coord: Uint8Array, index: number): Promise<string[]> {
	const ids: string[] = []
	for (let i = 0; i < index; i++) {
		const step = Math.floor(i / 2) + 1
		const delta = i % 2 === 0 ? step : -step
		const id = await ghostPeerId()
		seedMember(svc, id, ringOffset(coord, delta))
		ids.push(id)
	}
	return ids
}

const base64url = (s: string): string => u8ToString(u8FromString(s), 'base64url')

/** An unstarted service with self seeded at its real ring position, plus `index` ghosts ahead of it. */
async function buildAt(node: Libp2p, keyB64: string, index: number): Promise<{
	svc: CoreFretService
	coord: Uint8Array
	ghosts: string[]
}> {
	const svc = new CoreFretService(node, { profile: 'core', k: 7 })
	const coord = await hashKey(u8FromString(keyB64, 'base64url'))
	const ghosts = await seedGhostsBefore(svc, coord, index)
	// Self must sit at its *real* ring position: the in-cluster test reads the store's self
	// entry while the forwarding floor reads `selfCoord()` (the hashed peer id), and a fabricated
	// coordinate makes the two disagree — see the note at test/dialability.spec.ts:202.
	seedMember(svc, node.peerId.toString(), await hashPeerId(node.peerId))
	// Assert the premise rather than trusting the seeding arithmetic above: if a future change to
	// the cohort walk moves self, every spec below should fail *here*, naming the real cause,
	// instead of failing at the gate and reading as a membership-window regression.
	expect(svc.neighborDistance(node.peerId.toString(), coord, index + 1),
		`premise: self sits at cohort index ${index}`).to.equal(index)
	return { svc, coord, ghosts }
}

/**
 * Seed `decoy` as a genuinely **dialable** member three ring units clockwise of the key — nearer
 * the key than self, so it clears the selector's strict-improvement floor and is the hop a
 * forwarding node would take.
 *
 * It exists to make "acted locally" observable. With only undialable ghosts in the store, an
 * out-of-cluster node finds no hop and also answers with a NearAnchor, so the narrow gate and the
 * wide one produce the same reply; a reachable hop separates them (`maybeActForwarded` / dials).
 * At ring offset +3 it lands at cohort index 4, leaving self's index unchanged.
 *
 * Order matters: `seedFromPeerStore` is what makes `hasAddresses` true, and it upserts the decoy
 * at its own hashed coordinate — so the re-key to +3 has to come after it.
 */
async function seedDialableDecoy(
	svc: CoreFretService, host: Libp2p, decoy: Libp2p, coord: Uint8Array
): Promise<void> {
	await host.peerStore.merge(decoy.peerId, { multiaddrs: decoy.getMultiaddrs() })
	await (svc as unknown as { seedFromPeerStore: () => Promise<void> }).seedFromPeerStore()
	seedMember(svc, decoy.peerId.toString(), ringOffset(coord, 3))
	expect((svc as unknown as { isDialable: (id: string) => boolean }).isDialable(decoy.peerId.toString()),
		'premise: the decoy is a reachable hop').to.equal(true)
}

function msg(keyB64: string, over: Partial<RouteAndMaybeActV1> = {}): RouteAndMaybeActV1 {
	return {
		v: 1,
		key: keyB64,
		want_k: 7,
		ttl: 3,
		min_sigs: 1,
		breadcrumbs: [],
		correlation_id: `in-cluster-width-${Math.random()}`,
		timestamp: Date.now(),
		signature: '',
		...over,
	}
}

/** Installs a counting activity handler and reports how many times it fired. */
function countingHandler(svc: CoreFretService): { calls: () => number; cohorts: () => string[][] } {
	let calls = 0
	const cohorts: string[][] = []
	svc.setActivityHandler(async (_activity, cohort) => {
		calls++
		cohorts.push(cohort)
		return { commitCertificate: 'cert' }
	})
	return { calls: () => calls, cohorts: () => cohorts }
}

describe('in-cluster membership window', function () {
	this.timeout(30000)

	// The regression witness. Self is a genuine cluster member at index 3 of a 7-wide cohort, so
	// the doc says it acts; the old `distIdx <= 1` gate made it forward instead.
	it('acts locally at cohort index 3 of a want_k 7 cluster', async () => {
		const node = await createMemNode(); await node.start()
		try {
			const keyB64 = base64url('width-index-3')
			const { svc } = await buildAt(node, keyB64, 3)
			const handler = countingHandler(svc)
			const dials = countDials(node)

			const res = await svc.routeAct(msg(keyB64, { activity: base64url('payload') }))

			expect(handler.calls(), 'handler fired exactly once').to.equal(1)
			expect(res, 'the commit certificate is the answer').to.deep.equal({ commitCertificate: 'cert' })
			expect(svc.getDiagnostics().maybeActForwarded, 'no forward').to.equal(0)
			expect(dials(), 'no dials').to.equal(0)
		} finally {
			await stopAll([node])
		}
	})

	// The digest-probe arm of the same widening: a cohort-index-3 peer now answers the probe
	// itself rather than forwarding it to an anchor first, saving a round trip. Anchor quality is
	// preserved because `pickAnchors` still measures against the key's own coordinate.
	//
	// The undialable ghosts alone cannot witness this — with no reachable hop, forwarding also
	// falls through to a NearAnchor, so both gates look identical. The decoy is a genuinely
	// dialable peer nearer the key than self, which the old gate *did* forward to.
	it('answers a digest-only probe itself at cohort index 3 rather than forwarding', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		try {
			const keyB64 = base64url('width-index-3-digest')
			const { svc, coord, ghosts } = await buildAt(nodeA, keyB64, 3)
			await seedDialableDecoy(svc, nodeA, nodeB, coord)
			const handler = countingHandler(svc)
			const dials = countDials(nodeA)

			const res = await svc.routeAct(msg(keyB64))

			expect('anchors' in res, 'NearAnchor reply').to.equal(true)
			// Hint quality, not merely hint presence: `pickAnchors` measures against the *key's*
			// coordinate, so an index-3 answerer names the same two key-adjacent peers a key-adjacent
			// answerer would (the ghosts at key±1) — never itself or the farther decoy. Without this
			// the widening could trade a hop for a worse hint and the spec would not notice.
			expect(new Set((res as { anchors: string[] }).anchors), 'the two peers nearest the key')
				.to.deep.equal(new Set([ghosts[0], ghosts[1]]))
			expect(handler.calls(), 'no activity, so no handler call').to.equal(0)
			expect(svc.getDiagnostics().maybeActForwarded, 'answered locally, not forwarded').to.equal(0)
			expect(dials(), 'the reachable decoy hop was never dialed').to.equal(0)
		} finally {
			await stopAll([nodeA, nodeB])
		}
	})

	// The widened window still has an edge. At index 8 of a 7-wide cluster self is genuinely
	// out-of-cluster and must forward; the ghosts are undialable, so the observable outcome is
	// the NearAnchor fallback with the handler untouched.
	it('does not act at cohort index 8 of a want_k 7 cluster', async () => {
		const node = await createMemNode(); await node.start()
		try {
			const keyB64 = base64url('width-index-8')
			const { svc } = await buildAt(node, keyB64, 8)
			const handler = countingHandler(svc)
			const dials = countDials(node)

			const res = await svc.routeAct(msg(keyB64, { activity: base64url('payload') }))

			expect(handler.calls(), 'out of cluster — handler never called').to.equal(0)
			expect('anchors' in res, 'fell through to the NearAnchor fallback').to.equal(true)
			expect(dials(), 'the ghosts are undialable, so nothing was dialed').to.equal(0)
		} finally {
			await stopAll([node])
		}
	})

	// The exact boundary, which index 3 and index 8 straddle without pinning: a `want_k` of 7 makes
	// the window 7, so cohort index 6 is the last one admitted and index 7 the first refused. An
	// off-by-one in the window arithmetic (`<=` for `<`, or dropping the cohort-size cap inside
	// `neighborDistance`) moves exactly this pair and nothing else in the file.
	it('admits cohort index 6 and refuses index 7 for a want_k of 7', async () => {
		const nodeIn = await createMemNode(); await nodeIn.start()
		const nodeOut = await createMemNode(); await nodeOut.start()
		try {
			const keyIn = base64url('width-boundary-in')
			const { svc: svcIn } = await buildAt(nodeIn, keyIn, 6)
			const inHandler = countingHandler(svcIn)
			await svcIn.routeAct(msg(keyIn, { activity: base64url('payload') }))
			expect(inHandler.calls(), 'index 6 is the last index inside a 7-wide window').to.equal(1)

			const keyOut = base64url('width-boundary-out')
			const { svc: svcOut } = await buildAt(nodeOut, keyOut, 7)
			const outHandler = countingHandler(svcOut)
			await svcOut.routeAct(msg(keyOut, { activity: base64url('payload') }))
			expect(outHandler.calls(), 'index 7 is the first index outside it').to.equal(0)
		} finally {
			await stopAll([nodeIn, nodeOut])
		}
	})

	// `wants` is the caller's staged/partial-cohort ask and narrows the window below `want_k`.
	// This is the shape test/route.maybeact.integration.spec.ts sends.
	it('honours a `wants` narrower than `want_k`', async () => {
		const node = await createMemNode(); await node.start()
		try {
			const keyB64 = base64url('width-wants-narrow')
			const { svc } = await buildAt(node, keyB64, 3)
			const handler = countingHandler(svc)

			await svc.routeAct(msg(keyB64, { wants: 2, activity: base64url('payload') }))

			expect(handler.calls(), '`wants: 2` keeps the window at 2, so index 3 is out').to.equal(0)
		} finally {
			await stopAll([node])
		}
	})

	// A malformed sender cannot widen the window past the cluster it asked for.
	it('clamps `wants` down to `want_k`', async () => {
		const node = await createMemNode(); await node.start()
		try {
			const keyB64 = base64url('width-wants-clamped')
			const { svc } = await buildAt(node, keyB64, 5)
			const handler = countingHandler(svc)

			await svc.routeAct(msg(keyB64, { wants: 99, want_k: 3, activity: base64url('payload') }))

			expect(handler.calls(), '`wants` clamped to want_k 3, so index 5 is out').to.equal(0)
		} finally {
			await stopAll([node])
		}
	})

	// The floor of 2. Without it a `want_k` of 0 or 1 leaves nobody in-cluster and the message
	// forwards until TTL runs out, silently losing the activity.
	it('keeps both key-adjacent anchors acting for a degenerate want_k of 1', async () => {
		const node = await createMemNode(); await node.start()
		try {
			const keyB64 = base64url('width-floor-one')
			const { svc } = await buildAt(node, keyB64, 1)
			const handler = countingHandler(svc)

			await svc.routeAct(msg(keyB64, { want_k: 1, activity: base64url('payload') }))

			expect(handler.calls(), 'the floor of 2 admits cohort index 1').to.equal(1)
		} finally {
			await stopAll([node])
		}
	})

	it('keeps both key-adjacent anchors acting for a want_k of 0', async () => {
		const node = await createMemNode(); await node.start()
		try {
			const keyB64 = base64url('width-floor-zero')
			const { svc } = await buildAt(node, keyB64, 1)
			const handler = countingHandler(svc)

			await svc.routeAct(msg(keyB64, { want_k: 0, activity: base64url('payload') }))

			expect(handler.calls(), 'the floor of 2 admits cohort index 1 even at want_k 0').to.equal(1)
		} finally {
			await stopAll([node])
		}
	})

	// `wants` narrows *who acts*, not *how many peers the actor gathers*: minSigs derives from
	// the full k, so the acting cohort stays want_k-wide. All six extra ghosts sit on the
	// successor side, which leaves self as the key's sole predecessor — cohort index 1, inside
	// the floor — while the ring still holds enough members to fill a 7-wide cohort.
	it('assembles a want_k-wide acting cohort even when `wants` narrowed the window', async () => {
		const node = await createMemNode(); await node.start()
		try {
			const svc = new CoreFretService(node, { profile: 'core', k: 7 })
			const keyB64 = base64url('width-cohort-stays-wide')
			const coord = await hashKey(u8FromString(keyB64, 'base64url'))
			for (const delta of [1, 2, 3, 4, 5, 6]) seedMember(svc, await ghostPeerId(), ringOffset(coord, delta))
			seedMember(svc, node.peerId.toString(), await hashPeerId(node.peerId))
			const handler = countingHandler(svc)

			await svc.routeAct(msg(keyB64, { wants: 2, want_k: 7, activity: base64url('payload') }))

			expect(handler.calls(), 'index 1 is inside the floor of 2').to.equal(1)
			expect(handler.cohorts()[0]?.length, 'cohort sized by want_k, not wants').to.equal(7)
		} finally {
			await stopAll([node])
		}
	})

	// A peer that is in-cluster but has no handler installed still returns the NearAnchor refusal
	// (and that refusal is still not cached — the "only a terminal answer is cached" rule is
	// untouched here). Widening means *more* peers reach this arm, so pin it at a non-anchor
	// cohort index, again with a reachable decoy so the refusal is distinguishable from a forward.
	it('returns the NearAnchor refusal in-cluster with no handler installed', async () => {
		const nodeA = await createMemNode(); await nodeA.start()
		const nodeB = await createMemNode(); await nodeB.start()
		try {
			const keyB64 = base64url('width-no-handler')
			const { svc, coord } = await buildAt(nodeA, keyB64, 3)
			await seedDialableDecoy(svc, nodeA, nodeB, coord)
			const dials = countDials(nodeA)

			const res = await svc.routeAct(msg(keyB64, { activity: base64url('payload') }))

			expect('anchors' in res, 'refusal, not a certificate').to.equal(true)
			expect(svc.getDiagnostics().maybeActForwarded, 'in-cluster, so no forward').to.equal(0)
			expect(dials(), 'the reachable decoy hop was never dialed').to.equal(0)
		} finally {
			await stopAll([nodeA, nodeB])
		}
	})

	// A service that never ran start() has no self entry, so `neighborDistance` returns Infinity
	// and the node is out-of-cluster on every key. Widening must not change that.
	it('is out-of-cluster when self is absent from the store', async () => {
		const node = await createMemNode(); await node.start()
		try {
			const svc = new CoreFretService(node, { profile: 'core', k: 7 })
			const keyB64 = base64url('width-self-absent')
			const coord = await hashKey(u8FromString(keyB64, 'base64url'))
			seedMember(svc, await ghostPeerId(), ringOffset(coord, 1))
			const handler = countingHandler(svc)

			await svc.routeAct(msg(keyB64, { activity: base64url('payload') }))

			expect(handler.calls(), 'no self entry — never in-cluster').to.equal(0)
		} finally {
			await stopAll([node])
		}
	})
})
