import { createLibp2p, type Libp2p } from 'libp2p'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'
import { memory } from '@libp2p/memory'
import { plaintext } from '@libp2p/plaintext'
import { identify, identifyPush } from '@libp2p/identify'
import type { PrivateKey } from '@libp2p/interface'

let memAddrCounter = 0

export async function createMemoryNode(): Promise<Libp2p> {
	const node = await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()]
	})
	return node
}

export async function createMemNode(addr?: string): Promise<Libp2p> {
	const listenAddr = addr ?? `/memory/node-${++memAddrCounter}-${Date.now()}`
	const node = await createLibp2p({
		addresses: { listen: [listenAddr] },
		transports: [memory()],
		connectionEncrypters: [plaintext()],
		streamMuxers: [yamux()]
	})
	return node
}

/**
 * {@link createMemNode} plus libp2p's `identify`, so connecting two of these stores each side's
 * verified signed peer record — which FRET mirrors onto the routing-table entry. `privateKey` lets
 * a spec restart a node under the same identity with a fresh peerStore.
 */
export async function createIdentifyMemNode(privateKey?: PrivateKey): Promise<Libp2p> {
	return await createLibp2p({
		...(privateKey ? { privateKey } : {}),
		addresses: { listen: [`/memory/identify-node-${++memAddrCounter}-${Date.now()}`] },
		transports: [memory()],
		connectionEncrypters: [plaintext()],
		streamMuxers: [yamux()],
		services: { identify: identify() }
	})
}

/**
 * TCP node with libp2p's `identify` + `identifyPush` services enabled.
 *
 * Unlike {@link createMemNode} (memory transport, no identify), connecting two of these
 * exchanges each peer's negotiated-protocol list and populates the peerStore — and
 * `identifyPush` propagates later protocol changes. Those are exactly the libp2p signals
 * FRET's membership classification reads on `peer:identify` / `peer:update` and in
 * `seedFromPeerStore`'s `peerStore.all()` poll, so this factory is required to exercise the
 * identify-driven classification path end-to-end (the in-memory nodes never fire it).
 */
export async function createIdentifyNode(): Promise<Libp2p> {
	const node = await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: {
			identify: identify(),
			identifyPush: identifyPush()
		}
	})
	return node
}

export async function connectLine(nodes: any[]): Promise<void> {
	for (let i = 1; i < nodes.length; i++) {
		const ma = nodes[i - 1]!.getMultiaddrs()[0]
		await nodes[i]!.dial(ma)
	}
}

export async function stopAll(nodes: any[]): Promise<void> {
	// Newest first, best-effort per node: one throwing `stop()` must not strand the nodes behind
	// it for the exit watchdog to dump on. Logged rather than swallowed — "don't strand siblings"
	// is not "hide failures".
	for (const n of [...nodes].reverse()) {
		try { await n.stop() } catch (err) { console.error('[test cleanup] node stop failed:', err) }
	}
}

export function toMultiaddrs(node: any): string[] {
	return node.getMultiaddrs().map((ma: any) => ma.toString())
}


