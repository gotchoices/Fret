import { describe, it } from 'mocha'
import { createMemoryNode } from './helpers/libp2p.js'
import { buildMesh, type Mesh } from './helpers/mesh.js'
import { useCleanup, type Cleanup } from './helpers/cleanup.js'
import type { FretConfig } from '../src/index.js'

/**
 * Two TCP nodes, B dialed to A **before** either service starts (so each `start()`'s
 * `seedFromPeerStore` already sees the connection), then a service on each with its own config.
 *
 * Registered for teardown at construction: a failed assertion below must report *itself* rather
 * than leave the nodes running for the exit watchdog to dump an open-handle list on top of it.
 */
async function makePair(cleanup: Cleanup, cfgA: Partial<FretConfig>, cfgB: Partial<FretConfig>): Promise<Mesh> {
	const mesh = await buildMesh(2, { factory: createMemoryNode, cleanup })
	await mesh.connect('line')
	await mesh.addServices(i => (i === 0 ? cfgA : cfgB))
	return mesh
}

describe('Network isolation', function () {
	this.timeout(15000)
	const cleanup = useCleanup()

	it('different networkNames cannot exchange neighbor snapshots', async () => {
		const mesh = await makePair(
			cleanup,
			{ profile: 'edge', networkName: 'network-alpha' },
			{ profile: 'edge', networkName: 'network-beta' }
		)

		await new Promise((r) => setTimeout(r, 1000))

		// Nodes should not have discovered each other due to protocol mismatch
		const diagA = (mesh.services[0] as any).getDiagnostics?.()
		const diagB = (mesh.services[1] as any).getDiagnostics?.()

		// No snapshots should be fetched across networks
		if ((diagA.snapshotsFetched ?? 0) > 0 || (diagB.snapshotsFetched ?? 0) > 0) {
			throw new Error('Cross-network snapshot exchange occurred')
		}
	})

	it('same networkName allows neighbor snapshots', async () => {
		const mesh = await buildMesh(2, { factory: createMemoryNode, cleanup })
		await mesh.connect('line')
		await mesh.addServices((i, m) => ({
			profile: 'edge',
			networkName: 'network-gamma',
			...(i === 1 ? { bootstraps: [m.ids[0]!] } : {})
		}))

		await new Promise((r) => setTimeout(r, 2000))

		// Nodes in same network should discover each other
		const storeB = (mesh.services[1] as any).store
		const peersB = storeB.list().map((p: any) => p.id)

		// B should have discovered A via bootstrap
		const hasA = peersB.includes(mesh.ids[0]!)

		if (!hasA) {
			throw new Error(`Same-network discovery failed: B did not discover A`)
		}
	})
})
