import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import type { PeerId } from '@libp2p/interface'
import type { Libp2p } from 'libp2p'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { buildMaintenanceRig, type MaintenanceRig } from './helpers/maintenance-rig.js'
import { FretService } from '../src/service/fret-service.js'
import { hashPeerId, coordToBase64url, COORD_BYTES } from '../src/ring/hash.js'
import type { NeighborSnapshotV1 } from '../src/index.js'

// Three per-tick costs the background maintenance loop used to pay every tick, and the behaviour
// each removal must preserve:
//
// (a) `seedFromPeerStore` re-hashed every peerStore entry's ring coordinate per tick. It now
//     reuses the coordinate already in the routing table and hashes only on a miss.
// (b) Five sites re-hashed this node's *own* peer id instead of reading the cached `selfCoord()`.
//     The one that is easy to get wrong is `mergeAnnounceSnapshot`, which deals with the
//     *announcing* peer's coordinate — its locals were renamed `sender` / `senderCoord` precisely
//     so the next reader cannot substitute ours.
// (c) Capacity was enforced after every seed. It is now enforced once per tick (end of
//     `stabilizeOnce` phase 1), plus one explicit call in `start()` so the bound does not depend
//     on a timer being armed.
//
// A "maintenance cycle" is not `stabilizeOnce` alone: the loop tick body is
// `seedFromPeerStore()` -> `seedFromBootstraps()` -> `stabilizeOnce()`, and only the first of
// those seeds. `cycle()` below is that body, driven directly so no timer races the assertions.

/** A real Ed25519 peer id — the senders parse ids before anything else, so stubs will not do. */
async function newPeerId(): Promise<PeerId> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
}

/**
 * Put `pid` in the **libp2p** peerStore. `seedFromPeerStore` enumerates `peerStore.all()`, so a
 * peer written only to the FRET store (what `buildMaintenanceRig`'s `seedPeers` does) is invisible
 * to it. An address is supplied because the seed records address-known off `p.addresses.length`.
 */
async function seedPeerStore(node: Libp2p, pid: PeerId): Promise<void> {
	await node.peerStore.merge(pid, { multiaddrs: [multiaddr('/ip4/127.0.0.1/tcp/1')] })
}

/** One loop tick body: seed from the peerStore, seed bootstraps, then stabilize. */
async function cycle(svc: FretService): Promise<void> {
	await (svc as any).seedFromPeerStore()
	await (svc as any).seedFromBootstraps()
	await (svc as any).stabilizeOnce()
}

function coordOf(svc: FretService, id: string): string | undefined {
	const entry = svc.getStore().getById(id)
	return entry == null ? undefined : coordToBase64url(entry.coord)
}

describe('per-tick hot path', function () {
	this.timeout(20_000)

	// Peers seeded through the peerStore land `unknown`, so a tick's phase 2 tries to classify them
	// with real dials against an address nothing is listening on. A short tick budget cuts those
	// off deterministically; without it a cycle costs several seconds of dial timeouts.
	const originalTickBudget = (FretService as any).STABILIZE_TICK_BUDGET_MS as number
	beforeEach(() => { (FretService as any).STABILIZE_TICK_BUDGET_MS = 50 })
	afterEach(() => { (FretService as any).STABILIZE_TICK_BUDGET_MS = originalTickBudget })

	// ----- (a) coordinate reuse -----

	describe('coordinate reuse in seedFromPeerStore', () => {
		it('does not re-hash a peer already in the routing table', async () => {
			// The property, stated without counting hash calls: whatever coordinate the routing
			// table holds for a peer is what survives a cycle. Writing a coordinate that is
			// deliberately *not* SHA-256(id) is the only way to tell reuse from a re-hash, since a
			// re-hash reproduces the same 32 bytes for every honest entry.
			//
			// This is also the deliberate behaviour change the reuse introduced. The unconditional
			// re-hash used to silently *repair* a wrong coordinate for any peer libp2p's peerStore
			// also knew about. That accidental repair is gone; the only way a wrong coordinate
			// enters the table is `importTable`, which trusts the persisted snapshot's `coord`
			// field, so the import-side check is now the only defense. Recorded as an arm on
			// `tickets/backlog/plan/2-routing-table-export-integrity` — a future reader meeting
			// this assertion is meeting a decision, not a bug.
			const node = await createMemNode()
			await node.start()
			const svc = new FretService(node, { profile: 'core', k: 7 })
			try {
				const pid = await newPeerId()
				const id = pid.toString()
				await seedPeerStore(node, pid)

				const tampered = new Uint8Array(COORD_BYTES).fill(0x5a)
				const truth = await hashPeerId(pid)
				expect(coordToBase64url(tampered), 'tampered coord must differ from the true hash')
					.to.not.equal(coordToBase64url(truth))
				svc.getStore().upsert(id, tampered)

				await cycle(svc)

				expect(coordOf(svc, id), 'a stored coordinate is reused, not re-derived')
					.to.equal(coordToBase64url(tampered))
			} finally {
				await stopAll([node])
			}
		})

		it('still hashes a peer the routing table has never seen', async () => {
			// The miss path — and what makes the reuse above safe. A peer entering through the
			// libp2p peerStore for the first time must land at SHA-256(its id), because every ring
			// read (neighbors, cohorts, anchors) assumes ring position is derived, not chosen.
			const node = await createMemNode()
			await node.start()
			const svc = new FretService(node, { profile: 'core', k: 7 })
			try {
				const pid = await newPeerId()
				const id = pid.toString()
				await seedPeerStore(node, pid)
				expect(svc.getStore().getById(id), 'must be a genuine miss').to.equal(undefined)

				await cycle(svc)

				expect(coordOf(svc, id)).to.equal(coordToBase64url(await hashPeerId(pid)))
			} finally {
				await stopAll([node])
			}
		})
	})

	// ----- (b) the sender/self rename -----

	describe('announce merge stores the announcer at its own coordinate', () => {
		it('uses the announcing peer ring coordinate, not this node own', async () => {
			// `mergeAnnounceSnapshot`'s locals were named `self` / `selfCoord` while holding the
			// *sender's* id and coordinate. Renaming them `sender` / `senderCoord` was the point of
			// change (b): substituting the cached `selfCoord()` there would upsert every announcing
			// peer at our own ring position, collapsing the ring onto one coordinate.
			const node = await createMemNode()
			await node.start()
			const svc = new FretService(node, { profile: 'core', k: 7 })
			try {
				const from = (await newPeerId()).toString()
				const snap: NeighborSnapshotV1 = {
					v: 1, from, timestamp: Date.now(),
					successors: [], predecessors: [], sample: [], sig: '',
				}

				await (svc as any).mergeAnnounceSnapshot(from, snap)

				const expected = coordToBase64url(await hashPeerId(peerIdFromString(from)))
				const ours = coordToBase64url(await hashPeerId(node.peerId))
				expect(expected, 'sanity: the two coordinates must differ').to.not.equal(ours)
				expect(coordOf(svc, from), 'announcer stored at its own coordinate').to.equal(expected)
				expect(coordOf(svc, from), 'and never at ours').to.not.equal(ours)
			} finally {
				await stopAll([node])
			}
		})
	})

	// ----- (c) capacity enforced once per tick -----

	describe('capacity enforcement', () => {
		// `enforceCapacity` protects self plus up to `max(2, m) - 1` live members per side, and
		// protection outranks the cap — so a capacity below `2m - 1` leaves the table legitimately
		// over cap (already pinned by `test/relevance.eviction.spec.ts`, not re-pinned here). With
		// k = 7, m = ceil(k/2) = 4, so the protected set is at most 7 ids and a capacity of 20
		// binds for real.
		const K = 7
		const CAPACITY = 20
		const SEEDED = 40

		it('one maintenance cycle trims a table seeded over capacity', async () => {
			// The seeds no longer trim for themselves; `stabilizeOnce` phase 1 owns the tick's one
			// enforcement, and it sits after the seeds so it sees every insert the tick made.
			const node = await createMemNode()
			await node.start()
			const svc = new FretService(node, { profile: 'core', k: K, capacity: CAPACITY })
			try {
				for (let i = 0; i < SEEDED; i++) await seedPeerStore(node, await newPeerId())

				await cycle(svc)

				expect(svc.getStore().size(), 'table trimmed to capacity by the cycle')
					.to.be.at.most(CAPACITY)
			} finally {
				await stopAll([node])
			}
		})

		it('start() trims without waiting for a maintenance cycle to fire', async () => {
			// This is the case `start()`'s explicit `enforceCapacity()` exists for: the bound must
			// not depend on a timer being armed. The stabilization loop is disarmed so the only
			// enforcement that can run is `start()`'s own — otherwise a passing assertion would not
			// distinguish the two.
			const node = await createMemNode()
			await node.start()
			const svc = new FretService(node, { profile: 'core', k: K, capacity: CAPACITY })
			;(svc as any).startStabilizationLoop = (): void => {}
			try {
				for (let i = 0; i < SEEDED; i++) await seedPeerStore(node, await newPeerId())

				await svc.start()

				expect(svc.getStore().size(), 'start() enforced capacity itself')
					.to.be.at.most(CAPACITY)
			} finally {
				try { await svc.stop() } catch { /* teardown is best-effort */ }
				await stopAll([node])
			}
		})

		it('a tick cut short by its budget still enforces capacity', async () => {
			// `enforceCapacity` sits *above* the `budget.signal.aborted` early return, so a tick
			// truncated in phase 1 still trims. Four near peers that never answer burn the budget;
			// the over-capacity population is unclassified peers, which only phase 2 would touch —
			// so "no unknown peer was probed" is the evidence the tick really was cut short.
			let harness: MaintenanceRig | undefined
			try {
				harness = await buildMaintenanceRig('core', { k: K, capacity: CAPACITY })
				const { svc, store, rig } = harness
				harness.setTickBudget(50)

				const near = await harness.seedPeers(4, 'member')
				for (const id of near) rig.behavior.set(id, 'hangs')
				const unknowns = await harness.seedPeers(SEEDED, 'unknown')
				expect(store.size(), 'sanity: seeded over capacity').to.be.greaterThan(CAPACITY)

				await (svc as any).stabilizeOnce()

				expect(store.size(), 'a truncated tick still trims').to.be.at.most(CAPACITY)
				const probed = unknowns.filter((id) => rig.protocolsSeenBy(id).length > 0)
				expect(probed, 'phase 2 must not have run — otherwise the tick was not truncated')
					.to.deep.equal([])
			} finally {
				if (harness != null) await harness.teardown()
			}
		})

		it('an untruncated tick does probe unknown peers', async () => {
			// Non-vacuity for the assertion above. "No unknown peer was probed" is evidence that
			// the tick was cut short only if a tick that is *not* cut short probes one — otherwise
			// the same assertion would hold against a rig that never dials at all, and the
			// truncation claim would rest on nothing. Same seeding, two differences: the near peers
			// answer rather than hang, so phase 1 drains, and the budget is generous, so the
			// `budget.signal.aborted` early return above phase 2 is not taken.
			//
			// Capacity is left at its default here on purpose. This test is about phase 2 running,
			// and a binding capacity would evict most of the unknown population in phase 1's
			// enforcement before `classifyTargets` ever walked the store — making the assertion
			// depend on which peers survived eviction rather than on whether phase 2 ran.
			let harness: MaintenanceRig | undefined
			try {
				harness = await buildMaintenanceRig('core', { k: K })
				const { svc, rig } = harness
				harness.setTickBudget(5_000)

				await harness.seedPeers(4, 'member')
				const unknowns = await harness.seedPeers(SEEDED, 'unknown')

				await (svc as any).stabilizeOnce()

				const probed = unknowns.filter((id) => rig.protocolsSeenBy(id).length > 0)
				expect(probed, 'phase 2 ran, so the truncated-tick assertion is not vacuous')
					.to.not.be.empty
			} finally {
				if (harness != null) await harness.teardown()
			}
		})
	})
})
