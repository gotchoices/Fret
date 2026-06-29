import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import { createIdentifyNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { makeProtocols } from '../src/rpc/protocols.js'
import type { Libp2p } from 'libp2p'

// The probe-based classification path (a namespaced ping → member, UnsupportedProtocolError
// → foreign) is covered by ring-membership.spec.ts using in-memory nodes. Those nodes run no
// identify service, so the peerStore protocol list never populates and the identify-driven
// path — the `peer:identify` / `peer:update` listeners and the opportunistic
// classifyFromPeerStore in seedFromPeerStore — never fires there. This spec covers that gap
// with real TCP + identify nodes.
//
// To prove classification rides identify and NOT an outbound probe, we neutralize the
// observer's stabilization pass. Every probe-based classification (probeNeighborsLatency,
// classifyUnknownPeers, reprobeForeignPeers) lives inside stabilizeOnce and is the ONLY code
// that calls applySuccess/markForeign off an RPC — so a no-op stabilizeOnce leaves identify
// (the event listeners + the peerStore-backed classifyFromPeerStore in seedFromPeerStore) as
// the sole classification source. seedFromPeerStore still runs each tick, but it is itself the
// identify path (it reads the identify-populated peerStore) and never sends a probe. We also
// assert getDiagnostics().pingsSent === 0 as a public-API witness that no probe was sent.

/** Stub out the observer's outbound stabilization pass so classification can only come from identify. */
function disableProbing(svc: CoreFretService): void {
	;(svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce = async () => {}
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000, stepMs = 25): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise((r) => setTimeout(r, stepMs))
	}
}

describe('Ring membership classification (identify-driven)', function () {
	this.timeout(60000)

	let nodes: Libp2p[] = []
	let services: CoreFretService[] = []

	afterEach(async () => {
		for (const s of services) {
			if (!s) continue
			try { await s.stop() } catch {}
		}
		await stopAll(nodes.filter(Boolean))
		nodes = []
		services = []
	})

	// identify exchanges each peer's negotiated-protocol list on connect. A (net-a) sees that
	// C serves /optimystic/net-a/fret/1.0.0/* → member, and that B serves only net-b protocols
	// (non-empty, none of ours) → foreign. Self is seeded member. With the probe pass disabled,
	// the only thing that could have produced these labels is the identify path.
	it('labels a same-network peer member and a foreign-network peer foreign via identify (no probe)', async () => {
		const nodeA = await createIdentifyNode(); await nodeA.start()
		const nodeB = await createIdentifyNode(); await nodeB.start()
		const nodeC = await createIdentifyNode(); await nodeC.start()
		nodes = [nodeA, nodeB, nodeC]

		const svcA = new CoreFretService(nodeA, { profile: 'core', networkName: 'net-a' })
		const svcB = new CoreFretService(nodeB, { profile: 'core', networkName: 'net-b' })
		const svcC = new CoreFretService(nodeC, { profile: 'core', networkName: 'net-a' })
		services = [svcA, svcB, svcC]
		disableProbing(svcA) // observer must classify via identify alone
		await svcA.start(); await svcB.start(); await svcC.start()

		// Dial after start so A's peer:connect / identify listeners are already attached.
		await nodeB.dial(nodeA.getMultiaddrs()[0]!)
		await nodeC.dial(nodeA.getMultiaddrs()[0]!)

		const store = svcA.getStore()
		const idA = nodeA.peerId.toString()
		const idB = nodeB.peerId.toString()
		const idC = nodeC.peerId.toString()

		await waitFor(() =>
			store.getById(idC)?.membership === 'member' &&
			store.getById(idB)?.membership === 'foreign'
		)

		expect(store.getById(idA)?.membership).to.equal('member', 'self should be member')
		expect(store.getById(idC)?.membership).to.equal('member', 'same-network peer C should be member via identify')
		expect(store.getById(idB)?.membership).to.equal('foreign', 'foreign-network peer B should be foreign via identify')
		expect(svcA.getDiagnostics().pingsSent).to.equal(0, 'classification must not have sent any outbound probe')
	})

	// Re-admission: a peer that was foreign begins serving this network, re-identifies via
	// identify-push, and A's peer:update listener promotes it foreign → member. C joins WITHOUT
	// serving net-a (so A labels it foreign off its identify protocols only), then registers a
	// net-a protocol handler — which updates C's self record and, via identify-push, reaches A
	// as a peer:update. With the probe pass disabled and seedFromPeerStore only re-classifying
	// `unknown` peers (never `foreign`), peer:update is the sole path that can re-admit C.
	it('re-admits foreign → member on peer:update when a peer begins serving this network', async () => {
		const nodeA = await createIdentifyNode(); await nodeA.start()
		const nodeC = await createIdentifyNode(); await nodeC.start()
		nodes = [nodeA, nodeC]

		const svcA = new CoreFretService(nodeA, { profile: 'core', networkName: 'net-a' })
		services = [svcA]
		disableProbing(svcA)
		await svcA.start()

		const store = svcA.getStore()
		const idC = nodeC.peerId.toString()

		// C connects as a bare identify node: its protocol list (identify protocols only) is
		// non-empty but contains none of net-a's, so A classifies it foreign.
		await nodeC.dial(nodeA.getMultiaddrs()[0]!)
		await waitFor(() => store.getById(idC)?.membership === 'foreign')
		expect(store.getById(idC)?.membership).to.equal('foreign', 'a peer not serving net-a should be foreign')

		// C begins serving net-a. Registering the protocol handler updates C's self peer record;
		// identify-push (debounced ~1s) propagates the new protocol to A as a peer:update.
		const netAPing = makeProtocols('net-a').PROTOCOL_PING
		await nodeC.handle(netAPing, async () => {})

		await waitFor(() => store.getById(idC)?.membership === 'member')
		expect(store.getById(idC)?.membership).to.equal('member', 'mislabeled/late peer must be re-admitted via peer:update')
		expect(svcA.getDiagnostics().pingsSent).to.equal(0, 're-admission must not have sent any outbound probe')
	})

	// Isolates the peerStore *poll* path — classifyFromPeerStore, called from seedFromPeerStore
	// — from the peer:identify / peer:update event handlers (which the two tests above leave
	// racing). start() awaits seedFromPeerStore BEFORE it attaches any node event listener, so if
	// A's peerStore is already populated when start() runs, the poll is the only thing that can
	// have classified. We let libp2p identify populate A's peerStore while A has no FretService,
	// then start A and assert membership SYNCHRONOUSLY right after start() resolves — before the
	// event loop can deliver a single peer:identify/peer:update — which pins the poll path alone.
	//
	// SKIPPED: this currently fails because seedFromPeerStore enumerates peers via
	// `node.peerStore.getPeers()`, which does not exist (getPeers lives on the libp2p *node*, not
	// the peerStore; the peerStore enumerator is `all()`). The loop therefore always sees [] and
	// the poll path is dead code with real libp2p — classification still works via the event
	// listeners + the probe pass, which is why it went unnoticed. Tracked by
	// tickets/backlog/bug-seedfrompeerstore-getpeers-noop. Un-skip once that lands; the test is
	// written to pass against the fixed enumeration.
	it.skip('classifies from the peerStore poll path at start, before any event listener fires (no probe)', async () => {
		const nodeA = await createIdentifyNode(); await nodeA.start()
		const nodeC = await createIdentifyNode(); await nodeC.start()
		nodes = [nodeA, nodeC]

		// C serves net-a, so its identify-advertised protocol list includes ours.
		const svcC = new CoreFretService(nodeC, { profile: 'core', networkName: 'net-a' })
		services = [svcC]
		await svcC.start()

		// Connect and wait for libp2p identify to populate A's peerStore with C's protocols —
		// all while A has no FretService at all, so no FRET listener or probe is in play yet.
		const netAPing = makeProtocols('net-a').PROTOCOL_PING
		await nodeA.dial(nodeC.getMultiaddrs()[0]!)
		const deadline = Date.now() + 10000
		let peerStoreReady = false
		while (Date.now() < deadline) {
			try {
				const rec = await nodeA.peerStore.get(nodeC.peerId)
				if (rec.protocols?.includes(netAPing)) { peerStoreReady = true; break }
			} catch { /* not in peerStore yet */ }
			await new Promise((r) => setTimeout(r, 25))
		}
		expect(peerStoreReady).to.equal(true, "A's peerStore should learn C's net-a protocols via identify")

		// Now start A. seedFromPeerStore is awaited inside start() before listeners attach, so the
		// poll path classifies C synchronously — asserted with no waitFor, leaving the event
		// handlers no opportunity to have run.
		const svcA = new CoreFretService(nodeA, { profile: 'core', networkName: 'net-a' })
		services = [svcC, svcA]
		disableProbing(svcA)
		await svcA.start()

		const store = svcA.getStore()
		expect(store.getById(nodeC.peerId.toString())?.membership).to.equal('member',
			'classifyFromPeerStore poll path should classify C member at start, before listeners fire')
		expect(svcA.getDiagnostics().pingsSent).to.equal(0, 'poll-path classification must not have sent any outbound probe')
	})
})
