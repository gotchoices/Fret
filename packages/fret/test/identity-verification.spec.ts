import { describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { registerLeave, sendLeave, type LeaveNoticeV1 } from '../src/rpc/leave.js'
import { registerNeighbors, announceNeighbors } from '../src/rpc/neighbors.js'
import { registerMaybeAct, sendMaybeAct } from '../src/rpc/maybe-act.js'
import type { NeighborSnapshotV1, RouteAndMaybeActV1, NearAnchorV1 } from '../src/index.js'

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

function snapshot(from: string): NeighborSnapshotV1 {
	return { v: 1, from, timestamp: Date.now(), successors: [], predecessors: [], sig: '' }
}

function nearAnchor(): NearAnchorV1 {
	return { v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 1, confidence: 1 }
}

/**
 * These tests use real connected mem-transport nodes: the sender opens a
 * transport-authenticated stream, so the receiver's handler sees the true
 * `connection.remotePeer`. The wire payload's self-reported `from` is crafted
 * independently, which is exactly how an impersonation attempt looks.
 */
describe('transport identity verification', function () {
	this.timeout(30000)

	// receiver, honest sender, and a third id used as the spoofed identity
	let recv: Libp2p, sender: Libp2p, other: Libp2p

	beforeEach(async () => {
		recv = await createMemNode(); await recv.start()
		sender = await createMemNode(); await sender.start()
		other = await createMemNode(); await other.start()
		// sender -> recv connection; recv's inbound handlers see remotePeer === sender
		await sender.dial(recv.getMultiaddrs()[0]!)
	})

	afterEach(async () => {
		await stopAll([recv, sender, other])
	})

	describe('leave notice', () => {
		it('drops a spoofed leave (from != authenticated sender); onLeave not called, mismatch fired', async () => {
			const onLeave: LeaveNoticeV1[] = []
			const mismatches: Array<{ claimed: string; actual: string }> = []
			await registerLeave(recv, (n) => { onLeave.push(n) }, undefined, (claimed, actual) => mismatches.push({ claimed, actual }))

			// claim to be `other` while actually connected as `sender`
			const spoofed: LeaveNoticeV1 = { v: 1, from: other.peerId.toString(), timestamp: Date.now() }
			await sendLeave(sender, recv.peerId.toString(), spoofed)
			await delay(300)

			expect(onLeave.length, 'onLeave calls').to.equal(0)
			expect(mismatches.length, 'mismatch calls').to.equal(1)
			expect(mismatches[0].claimed).to.equal(other.peerId.toString())
			expect(mismatches[0].actual).to.equal(sender.peerId.toString())
		})

		it('processes a valid leave (from == authenticated sender); onLeave called, no mismatch', async () => {
			const onLeave: LeaveNoticeV1[] = []
			const mismatches: Array<{ claimed: string; actual: string }> = []
			await registerLeave(recv, (n) => { onLeave.push(n) }, undefined, (claimed, actual) => mismatches.push({ claimed, actual }))

			const valid: LeaveNoticeV1 = { v: 1, from: sender.peerId.toString(), timestamp: Date.now() }
			await sendLeave(sender, recv.peerId.toString(), valid)
			await delay(300)

			expect(mismatches.length, 'mismatch calls').to.equal(0)
			expect(onLeave.length, 'onLeave calls').to.equal(1)
			expect(onLeave[0].from).to.equal(sender.peerId.toString())
		})
	})

	describe('announce snapshot', () => {
		it('drops a spoofed announce (from != authenticated sender); onAnnounce not called, mismatch fired', async () => {
			const announced: string[] = []
			const mismatches: Array<{ claimed: string; actual: string }> = []
			await registerNeighbors(
				recv,
				() => snapshot(recv.peerId.toString()),
				(from) => { announced.push(from) },
				undefined,
				undefined,
				(claimed, actual) => mismatches.push({ claimed, actual })
			)

			await announceNeighbors(sender, recv.peerId.toString(), snapshot(other.peerId.toString()))
			await delay(300)

			expect(announced.length, 'onAnnounce calls').to.equal(0)
			expect(mismatches.length, 'mismatch calls').to.equal(1)
			expect(mismatches[0].claimed).to.equal(other.peerId.toString())
			expect(mismatches[0].actual).to.equal(sender.peerId.toString())
		})

		it('processes a valid announce (from == authenticated sender); onAnnounce called, no mismatch', async () => {
			const announced: string[] = []
			const mismatches: Array<{ claimed: string; actual: string }> = []
			await registerNeighbors(
				recv,
				() => snapshot(recv.peerId.toString()),
				(from) => { announced.push(from) },
				undefined,
				undefined,
				(claimed, actual) => mismatches.push({ claimed, actual })
			)

			await announceNeighbors(sender, recv.peerId.toString(), snapshot(sender.peerId.toString()))
			await delay(300)

			expect(mismatches.length, 'mismatch calls').to.equal(0)
			expect(announced.length, 'onAnnounce calls').to.equal(1)
			expect(announced[0]).to.equal(sender.peerId.toString())
		})
	})

	describe('route-and-maybe-act', () => {
		it('threads the authenticated sender id to the handle callback', async () => {
			const seen: string[] = []
			await registerMaybeAct(recv, async (_msg, from) => { seen.push(from); return nearAnchor() })

			const msg: RouteAndMaybeActV1 = {
				v: 1,
				key: 'AAAA',
				want_k: 3,
				ttl: 4,
				min_sigs: 2,
				correlation_id: 'test-corr',
				timestamp: Date.now(),
				signature: '',
			}
			await sendMaybeAct(sender, recv.peerId.toString(), msg)
			await delay(300)

			expect(seen.length, 'handle calls').to.equal(1)
			expect(seen[0]).to.equal(sender.peerId.toString())
		})
	})

	describe('FretService integration', () => {
		it('increments rejected.identityMismatch after a spoofed leave from a connected peer', async () => {
			const svc = new CoreFretService(recv, { profile: 'core', k: 7 })
			await svc.start()
			try {
				const before = svc.getDiagnostics().rejected.identityMismatch
				const spoofed: LeaveNoticeV1 = { v: 1, from: other.peerId.toString(), timestamp: Date.now() }
				await sendLeave(sender, recv.peerId.toString(), spoofed)
				await delay(400)
				const after = svc.getDiagnostics().rejected.identityMismatch
				expect(after - before, 'identityMismatch delta').to.equal(1)
			} finally {
				await svc.stop()
			}
		})
	})
})
