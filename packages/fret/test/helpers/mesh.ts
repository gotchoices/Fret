import type { Libp2p } from 'libp2p'
import type { FretConfig } from '../../src/index.js'
import { FretService } from '../../src/service/fret-service.js'
import { createMemNode, connectLine, stopAll } from './libp2p.js'
import type { Cleanup } from './cleanup.js'

/**
 * Multi-node rig for the specs that stand up a real topology of in-memory libp2p nodes and
 * (usually) a FRET service on each.
 *
 * Deliberately **not** part of `helpers/libp2p.ts`: that module is the bare node *factory* and
 * knows nothing about `FretService`. Importing the service there would make every spec that only
 * wants a node pull the whole service in.
 *
 * Also deliberately **not** an overlap with `helpers/maintenance-rig.ts`, which builds one node
 * plus one service and hand-feeds stub connections per RPC. That rig solves per-RPC control; this
 * one solves real multi-node topology. Neither should grow into the other.
 *
 * **Construction and connection are two calls, on purpose.** The order matters behaviourally and
 * the specs genuinely differ: some construct and `start()` the services *then* dial (so the ring
 * is discovered through `peer:connect`), others dial *then* construct (so `start()`'s
 * `seedFromPeerStore` already sees the connections). A single `buildMesh({topology, service})`
 * would bake one order in and silently change what several specs assert, so the caller keeps it:
 *
 * ```ts
 * const mesh = await buildMesh(4)
 * await mesh.addServices(() => ({ profile: 'edge', k: 7, bootstraps: [mesh.ids[0]!] }))
 * await mesh.connect('star')   // services first, then dial
 * ```
 *
 * The four specs that wanted *only* that ordering with one shared config now call
 * {@link starMesh} instead; `buildMesh` + the two calls stays the path for every spec whose order
 * or config differs (dial-then-construct, `line` / `full`, per-node config).
 */
export type Topology = 'star' | 'line' | 'full'

/** How each node is made. Defaults to {@link createMemNode} (memory transport, no identify). */
export type NodeFactory = () => Promise<Libp2p>

/** Per-node service config: one object for every node, or a function of the node's index. */
export type ServiceConfig =
	| Partial<FretConfig>
	| ((index: number, mesh: Mesh) => Partial<FretConfig>)

export interface MeshOptions {
	/**
	 * Node factory. Defaults to `createMemNode` (memory transport). Pass `createMemoryNode` for
	 * TCP, or `createIdentifyNode` when the spec needs libp2p's `identify` to run.
	 */
	factory?: NodeFactory
	/**
	 * Teardown registry (see `helpers/cleanup.ts`). When supplied, `mesh.stop()` is registered on
	 * it the moment the mesh exists, so a case that throws before its last statement still tears
	 * the mesh down. This is the path that makes the leak structurally unwritable — a spec author
	 * cannot forget a teardown the helper owns.
	 *
	 * `mesh.stop()` is idempotent enough to be the registered step even for a case that stops a
	 * node or service mid-test: every stop in it is best-effort, so re-stopping something already
	 * stopped is logged at worst, never thrown.
	 */
	cleanup?: Cleanup
}

export interface StopOptions {
	/**
	 * Indices to leave alone — the "this node was already stopped mid-test" case. Both the
	 * service and the node at each index are skipped.
	 */
	skip?: number[]
}

export interface Mesh {
	readonly nodes: Libp2p[]
	/** `nodes[i].peerId.toString()`, precomputed — the usual `bootstraps` argument. */
	readonly ids: string[]
	/** Empty until {@link Mesh.addServices} runs; then parallel to `nodes`. */
	readonly services: FretService[]
	connect(topology: Topology): Promise<void>
	addServices(cfg: ServiceConfig): Promise<void>
	stop(opts?: StopOptions): Promise<void>
}

/**
 * `count` started in-memory libp2p nodes. No services and no connections yet.
 *
 * NOTE: a throw from the factory or from `node.start()` on iteration *j* rejects without stopping
 * nodes `0..j-1`, and the caller's `mesh` is never assigned, so its `afterEach` cannot stop them
 * either — they would surface as an exit-watchdog open-handle dump. Only reachable if in-memory
 * node construction itself fails, which is why the loop is left plain; if a spec ever reports a
 * watchdog dump from a failed mesh construction, wrap the loop and `stopAll` what was built.
 */
export async function buildMesh(count: number, opts: MeshOptions = {}): Promise<Mesh> {
	const factory = opts.factory ?? createMemNode
	const nodes: Libp2p[] = []
	for (let i = 0; i < count; i++) {
		const node = await factory()
		await node.start()
		nodes.push(node)
	}
	const services: FretService[] = []
	const mesh: Mesh = {
		nodes,
		ids: nodes.map(n => n.peerId.toString()),
		services,
		connect: (topology: Topology) => connectMesh(nodes, topology),
		addServices: async (cfg: ServiceConfig) => {
			for (let i = 0; i < nodes.length; i++) {
				const svc = new FretService(nodes[i]!, typeof cfg === 'function' ? cfg(i, mesh) : cfg)
				await svc.start()
				services.push(svc)
			}
		},
		stop: async (stopOpts?: StopOptions) => {
			const skip = new Set(stopOpts?.skip ?? [])
			// Services down before the nodes under them, newest first — the same ordering
			// `stopAll` applies to nodes. Every stop swallows its own throw, so one rejecting
			// service cannot strand the listeners behind it for the exit watchdog to report.
			for (let i = services.length - 1; i >= 0; i--) {
				if (skip.has(i)) continue
				try { await services[i]!.stop() } catch (err) { console.error('[test cleanup] service stop failed:', err) }
			}
			await stopAll(nodes.filter((_, i) => !skip.has(i)))
		}
	}
	opts.cleanup?.add(() => mesh.stop())
	return mesh
}

export interface StarMeshOptions extends MeshOptions {
	/**
	 * Merged over the default per-node config, so a caller can override `k` or `profile` without
	 * restating the index-dependent `bootstraps`. Pass `bootstraps` explicitly to override that too.
	 */
	config?: Partial<FretConfig>
}

/**
 * The common case, in one call: `count` in-memory nodes, an edge-profile service on each
 * bootstrapped off node 0, **then** a star dialed at node 0.
 *
 * Services first, dial second — so every node's RPC handlers and `peer:connect` listener are
 * registered before any connection exists. A spec needing the other order (dial first, so
 * `start()`'s `seedFromPeerStore` sees the connections) must use `buildMesh` and the two calls;
 * that is why they are still separate.
 */
export async function starMesh(count: number, opts: StarMeshOptions = {}): Promise<Mesh> {
	const { config, ...meshOpts } = opts
	const mesh = await buildMesh(count, meshOpts)
	await mesh.addServices((i, m) => ({
		profile: 'edge',
		k: 7,
		bootstraps: i === 0 ? [] : [m.ids[0]!],
		...config
	}))
	await mesh.connect('star')
	return mesh
}

async function connectMesh(nodes: Libp2p[], topology: Topology): Promise<void> {
	switch (topology) {
		case 'star': {
			// Every node dials node 0. Node 0 therefore holds a direct connection to all of them,
			// which is what lets leave notices and announces reach it without address hints.
			for (let i = 1; i < nodes.length; i++) {
				await nodes[i]!.dial(nodes[0]!.getMultiaddrs()[0]!)
			}
			break
		}
		case 'line': {
			await connectLine(nodes)
			break
		}
		case 'full': {
			for (let i = 0; i < nodes.length; i++) {
				for (let j = i + 1; j < nodes.length; j++) {
					await nodes[i]!.dial(nodes[j]!.getMultiaddrs()[0]!)
				}
			}
			break
		}
	}
}
