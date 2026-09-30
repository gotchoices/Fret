import { after, before, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { PeerId } from '@libp2p/interface'
import { assertLimited, createRelayHub, isReservedCircuitOn, type RelayHub } from './helpers/relay.js'
import { stopAll } from './helpers/libp2p.js'
import { waitFor } from './helpers/wait-for.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'

// The reproduction of gotchoices/Optimystic#11.
//
// Two peers behind NAT — here, two nodes that listen on `/p2p-circuit` only — each connect to
// one relay and obtain a reservation. They never connect to each other. Through FRET each learns
// the other's *id* from the relay's neighbour snapshot, but nobody tells it the other's
// `/p2p/<relay>/p2p-circuit` address: identify only runs over a direct connection, and FRET's wire
// format used to carry ids alone. So every sibling-initiated dial failed with
// `NoValidAddressesError`, and the relay was the only node that could reach either of them.
//
// With address hints, each node seals a signed record of its own reserved circuit address into
// its snapshots, the relay verifies it, keeps it on that peer's routing-table entry, and forwards
// it in *its* snapshots; the sibling verifies it again and hands it to libp2p's peerStore. After
// that a bare-id dial resolves to the circuit address and lands a (limited) relayed connection.
//
// **The negative control runs first and is what makes the positive case mean anything.** FRET is
// not started on any node until the control has shown that the dial fails without it — a rig where
// the dial already worked would be green for a reason that has nothing to do with hints. The
// positive case then waits on the *peerStore* holding the reserved circuit address (not on any
// FRET-side flag), and then performs the dial that used to fail.
//
// Mutation results (run by hand — a mutation nobody ran proves nothing):
//   - returning early from `ingestAddressHints` reddens the positive case: the wait on the
//     peerStore times out, with the negative control still green;
//   - making `buildAddressHints` skip self (so nodes forward only records they mirrored from
//     identify) also reddens it — the relay's identify-stored records for A and B predate their
//     reservations, so nothing carrying the reserved address ever reaches the sibling. That is
//     what pins the self-sealed record, and its reseal after the reservation, as the load-bearing
//     path here rather than identify.
//
// No identify-push on these nodes, deliberately: with it, a node registering FRET's handlers
// would push a fresh identify record (post-reservation) to the relay, and the relay could forward
// *that* — a legitimate path, but one that would let the self-sealing mutation above stay green.

const NETWORK = 'address-hints-relay'

describe('address hints over a relay (Optimystic#11)', function () {
	// Three TCP nodes, two reservations, then several stabilization ticks of a real exchange.
	this.timeout(120_000)

	let hub: RelayHub
	const services: CoreFretService[] = []

	before(async () => {
		hub = await createRelayHub()
	})

	after(async () => {
		// Services before nodes: `stop()` sends leave notices over the connections the nodes own.
		for (const svc of [...services].reverse()) {
			try { await svc.stop() } catch (err) { console.error('[test cleanup] service stop failed:', err) }
		}
		if (hub) await stopAll(hub.all)
	})

	/** The error a bare-id dial rejects with, or `undefined` when it succeeded. */
	async function dialError(from: Libp2p, to: PeerId): Promise<Error | undefined> {
		try { await from.dial(to); return undefined } catch (err) { return err as Error }
	}

	/** Does `node`'s peerStore hold an address for `peer` that routes through the hub's relay? */
	async function holdsReservedAddressFor(node: Libp2p, peer: PeerId): Promise<boolean> {
		try {
			const stored = await node.peerStore.get(peer)
			return stored.addresses.some((a) => isReservedCircuitOn(hub.relay, a.multiaddr.toString()))
		} catch (err) {
			if ((err as { name?: string }).name === 'NotFoundError') return false
			throw err
		}
	}

	it('negative control: before the exchange, neither relay-only peer can dial the other by id', async () => {
		expect(hub.a.getConnections(hub.b.peerId), 'A and B start unconnected').to.have.lengthOf(0)
		const aToB = await dialError(hub.a, hub.b.peerId)
		expect(aToB?.name, 'A has no address for B').to.equal('NoValidAddressesError')
		const bToA = await dialError(hub.b, hub.a.peerId)
		expect(bToA?.name, 'B has no address for A').to.equal('NoValidAddressesError')
	})

	it('after the exchange, each dials the other by id and lands a relayed connection', async () => {
		for (const node of [hub.relay, hub.a, hub.b]) {
			const privateKey = hub.keys.get(node.peerId.toString())
			const svc = new CoreFretService(node, { networkName: NETWORK, profile: 'core', privateKey })
			services.push(svc)
			await svc.start()
		}

		// The claim is about libp2p's peerStore, which is what a bare-id dial reads — so wait on
		// exactly that, in both directions, before dialing.
		await waitFor(() => holdsReservedAddressFor(hub.a, hub.b.peerId), 40_000, 100, 'A learns B\'s reserved circuit address through FRET')
		await waitFor(() => holdsReservedAddressFor(hub.b, hub.a.peerId), 40_000, 100, 'B learns A\'s reserved circuit address through FRET')

		const aToB = await hub.a.dial(hub.b.peerId)
		expect(aToB.remotePeer.equals(hub.b.peerId), 'A reached B').to.equal(true)
		assertLimited(hub.a, hub.b)

		const bToA = await hub.b.dial(hub.a.peerId)
		expect(bToA.remotePeer.equals(hub.a.peerId), 'B reached A').to.equal(true)
		assertLimited(hub.b, hub.a)
	})
})
