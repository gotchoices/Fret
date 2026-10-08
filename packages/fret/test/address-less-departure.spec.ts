import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import { createLibp2p, type Libp2p } from 'libp2p'
import { memory } from '@libp2p/memory'
import { plaintext } from '@libp2p/plaintext'
import { yamux } from '@chainsafe/libp2p-yamux'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { waitFor } from './helpers/wait-for.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { fretService, type Libp2pFretService } from '../src/service/libp2p-fret-service.js'
import { hashPeerId } from '../src/ring/hash.js'

// A peer that dials out and listens nowhere — a phone — has no address anyone can dial. Once it
// goes away, the observer must still retire it from the ring promptly, by whichever way it left:
//
//   - ungracefully (its node simply stops): no pass could ever contact it, so no failed contact
//     was ever booked and it stayed a live member forever. The near pass now counts each tick it
//     sits uncontactable in the S/P window as one failed contact;
//   - gracefully, hosted as a libp2p service: its leave notices went out from `stop()`, after
//     libp2p had already closed every connection, so none arrived. They now go out from
//     `beforeStop()`; and the notice that does arrive marks it `dead` rather than removing it,
//     which the next tick's peerStore re-seed used to undo.
//
// Mutation-checked when written: reverting any one of the three fixes reddens exactly the case
// that names it.

/** A memory-transport node that listens nowhere — it can dial, and nobody can dial it. */
async function dialOnlyNode(fret?: ReturnType<typeof fretService>): Promise<Libp2p> {
	return await createLibp2p({
		start: false,
		addresses: { listen: [] },
		transports: [memory()],
		connectionEncrypters: [plaintext()],
		streamMuxers: [yamux()],
		...(fret ? { services: { fret } } : {}),
	})
}

describe('address-less peer departure', function () {
	this.timeout(20000)

	const nodes: Libp2p[] = []
	const svcs: CoreFretService[] = []

	afterEach(async () => {
		for (const s of svcs.splice(0)) {
			try { await s.stop() } catch { /* never started, or already stopped by the test */ }
		}
		await stopAll(nodes.splice(0))
	})

	async function listeningObserver(cfg: { deadAfterFailures?: number } = {}): Promise<{ b: Libp2p; svcB: CoreFretService }> {
		const b = await createMemNode()
		await b.start()
		nodes.push(b)
		const svcB = new CoreFretService(b, { profile: 'core', k: 7, networkName: 'net-test', ...cfg })
		svcs.push(svcB)
		return { b, svcB }
	}

	/** One whole stabilization tick as the loop drives it: the peerStore re-seed, then the tick. */
	async function tick(svc: CoreFretService): Promise<void> {
		await (svc as any).seedFromPeerStore()
		await (svc as any).stabilizeOnce()
	}

	it('marks a vanished address-less member dead after three spaced ticks', async () => {
		// The observer is never started: ticks are driven by hand, so its own loop cannot race the
		// count. The phone runs no FRET at all — from the observer's side an ungraceful departure
		// is just a connection that stops existing.
		const { b, svcB } = await listeningObserver()
		const a = await dialOnlyNode()
		await a.start()
		nodes.push(a)
		const aId = a.peerId.toString()
		await a.dial(b.getMultiaddrs()[0]!)

		const store = svcB.getStore()
		await (svcB as any).seedFromPeerStore()
		// Stands in for the `peer:connect` and inbound RPC that admit and label a real phone: the
		// observer is not started, memory nodes run no identify, and this phone serves nothing.
		store.upsert(aId, await hashPeerId(a.peerId))
		store.setMembership(aId, 'member')
		const window = async (): Promise<{ targets: string[]; uncontactable: string[] }> =>
			await (svcB as any).nearProbeTargets()
		expect((await window()).targets, 'premise: verified by the near pass while connected').to.include(aId)

		await a.stop()
		await waitFor(() => b.getConnections(a.peerId).length === 0, 5000, 25, 'the observer saw the connection close')
		expect((await window()).uncontactable, 'no connection and no address: uncontactable').to.include(aId)

		for (let i = 0; i < 3; i++) {
			// Hand-driven ticks land microseconds apart; rewind the spacing stamp so each is the
			// independent observation a 1.5 s passive tick would be.
			store.update(aId, { lastContactFailureAt: 0 })
			await tick(svcB)
		}

		expect(store.getById(aId)?.state, 'three uncontactable ticks are a completed run').to.equal('dead')
		expect(svcB.getNeighbors(await hashPeerId(b.peerId), 'both', 8), 'out of the ring views').to.not.include(aId)
	})

	it('delivers a libp2p-hosted address-less peer\'s leave notice, and the re-seed does not undo it', async () => {
		// The observer's own contact-failure run is pushed out of reach, so `dead` inside this test
		// can come only from the leave notice — the uncontactable strikes above would otherwise
		// reach it within a few of the observer's real 1.5 s ticks.
		const { b, svcB } = await listeningObserver({ deadAfterFailures: 1000 })
		await svcB.start() // registers the leave handler
		const a = await dialOnlyNode(fretService({ profile: 'core', k: 7, networkName: 'net-test' }))
		nodes.push(a)
		;(a.services.fret as unknown as Libp2pFretService).setLibp2p(a)
		await a.start()
		const aId = a.peerId.toString()
		await a.dial(b.getMultiaddrs()[0]!)

		const store = svcB.getStore()
		// The phone's classification ping reaches the observer's handler, which promotes it.
		await waitFor(() => store.getById(aId)?.membership === 'member', 10000, 25, 'the observer labelled the phone a member')

		await a.stop()

		await waitFor(() => store.getById(aId)?.state === 'dead', 2000, 25, 'the leave notice arrived and was acted on')
		// libp2p still holds the phone's peerStore record — negotiated protocols included — which is
		// what re-created a removed entry as a live member on the very next tick.
		await tick(svcB)
		expect(store.getById(aId)?.state, 'still dead after the re-seed').to.equal('dead')
		expect(svcB.getNeighbors(await hashPeerId(b.peerId), 'both', 8), 'out of the ring views').to.not.include(aId)
	})
})
