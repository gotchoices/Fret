import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { PeerId } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { buildMaintenanceRig, type MaintenanceRig } from './helpers/maintenance-rig.js'
import { FretService } from '../src/service/fret-service.js'
import type { DigitreeStore } from '../src/store/digitree-store.js'

// Scoring never creates.
//
// `applyTouch` / `applySuccess` / `applyFailure` all open with `getById(id); if (!entry) return`,
// so bookkeeping *about* a peer can never re-admit it. The rule exists for one concrete sequence:
// a peer is removed from the table (today: evicted at capacity; a leave notice used to remove one
// too, and now marks it `dead` instead), its connection closes later, and the `peer:disconnect`
// listener's `applyFailure` used to bring it straight back as an unclassified stranger the
// classification pass then spent probes on.
//
// These tests drive the rule through real call sites — a dispatched `peer:connect` /
// `peer:disconnect`, and a pooled maintenance ping — rather than reaching in and calling the
// private helpers. A test that casts to `any` pins the method's *shape*; the shape is not the
// contract, the behaviour at the call site is.
//
// NOTE: `applyTouch`'s never-create arm has no directly reachable call site: both of its callers
// (`peer:connect`, `mergeAnnounceSnapshot`) `upsert` the id synchronously immediately before
// scoring it, so the entry provably exists by the time the guard runs. Its guard is
// defence-in-depth against a removal landing in that window, and it is covered here only on the
// entry-exists arm. The two helpers whose callers *can* present an absent id — `applyFailure`
// from `peer:disconnect`, and `applySuccess` from a probe whose target was removed mid-flight —
// are covered directly.
//
// The same reasoning covers the two guards behind those helpers, which is why neither gets an arm
// of its own here. `applyContactStrike` has exactly one caller, `applyContactFailure`, which
// reaches it *past* `applyFailure`'s guard and so must carry the rule itself — but only for an id
// `applyContactFailure` was handed, and every one of those comes from a store-derived probe target.
// `noteProofOfLife`'s four callers likewise cannot present an absent id: `applySuccess` calls it
// from inside its own guard, `noteInboundRpc` and the `peer:connect` listener each `upsert`
// synchronously one line before, and `noteAnsweredOnProtocol` is only ever reached from an RPC
// outcome whose target came out of the store. Both guards are the same defence-in-depth against a
// mid-flight removal that `applyTouch`'s is. Do not file a coverage finding against either without
// first showing a caller that can present an id the store does not hold.

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

/** Poll until `pred` holds, or give up after `timeoutMs`. The node listeners are `async` and
 * nothing awaits them, so a dispatched event cannot be asserted on synchronously. */
async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!pred()) {
		if (Date.now() > deadline) return
		await sleep(5)
	}
}

async function freshPeerId(): Promise<PeerId> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
}

describe('Scoring never creates a routing-table entry', () => {
	describe('through the peer:disconnect listener', () => {
		let node: Libp2p
		let svc: FretService
		let store: DigitreeStore

		beforeEach(async () => {
			node = await createMemNode()
			await node.start()
			// The `peer:disconnect` listener is registered by `start()`; an unstarted service has
			// no listener at all, so this rig cannot be the shared unstarted one.
			svc = new FretService(node, { profile: 'edge', networkName: 'net-scoring' })
			await svc.start()
			store = svc.getStore()
		})

		afterEach(async () => {
			try { await svc.stop() } catch { /* teardown is best-effort */ }
			await stopAll([node])
		})

		it('does not re-admit a peer the table has never held', async () => {
			const pid = await freshPeerId()
			const id = pid.toString()
			const sizeBefore = store.size()
			expect(store.getById(id), 'precondition: peer is absent').to.equal(undefined)

			node.dispatchEvent(new CustomEvent('peer:disconnect', { detail: pid }))

			// Nothing observable is produced by a no-op, so wait out the listener rather than
			// waiting *for* it, then assert the absence held.
			await sleep(100)
			expect(store.getById(id), 'scoring an unknown id must not create it').to.equal(undefined)
			expect(store.size()).to.equal(sizeBefore)
		})

		it('does not resurrect a peer that was removed while connected', async () => {
			const pid = await freshPeerId()
			const id = pid.toString()

			// `peer:connect` is a real creation site — it upserts, then scores through
			// `applyTouch`. That is the arm the never-create rule deliberately leaves intact.
			node.dispatchEvent(new CustomEvent('peer:connect', { detail: pid }))
			await until(() => store.getById(id) !== undefined)
			const created = store.getById(id)
			expect(created, 'peer:connect creates the entry').to.not.equal(undefined)
			expect(created!.accessCount, 'applyTouch credits proven contact').to.be.greaterThan(0)

			// The eviction sequence in miniature: the entry goes, then the connection closes.
			store.remove(id)
			expect(store.getById(id)).to.equal(undefined)
			const sizeAfterRemoval = store.size()

			node.dispatchEvent(new CustomEvent('peer:disconnect', { detail: pid }))
			await sleep(100)

			expect(store.getById(id), 'a disconnect must not bring a removed peer back').to.equal(undefined)
			expect(store.size()).to.equal(sizeAfterRemoval)
		})

		it('still scores a peer the table does hold', async () => {
			const pid = await freshPeerId()
			const id = pid.toString()

			node.dispatchEvent(new CustomEvent('peer:connect', { detail: pid }))
			await until(() => store.getById(id) !== undefined)

			node.dispatchEvent(new CustomEvent('peer:disconnect', { detail: pid }))
			await until(() => (store.getById(id)?.failureCount ?? 0) > 0)

			const entry = store.getById(id)
			expect(entry, 'the entry survives being scored').to.not.equal(undefined)
			expect(entry!.failureCount, 'applyFailure still lands on an existing entry').to.be.greaterThan(0)
		})
	})

	describe('through a pooled maintenance probe', () => {
		let rig: MaintenanceRig

		afterEach(async () => {
			if (rig != null) await rig.teardown()
		})

		it('does not resurrect a peer removed while its ping is in flight', async () => {
			rig = await buildMaintenanceRig('core')
			const [id] = await rig.seedPeers(1, 'member')
			// Hold the stub reply open long enough to remove the entry between the ping being
			// issued and its outcome being scored — the window `applySuccess`'s guard covers.
			rig.rig.holdMs = 120

			const tick = (rig.svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce()
			await sleep(30)
			rig.store.remove(id!)
			expect(rig.store.getById(id!), 'precondition: removed mid-flight').to.equal(undefined)

			await tick

			expect(rig.store.getById(id!), 'a completed ping must not re-admit a removed peer').to.equal(undefined)
			expect(rig.store.size()).to.equal(0)
		})

		it('still scores a peer that is present when its ping completes', async () => {
			rig = await buildMaintenanceRig('core')
			const [id] = await rig.seedPeers(1, 'member')

			await (rig.svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce()

			const entry = rig.store.getById(id!)
			expect(entry, 'the peer is still held').to.not.equal(undefined)
			expect(entry!.successCount, 'applySuccess still lands on an existing entry').to.be.greaterThan(0)
		})
	})
})
