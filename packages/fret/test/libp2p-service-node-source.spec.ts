import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { Libp2pFretService } from '../src/service/libp2p-fret-service.js'

/**
 * The wrapper takes its node from one of two places: the explicit {@link Libp2pFretService.setLibp2p}
 * injection, or the `libp2p` component the host may pass to the constructor. The component was
 * stored and never read, so a service constructed the ordinary libp2p way threw "node not
 * injected" even though it had been handed a node.
 */
describe('Libp2pFretService — where the node comes from', function () {
	this.timeout(20_000)

	it('runs off the libp2p component when no explicit injection happened', async () => {
		const node = await createMemNode(); await node.start()
		const svc = new Libp2pFretService({ libp2p: node }, { profile: 'core', k: 7 })
		try {
			await svc.start()
			expect(svc.listPeers(), 'service is live').to.be.an('array')
		} finally {
			await svc.stop()
			await stopAll([node])
		}
	})

	it('prefers the explicitly injected node over the component', async () => {
		const componentNode = await createMemNode(); await componentNode.start()
		const injectedNode = await createMemNode(); await injectedNode.start()
		const svc = new Libp2pFretService({ libp2p: componentNode }, { profile: 'core', k: 7 })
		try {
			svc.setLibp2p(injectedNode)
			await svc.start()
			// Self is seeded into the routing table under the node's own peer id.
			const ids = svc.listPeers().map(p => p.id)
			expect(ids, 'self entry comes from the injected node').to.include(injectedNode.peerId.toString())
			expect(ids, 'component node is not the host').to.not.include(componentNode.peerId.toString())
		} finally {
			await svc.stop()
			await stopAll([componentNode, injectedNode])
		}
	})

	it('still fails loudly when neither source supplies a node', async () => {
		const svc = new Libp2pFretService({}, { profile: 'core', k: 7 })
		let err: unknown
		try { await svc.start() } catch (e) { err = e }
		expect(err, 'start must reject').to.be.instanceOf(Error)
		expect((err as Error).message).to.match(/node not injected/)
	})
})
