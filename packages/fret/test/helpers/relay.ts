import { createLibp2p, type Libp2p } from 'libp2p'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'
import { identify } from '@libp2p/identify'
// NOTE: `@libp2p/circuit-relay-v2` is pinned to an exact version in package.json rather than to a
// range, and this is its only consumer. 4.1.3 is the newest release whose whole transitive
// `@libp2p/*` set matches what libp2p 3.1.3 already pulls, so it dedupes completely; a newer one
// drags in a second `@libp2p/interface` (3.3.0 adds a required `Stream.readableEnded`, which the
// installed libp2p's streams do not have). Nothing in the repo moves the pin for you — if you bump
// the libp2p stack, bump this too; a stale pin surfaces as a `tsc --noEmit` type error, loudly, but
// only at that point.
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import type { Connection } from '@libp2p/interface'
import { stopAll } from './libp2p.js'

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
	const all: Libp2p[] = []
	try {
		const relay = await createRelayNode(); all.push(relay)
		const listener = await createRelayedNode(true); all.push(listener)
		const dialer = await createRelayedNode(false); all.push(dialer)
		await connectThroughRelay(relay, listener, dialer)
		return { relay, listener, dialer, all }
	} catch (err) {
		// Setup runs across three nodes, a reservation and two dials, and any of them can throw.
		// The nodes already standing must be stopped here: the spec's `after` hook has no topology
		// to hand `stopAll`, so they would stay live and the mocha exit watchdog would fail the run
		// on the open handles — burying the setup error that actually caused it.
		await stopAll(all)
		throw err
	}
}

/** Reserve a slot on the relay for `listener`, then dial it from `dialer` over that circuit. */
async function connectThroughRelay(relay: Libp2p, listener: Libp2p, dialer: Libp2p): Promise<void> {
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
