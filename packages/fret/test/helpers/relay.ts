import { createLibp2p, type Libp2p } from 'libp2p'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'
import { identify } from '@libp2p/identify'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import type { Connection } from '@libp2p/interface'

/**
 * A three-node circuit-relay topology: a publicly reachable relay, a `listener` that is only
 * reachable *through* it, and a `dialer` that reaches the listener over that circuit.
 *
 * This is the only way to obtain a **limited** connection, which is the whole point: libp2p marks
 * a relayed connection limited and then refuses to run a protocol over it unless *both* ends
 * opted in for that protocol. A hand-built stub cannot stand in — the check lives inside libp2p's
 * own `Connection`, reading options the registrar stored, so anything short of a real relay would
 * be testing our own mock.
 *
 * The relay's limits are libp2p's **defaults** (`applyDefaultLimit` is on unless a caller turns it
 * off: 2 minutes, 128 KiB). That matters for what the spec is entitled to claim — a deployment
 * that lifts the caps on its own relays never meets this bug, so a rig that lifted them would be
 * green for the wrong reason.
 */
export interface RelayTopology {
	relay: Libp2p
	listener: Libp2p
	dialer: Libp2p
	/** Every node, newest last — hand straight to `stopAll`. */
	all: Libp2p[]
}

async function createRelayNode(): Promise<Libp2p> {
	return await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: {
			identify: identify(),
			relay: circuitRelayServer()
		}
	})
}

async function createRelayedNode(listenOnCircuit: boolean): Promise<Libp2p> {
	return await createLibp2p({
		addresses: { listen: listenOnCircuit ? ['/p2p-circuit'] : [] },
		transports: [tcp(), circuitRelayTransport()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: { identify: identify() }
	})
}

/** Poll until `predicate` holds, or throw after `timeoutMs`. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
		await new Promise<void>((resolve) => setTimeout(resolve, 50))
	}
}

/**
 * Stand the topology up and dial the listener through the relay.
 *
 * Returns once the dialer holds an open connection to the listener whose `limits` are populated;
 * `assertLimited` below is what the specs use to state that as an assertion rather than trusting
 * this helper.
 */
export async function createRelayTopology(): Promise<RelayTopology> {
	const relay = await createRelayNode()
	const listener = await createRelayedNode(true)
	const dialer = await createRelayedNode(false)
	const all = [relay, listener, dialer]

	const relayAddr = relay.getMultiaddrs()[0]
	if (relayAddr == null) throw new Error('relay is not listening')

	// The reservation is made by the transport once the listener is connected to a relay. Waiting
	// for *any* `/p2p-circuit` address is not enough: the bare listen address `/p2p-circuit` is
	// reported from the moment the node starts, long before a reservation exists, so a wait on
	// that returns instantly and the dial that follows goes nowhere. The address that means a
	// reservation landed is the fully-qualified one — the relay's own address, then the circuit
	// hop, then the listener.
	const relayId = relay.peerId.toString()
	const isReservedCircuit = (ma: string): boolean => ma.includes(`/p2p/${relayId}/p2p-circuit`)

	await listener.dial(relayAddr)
	await waitFor('the listener to obtain a relay reservation', () =>
		listener.getMultiaddrs().some(ma => isReservedCircuit(ma.toString())))

	const circuitAddr = listener.getMultiaddrs().find(ma => isReservedCircuit(ma.toString()))
	if (circuitAddr == null) throw new Error('listener has no reserved circuit address')
	await dialer.dial(circuitAddr)
	// `dial()` resolves when the *dialer's* half is up; the listener's inbound half is created by
	// its own STOP handler and lands a moment later. Both halves matter — the gate under test runs
	// on the listener, reading the listener's connection object.
	await waitFor('both ends of the circuit to report an open connection', () =>
		connectionTo(dialer, listener) != null && connectionTo(listener, dialer) != null)

	return { relay, listener, dialer, all }
}

/** The open connection from `from` to `to`, or `undefined`. */
export function connectionTo(from: Libp2p, to: Libp2p): Connection | undefined {
	return from.getConnections(to.peerId).find(c => c.status === 'open')
}

/**
 * Assert the connection between the two nodes is really limited, in both directions.
 *
 * The negative control below is only meaningful if this holds: a handler registered *without*
 * `runOnLimitedConnection` is refused **because** the connection is limited, so a rig where the
 * connection turned out to be direct would make the control pass while proving nothing.
 */
export function assertLimited(from: Libp2p, to: Libp2p): Connection {
	const conn = connectionTo(from, to)
	if (conn == null) throw new Error('no open connection between the nodes')
	const limits = (conn as { limits?: unknown }).limits
	if (limits == null) throw new Error(`connection ${conn.id} is not limited - the rig is not testing the relayed path`)
	return conn
}
