import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createLibp2p } from 'libp2p'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { waitFor } from './helpers/wait-for.js'

async function createNode() {
	const node = await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()]
	})
	return node
}

function toMultiaddrs(node: any): string[] {
	return node.getMultiaddrs().map((ma: any) => ma.toString())
}

/**
 * The only spec that runs FRET over a **real TCP transport** — everything else uses the in-memory
 * one — and the only one with a libp2p node that hosts no FRET service at all. That service-less
 * node `c` is a negative control: it is connected to `a` like any other peer, yet serves none of
 * this network's protocols, so no evidence path can promote it to `member`.
 */
describe('FRET basic mesh', function () {
	this.timeout(30000)

	it('two FRET nodes over TCP classify each other member; a service-less peer never is', async () => {
		const a = await createNode()
		await a.start()
		const b = await createNode()
		await b.start()
		const c = await createNode()
		await c.start()

		const serviceA = new CoreFretService(a, { profile: 'edge' })
		const serviceB = new CoreFretService(b, { bootstraps: toMultiaddrs(a), profile: 'edge' })
		await serviceA.start()
		await serviceB.start()

		try {
			// Dial *after* the services are up. This transport carries no `identify` service, so
			// `peer:connect` is how an entry first appears in the routing table (as `unknown`) and
			// the classification probe pass is what promotes it.
			const addrs = a.getMultiaddrs()
			await b.dial(addrs[0]!)
			await c.dial(addrs[0]!)

			const aId = a.peerId.toString()
			const bId = b.peerId.toString()
			const cId = c.peerId.toString()
			// Tolerates a missing entry rather than throwing on `undefined` — over TCP the entry
			// arrives asynchronously via `peer:connect`.
			const membership = (svc: CoreFretService, id: string) => svc.getStore().getById(id)?.membership

			// `pingsOk` is in the predicate rather than asserted after it: it is the proof that the
			// `member` label came from a completed namespaced RPC rather than from assumption, and
			// waiting for both together avoids racing a label that lands one tick before the ping
			// diagnostic it implies.
			await waitFor(
				() =>
					membership(serviceA, bId) === 'member' &&
					membership(serviceB, aId) === 'member' &&
					serviceA.getDiagnostics().pingsOk > 0 &&
					serviceB.getDiagnostics().pingsOk > 0 &&
					membership(serviceA, cId) !== undefined,
				20000,
				50,
				'a and b classify each other member over real RPC, and a knows about c'
			)

			expect(membership(serviceA, bId), 'a classified b').to.equal('member')
			expect(membership(serviceB, aId), 'b classified a').to.equal('member')
			expect(serviceA.getDiagnostics().pingsOk, 'a got there through real RPC').to.be.greaterThan(0)
			expect(serviceB.getDiagnostics().pingsOk, 'b got there through real RPC').to.be.greaterThan(0)

			// c hosts no FRET service, so it can never answer this network's protocols. Deliberately
			// *not* asserted `foreign`: that needs three time-separated negotiate failures (~7 s) and
			// would make this spec slow and flaky. Likewise nothing is asserted about `a`'s
			// `pingsFail` — `a` keeps failing to negotiate against `c` in the background, which is
			// expected noise whose count depends on how many probe passes happened to run.
			expect(membership(serviceA, cId), 'a knows about c, which is connected to it').to.not.equal(undefined)
			expect(membership(serviceA, cId), 'a service-less peer is never a member').to.not.equal('member')
		} finally {
			await serviceB.stop()
			await serviceA.stop()
			await c.stop()
			await b.stop()
			await a.stop()
		}
	})
})
