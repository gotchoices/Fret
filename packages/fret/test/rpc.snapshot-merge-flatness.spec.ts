import { afterEach, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { NETWORK, peerIdStr } from './helpers/rpc-fuzz.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { makeSnapshotParser } from '../src/rpc/validate.js'
import type { NeighborSnapshotV1 } from '../src/index.js'

// Frequency credit counts proven contact, not hearsay: an id has the same stored score after a
// thousand mentions as after one. `noteDiscovered` makes that trivially true at the unit level
// (it returns early for an id already held), so the claim is worth nothing unless it is asserted
// on the **wired** path — the parser + merge pair an inbound announce actually drives.
//
// Hosted in its own file rather than in `rpc.snapshot-merge-cap.spec.ts`, whose subject is a
// *bound on accepted work*; this is a bound on what repetition can buy. The rig is that file's,
// deliberately: an unstarted service driven through `mergeAnnounceSnapshot` directly, so no
// stabilization tick scores underneath the assertions and the merge's detached tail is quiet
// (`announceToNewPeers` filters by `hasAddresses`, empty on an unstarted service, so it dials
// nothing; `enforceCapacity` early-returns far below the 2048 capacity).
//
// Profile is irrelevant here — the caps bound list *length*, and every list below is one id — so
// this runs on core alone rather than restating the profile loop next door.

describe('announce merge: repeated mentions buy a named peer nothing', function () {
	this.timeout(30000)

	interface DrivableMerge {
		mergeAnnounceSnapshot(from: string, snap: NeighborSnapshotV1): Promise<void>
		mergeSnapshotCaps(): { successors: number; predecessors: number; sample: number }
	}

	/** The announcing peer, and the peer it names. Seeds free of every fixture range next door. */
	const FROM = peerIdStr(190)
	const NAMED = peerIdStr(191)

	const MERGES = 500

	let node: Libp2p
	let svc: CoreFretService

	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
		svc = new CoreFretService(node, { profile: 'core', networkName: NETWORK })
	})

	afterEach(async () => { await stopAll([node]) })

	/**
	 * One announce body, run through the *same* parser the service wires in at registration, so
	 * this drives the production pair rather than the merge alone.
	 *
	 * The timestamp is minted per call because `mergeAnnounceSnapshot` opens with a ±30s
	 * freshness check — a body minted once and re-merged 500 times would still pass today, but
	 * only by accident of how fast the loop runs.
	 */
	function announce(): NeighborSnapshotV1 {
		const caps = (svc as unknown as DrivableMerge).mergeSnapshotCaps()
		const out = makeSnapshotParser(caps)({
			v: 1, from: FROM, timestamp: Date.now(), sig: '',
			successors: [NAMED], predecessors: [], sample: [],
		})
		expect(out, 'the fixture parses').to.not.equal(undefined)
		return out!
	}

	const merge = (snap: NeighborSnapshotV1): Promise<void> =>
		(svc as unknown as DrivableMerge).mergeAnnounceSnapshot(FROM, snap)

	/** The three fields a mention would move if hearsay accrued credit. */
	function creditOf(id: string): { relevance: number; accessCount: number; lastAccess: number } {
		const e = svc.getStore().getById(id)
		expect(e, `${id} is in the store`).to.not.equal(undefined)
		return { relevance: e!.relevance, accessCount: e!.accessCount, lastAccess: e!.lastAccess }
	}

	it(`leaves a named peer's relevance, accessCount and lastAccess untouched across ${MERGES} merges`, async () => {
		await merge(announce())
		const first = creditOf(NAMED)

		// A score was written *once*, at creation, from empty counters — the hearsay baseline.
		// Without it the entry would sit at relevance 0 and be the preferred eviction victim on a
		// full table, so "flat" must not be read as "unscored".
		expect(first.relevance, 'scored once at creation, not left at zero').to.be.greaterThan(0)
		expect(first.accessCount, 'being named is not a contact').to.equal(0)

		for (let i = 1; i < MERGES; i++) await merge(announce())

		expect(creditOf(NAMED), `${MERGES} mentions score exactly as one does`).to.deep.equal(first)
	})

	it('still credits the announcing peer, which contacted us', async () => {
		// The contrast that makes the case above mean something: the merge is not a no-op. The
		// *sender* is on the other side of the same rule — it dialed our namespaced announce
		// protocol, so `applyTouch` gives it frequency credit on every message. A flatness test
		// that read `FROM`'s entry instead of the named peer's would be asserting the opposite of
		// the rule and would fail.
		await merge(announce())
		const first = creditOf(FROM)
		expect(first.accessCount, 'one completed inbound RPC').to.equal(1)

		for (let i = 1; i < MERGES; i++) await merge(announce())

		const last = creditOf(FROM)
		expect(last.accessCount, 'one per message, not one per lifetime').to.equal(MERGES)
		expect(last.accessCount).to.be.greaterThan(first.accessCount)
	})
})
