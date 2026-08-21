import { describe, it } from 'mocha'
import { createMemoryNode } from './helpers/libp2p.js'
import { buildMesh, type Mesh } from './helpers/mesh.js'

/** Line of `n` TCP nodes, dialed **before** the services start. */
async function makeMesh(n: number): Promise<Mesh> {
	const mesh = await buildMesh(n, { factory: createMemoryNode })
	await mesh.connect('line')
	await mesh.addServices((i, m) => ({
		profile: 'edge',
		k: 7,
		bootstraps: i === 0 ? [] : [m.ids[0]!]
	}))
	return mesh
}

describe('maybeAct routing', function () {
	this.timeout(20000)

	it('returns near anchors and cohort hints with breadcrumbs', async () => {
		const mesh = await makeMesh(3)
		await new Promise(r => setTimeout(r, 1500))
		const msg = {
			v: 1,
			key: 'aWQ', // 'id' base64url
			want_k: 7,
			wants: 5,
			ttl: 3,
			min_sigs: 3,
			digest: 'Zg',
			breadcrumbs: [] as string[],
			correlation_id: 'Yw',
			timestamp: Date.now(),
			signature: ''
		}
		const res = await (mesh.services[1] as any).routeAct(msg)
		if (!('anchors' in res)) throw new Error('expected NearAnchor response')
		if ((res as any).anchors.length === 0) throw new Error('no anchors returned')
		await mesh.stop()
	})
})
