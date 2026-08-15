import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemoryNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { sendMaybeAct } from '../src/rpc/maybe-act.js'
import { PROTOCOL_MAYBE_ACT } from '../src/rpc/protocols.js'
import type { Libp2p } from 'libp2p'
import type { RouteAndMaybeActV1 } from '../src/index.js'

/**
 * Two nodes, both running FretService, with the activity handler installed on the responder.
 * The requester sends over the wire so the whole inbound path (dedup cache included) runs,
 * which is where the phase collision lived — `routeAct` alone never touches the cache.
 */
async function makePair() {
	const requester = await createMemoryNode(); await requester.start()
	const responder = await createMemoryNode(); await responder.start()
	await requester.dial(responder.getMultiaddrs()[0]!)

	const svcResponder = new CoreFretService(responder, { profile: 'edge', k: 7 })
	const svcRequester = new CoreFretService(requester, {
		profile: 'edge', k: 7, bootstraps: [responder.peerId.toString()]
	})
	await svcResponder.start()
	await svcRequester.start()
	await new Promise(r => setTimeout(r, 800))

	return { requester, responder, svcRequester, svcResponder }
}

function baseMsg(correlationId: string): RouteAndMaybeActV1 {
	return {
		v: 1,
		key: 'aWQ', // 'id' base64url
		want_k: 7,
		ttl: 3,
		min_sigs: 1,
		digest: 'Zg',
		breadcrumbs: [],
		correlation_id: correlationId,
		timestamp: Date.now(),
		signature: ''
	}
}

describe('maybeAct dedup is keyed on phase, not just correlation id', function () {
	this.timeout(25000)

	it('runs the activity on a resend that shares the probe\'s correlation id', async () => {
		const { requester, responder, svcRequester, svcResponder } = await makePair()
		let fired = 0
		const seenCorrelationIds: string[] = []
		svcResponder.setActivityHandler(async (_activity, _cohort, _minSigs, corrId) => {
			fired++
			seenCorrelationIds.push(corrId)
			return { commitCertificate: 'cert-ok' }
		})

		const corrId = 'phase-collision-1'
		const responderId = responder.peerId.toString()

		// Phase 1: digest-only probe. The responder is in-cluster (tiny ring), so it replies
		// with anchors inviting a resend — and those anchors name itself.
		const probe = await sendMaybeAct(requester, responderId, baseMsg(corrId), PROTOCOL_MAYBE_ACT)
		expect(probe, 'digest probe should return NearAnchor').to.have.property('anchors')
		expect(fired, 'digest probe must not run the activity handler').to.equal(0)

		// Phase 2: the resend that actually carries the work, same correlation id.
		const act = await sendMaybeAct(
			requester, responderId,
			{ ...baseMsg(corrId), activity: 'payload-data' },
			PROTOCOL_MAYBE_ACT
		)

		expect(act, 'activity resend must not be answered from the probe\'s cache entry')
			.to.have.property('commitCertificate')
		expect(fired, 'activity handler should fire exactly once').to.equal(1)
		expect(seenCorrelationIds[0]).to.equal(corrId)

		await svcRequester.stop(); await svcResponder.stop()
		await stopAll([requester, responder])
	})

	it('still dedups within the activity phase: a repeated activity send performs the work once', async () => {
		const { requester, responder, svcRequester, svcResponder } = await makePair()
		let fired = 0
		svcResponder.setActivityHandler(async () => {
			fired++
			return { commitCertificate: `cert-${fired}` }
		})

		const corrId = 'activity-retry-1'
		const responderId = responder.peerId.toString()
		const msg = { ...baseMsg(corrId), activity: 'payload-data' }

		const first = await sendMaybeAct(requester, responderId, msg, PROTOCOL_MAYBE_ACT)
		const retry = await sendMaybeAct(requester, responderId, { ...msg, timestamp: Date.now() }, PROTOCOL_MAYBE_ACT)

		expect(first).to.have.property('commitCertificate', 'cert-1')
		expect(retry, 'a retry must return the stored certificate, not redo the work')
			.to.deep.equal(first)
		expect(fired, 'work must be performed exactly once').to.equal(1)

		await svcRequester.stop(); await svcResponder.stop()
		await stopAll([requester, responder])
	})

	it('still dedups within the digest phase: a repeated probe is answered from cache', async () => {
		const { requester, responder, svcRequester, svcResponder } = await makePair()
		const corrId = 'digest-replay-1'
		const responderId = responder.peerId.toString()

		const first = await sendMaybeAct(requester, responderId, baseMsg(corrId), PROTOCOL_MAYBE_ACT)
		const replay = await sendMaybeAct(
			requester, responderId, { ...baseMsg(corrId), timestamp: Date.now() }, PROTOCOL_MAYBE_ACT
		)

		expect(first).to.have.property('anchors')
		expect(replay).to.deep.equal(first)

		await svcRequester.stop(); await svcResponder.stop()
		await stopAll([requester, responder])
	})

	it('does not cache a NearAnchor as the answer to an activity-bearing message', async () => {
		const { requester, responder, svcRequester, svcResponder } = await makePair()
		const corrId = 'refusal-not-cached-1'
		const responderId = responder.peerId.toString()
		const msg = { ...baseMsg(corrId), activity: 'payload-data' }

		// No activity handler installed yet: the responder is in-cluster but cannot perform the
		// work, so it answers with anchors. That is a refusal, not the answer to this work.
		const refused = await sendMaybeAct(requester, responderId, msg, PROTOCOL_MAYBE_ACT)
		expect(refused, 'no handler installed → anchors').to.have.property('anchors')

		let fired = 0
		svcResponder.setActivityHandler(async () => {
			fired++
			return { commitCertificate: 'cert-ok' }
		})

		const retry = await sendMaybeAct(
			requester, responderId, { ...msg, timestamp: Date.now() }, PROTOCOL_MAYBE_ACT
		)
		expect(retry, 'the retry must re-attempt the work, not replay the cached refusal')
			.to.have.property('commitCertificate')
		expect(fired).to.equal(1)

		await svcRequester.stop(); await svcResponder.stop()
		await stopAll([requester, responder])
	})

	it('completes a find-then-act lookup end to end through iterativeLookup', async () => {
		const { requester, responder, svcRequester, svcResponder } = await makePair()
		let fired = 0
		svcResponder.setActivityHandler(async () => {
			fired++
			return { commitCertificate: 'cert-e2e' }
		})

		const events: string[] = []
		let completed: { commitCertificate: string } | undefined
		for await (const evt of svcRequester.iterativeLookup(new TextEncoder().encode('e2e-key'), {
			wantK: 7,
			minSigs: 1,
			digest: 'Zg',
			activity: 'payload-data',
			ttl: 3,
		})) {
			events.push(evt.type)
			if (evt.type === 'complete') completed = evt.result
		}

		expect(completed, `lookup did not complete; events: ${events.join(' -> ')}`)
			.to.deep.equal({ commitCertificate: 'cert-e2e' })
		expect(fired, 'activity performed exactly once').to.equal(1)

		await svcRequester.stop(); await svcResponder.stop()
		await stopAll([requester, responder])
	})
})

describe('iterativeLookup does not re-probe a peer', function () {
	this.timeout(25000)

	it('yields no duplicate peer across the probing events of one lookup', async () => {
		const nodes: Libp2p[] = []
		for (let i = 0; i < 4; i++) { const n = await createMemoryNode(); await n.start(); nodes.push(n) }
		const services: CoreFretService[] = []
		for (let i = 0; i < nodes.length; i++) {
			const boot = i === 0 ? [] : [nodes[0]!.peerId.toString()]
			const svc = new CoreFretService(nodes[i]!, { profile: 'edge', k: 7, bootstraps: boot })
			await svc.start()
			services.push(svc)
		}
		for (let i = 1; i < nodes.length; i++) await nodes[i]!.dial(nodes[0]!.getMultiaddrs()[0]!)
		await new Promise(r => setTimeout(r, 2000))

		const probed: string[] = []
		for await (const evt of services[0]!.iterativeLookup(new TextEncoder().encode('visited-key'), {
			wantK: 7,
			minSigs: 1,
			digest: 'Zg',
			ttl: 4,
		})) {
			if (evt.type === 'probing') probed.push(evt.peerId!)
		}

		expect(new Set(probed).size, `probed the same peer twice: ${probed.join(', ')}`)
			.to.equal(probed.length)

		await Promise.all(services.map(s => s.stop()))
		await stopAll(nodes)
	})
})
