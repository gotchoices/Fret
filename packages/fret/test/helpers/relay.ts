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
import { generateKeyPair } from '@libp2p/crypto/keys'
import type { Connection, PrivateKey } from '@libp2p/interface'
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

/**
 * `privateKey` is optional because libp2p mints one when none is given; the hub below supplies
 * its own so a spec can hand the same key to FRET, which needs it to seal a self record and which
 * cannot read it back off a `Libp2p` (the interface does not expose it).
 */
async function createRelayNode(privateKey?: PrivateKey): Promise<Libp2p> {
	return await createLibp2p({
		...(privateKey ? { privateKey } : {}),
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

async function createRelayedNode(listenOnCircuit: boolean, privateKey?: PrivateKey): Promise<Libp2p> {
	return await createLibp2p({
		...(privateKey ? { privateKey } : {}),
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

/**
 * A relay with two peers that are reachable **only** through it — the shape of Optimystic#11.
 *
 * `a` and `b` each listen on `/p2p-circuit` alone, are connected to the relay and nothing else,
 * and hold a reservation on it. They are never connected to each other: that is the spec's job,
 * and whether a bare-id dial between them can succeed is the question under test. No FRET
 * service runs on any of the three — a spec that starts them chooses *when*, which is what makes
 * a negative control before the exchange meaningful.
 *
 * `keys` holds each node's private key by peer id string, since `Libp2p` does not expose it and
 * FRET needs it to seal this node's own signed address record.
 */
export interface RelayHub {
	relay: Libp2p
	a: Libp2p
	b: Libp2p
	keys: Map<string, PrivateKey>
	/** Every node, newest last — hand straight to `stopAll`. */
	all: Libp2p[]
}

export async function createRelayHub(): Promise<RelayHub> {
	const all: Libp2p[] = []
	const keys = new Map<string, PrivateKey>()
	const withKey = async (make: (key: PrivateKey) => Promise<Libp2p>): Promise<Libp2p> => {
		const key = await generateKeyPair('Ed25519')
		const node = await make(key)
		keys.set(node.peerId.toString(), key)
		all.push(node)
		return node
	}
	try {
		const relay = await withKey((key) => createRelayNode(key))
		const a = await withKey((key) => createRelayedNode(true, key))
		const b = await withKey((key) => createRelayedNode(true, key))
		await reserveThroughRelay(relay, a)
		await reserveThroughRelay(relay, b)
		return { relay, a, b, keys, all }
	} catch (err) {
		// Same reasoning as `createRelayTopology`: nodes already standing must not outlive a
		// failed setup, or the exit watchdog buries the real error.
		await stopAll(all)
		throw err
	}
}

/** The address of `node` that proves it holds a reservation on `relay` (see `reserveThroughRelay`). */
export function reservedCircuitAddr(relay: Libp2p, node: Libp2p): string | undefined {
	return node.getMultiaddrs().map((ma) => ma.toString()).find((ma) => isReservedCircuitOn(relay, ma))
}

/** Does this address route through `relay`'s circuit — `…/p2p/<relay>/p2p-circuit…`? */
export function isReservedCircuitOn(relay: Libp2p, ma: string): boolean {
	return ma.includes(`/p2p/${relay.peerId.toString()}/p2p-circuit`)
}

/** Connect `listener` to `relay` and wait until it holds a reservation there. */
async function reserveThroughRelay(relay: Libp2p, listener: Libp2p): Promise<void> {
	const relayAddr = relay.getMultiaddrs()[0]
	if (relayAddr == null) throw new Error('relay is not listening')

	// The reservation is made by the transport once the listener is connected to a relay. Waiting
	// for *any* `/p2p-circuit` address is not enough: the bare listen address `/p2p-circuit` is
	// reported from the moment the node starts, long before a reservation exists, so a wait on
	// that returns instantly and the dial that follows goes nowhere. The address that means a
	// reservation landed is the fully-qualified one — the relay's own address, then the circuit
	// hop, then the listener.
	await listener.dial(relayAddr)
	await waitFor('the listener to obtain a relay reservation', () => reservedCircuitAddr(relay, listener) != null)
}

/** Reserve a slot on the relay for `listener`, then dial it from `dialer` over that circuit. */
async function connectThroughRelay(relay: Libp2p, listener: Libp2p, dialer: Libp2p): Promise<void> {
	await reserveThroughRelay(relay, listener)
	const circuitAddr = listener.getMultiaddrs().find((ma) => isReservedCircuitOn(relay, ma.toString()))
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
