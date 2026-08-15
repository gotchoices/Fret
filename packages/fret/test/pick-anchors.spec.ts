import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import { createMemoryNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import type { DigitreeStore } from '../src/store/digitree-store.js'
import type { BusyResponseV1, NearAnchorV1, RouteAndMaybeActV1 } from '../src/index.js'
import { hashKey } from '../src/ring/hash.js'
import type { Libp2p } from 'libp2p'
import { fromString as u8FromString } from 'uint8arrays/from-string'
import { toString as u8ToString } from 'uint8arrays/to-string'

/**
 * Regression coverage for a bug where anchor selection measured distance from the all-zero
 * ring coordinate instead of from the key's own coordinate, biasing anchors toward peers with
 * numerically small coordinates rather than the peers actually nearest the key.
 *
 * `pickAnchors` and its two callers are private, so the tests name the private surface below
 * rather than casting to `any` — a signature change then breaks the test at compile time
 * instead of silently at runtime.
 */
interface AnchorInternals {
	store: DigitreeStore
	pickAnchors(candidates: string[], targetCoord: Uint8Array): string[]
	handleMaybeAct(msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }>
	routeAct(msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | { commitCertificate: string }>
}

const internals = (svc: CoreFretService): AnchorInternals => svc as unknown as AnchorInternals

async function makeService(): Promise<{ node: Libp2p; svc: CoreFretService; priv: AnchorInternals }> {
	const node = await createMemoryNode()
	await node.start()
	const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
	return { node, svc, priv: internals(svc) }
}

/** Seed a member peer at `coord`; membership matters for the ring-walk callers. */
function seedMember(priv: AnchorInternals, id: string, coord: Uint8Array): void {
	priv.store.upsert(id, coord)
	priv.store.setMembership(id, 'member')
}

/** A coordinate one bit away from `coord` — the closest distinct peer a key can have. */
function oneBitFrom(coord: Uint8Array, byte = 31): Uint8Array {
	const out = Uint8Array.from(coord)
	out[byte]! ^= 0x01
	return out
}

/** A coordinate a few ticks off the all-zero vector the bug measured against. */
function nearZero(value: number): Uint8Array {
	const out = new Uint8Array(32)
	out[31] = value
	return out
}

let correlationCounter = 0

function baseMsg(keyBytes: Uint8Array, overrides: Partial<RouteAndMaybeActV1> = {}): RouteAndMaybeActV1 {
	return {
		v: 1,
		key: u8ToString(keyBytes, 'base64url'),
		want_k: 7,
		ttl: 3,
		min_sigs: 3,
		breadcrumbs: [],
		correlation_id: `pick-anchors-${++correlationCounter}`,
		timestamp: Date.now(),
		signature: '',
		...overrides
	}
}

describe('pickAnchors measures distance from the target coordinate', function () {
	this.timeout(10000)

	let node: Libp2p
	let priv: AnchorInternals

	before(async () => { ({ node, priv } = await makeService()) })
	after(async () => { await stopAll([node]) })

	it('picks the peer closest to the key over one closest to coordinate zero', async () => {
		const keyCoord = await hashKey(u8FromString('pick-anchors-regression', 'utf8'))

		// Numerically tiny coordinate: closest possible peer to the all-zero vector the bug used.
		priv.store.upsert('near-zero', nearZero(1))
		// Genuinely closest peer to the key: one bit flipped from the key's own coordinate.
		priv.store.upsert('true-nearest', oneBitFrom(keyCoord))
		// Decoys, far from both the key and zero.
		priv.store.upsert('decoy-a', new Uint8Array(32).fill(0x77))
		priv.store.upsert('decoy-b', new Uint8Array(32).fill(0x99))

		const anchors = priv.pickAnchors(['near-zero', 'true-nearest', 'decoy-a', 'decoy-b'], keyCoord)

		expect(anchors[0], `anchors: ${anchors.join(', ')}`).to.equal('true-nearest')
		expect(anchors, 'two anchors when candidates allow').to.have.lengthOf(2)
	})

	it('returns no anchors for an empty candidate list', () => {
		expect(priv.pickAnchors([], new Uint8Array(32))).to.deep.equal([])
	})

	it('returns a single anchor when only one candidate exists', async () => {
		const keyCoord = await hashKey(u8FromString('pick-anchors-single', 'utf8'))
		priv.store.upsert('solo', oneBitFrom(keyCoord))

		expect(priv.pickAnchors(['solo', 'solo'], keyCoord)).to.deep.equal(['solo'])
	})

	it('skips candidate ids the store has never seen', async () => {
		const keyCoord = await hashKey(u8FromString('pick-anchors-ghost', 'utf8'))
		priv.store.upsert('known-peer', oneBitFrom(keyCoord))

		// A remote hint can name a peer we hold no coordinate for; it cannot be measured, so it
		// must be dropped rather than returned as an anchor an id-only comparison would keep.
		expect(priv.pickAnchors(['ghost-peer', 'known-peer'], keyCoord)).to.deep.equal(['known-peer'])
	})

	// NOTE: no equidistant-candidates test — XOR distance to a fixed target is injective, so two
	// peers with distinct coordinates can never tie. `betterByDist`'s lexicographic id tie-break
	// in selector/next-hop.ts is unreachable from here; it is exercised by the selector's own spec.
})

describe('NearAnchor replies anchor on the key coordinate', function () {
	this.timeout(10000)

	/** Seeds a ring where the zero-coordinate bug and a correct implementation disagree. */
	async function seedRing(keyCoord: Uint8Array): Promise<{ node: Libp2p; svc: CoreFretService }> {
		const { node, svc, priv } = await makeService()
		// Two peers with numerically tiny coordinates — under the zero-coordinate bug these fill
		// both anchor slots and crowd out the peer actually nearest the key.
		seedMember(priv, 'near-zero', nearZero(2))
		seedMember(priv, 'near-zero-2', nearZero(4))
		seedMember(priv, 'true-nearest', oneBitFrom(keyCoord, 0))
		return { node, svc }
	}

	it('routeAct anchors on the key\'s nearest peer', async () => {
		const keyBytes = u8FromString('pick-anchors-regression-e2e', 'utf8')
		const { node, svc } = await seedRing(await hashKey(keyBytes))
		try {
			// This service was never started, so self is absent from the ring and the in-cluster
			// test fails; `ttl: 0` then blocks the forward, landing on `buildNearAnchor`'s
			// fallback arm — the same call site the in-cluster no-activity reply uses.
			const res = await svc.routeAct(baseMsg(keyBytes, { ttl: 0, wants: 2 }))

			expect(res, 'expected a NearAnchor reply').to.have.property('anchors')
			expect((res as NearAnchorV1).anchors[0]).to.equal('true-nearest')
		} finally {
			await stopAll([node])
		}
	})

	it('the breadcrumb-loop reply is a static rejection, not a ring walk', async () => {
		const keyBytes = u8FromString('pick-anchors-loop', 'utf8')
		const { node, svc } = await seedRing(await hashKey(keyBytes))
		try {
			// Self in the breadcrumb trail is a routing loop. This must answer without doing any
			// ring/next-hop work — see fret-service.ts `staticReject` — so it carries no anchors,
			// unlike the sibling call site (`nearAnchorOnly`) covered below.
			const msg = baseMsg(keyBytes, { breadcrumbs: [node.peerId.toString()] })
			const res = await internals(svc).handleMaybeAct(msg)

			expect(res, 'expected a NearAnchor-shaped reply').to.have.property('anchors')
			expect((res as NearAnchorV1).anchors).to.deep.equal([])
			expect((res as NearAnchorV1).cohort_hint).to.deep.equal([])
		} finally {
			await stopAll([node])
		}
	})

	it('the routeAct-threw fallback (nearAnchorOnly) anchors on the key\'s nearest peer', async () => {
		const keyBytes = u8FromString('pick-anchors-fallback', 'utf8')
		const { node, svc } = await seedRing(await hashKey(keyBytes))
		try {
			// Force the routing attempt itself to fail so handleMaybeAct falls through to its
			// catch arm, the only remaining caller of `nearAnchorOnly` — otherwise unreached by
			// the tests above now that the cheap validity guards use a static rejection.
			const priv = internals(svc)
			priv.routeAct = async () => { throw new Error('forced failure for nearAnchorOnly coverage') }

			const msg = baseMsg(keyBytes)
			const res = await priv.handleMaybeAct(msg)

			expect(res, 'expected a NearAnchor reply').to.have.property('anchors')
			expect((res as NearAnchorV1).anchors[0]).to.equal('true-nearest')
		} finally {
			await stopAll([node])
		}
	})
})
