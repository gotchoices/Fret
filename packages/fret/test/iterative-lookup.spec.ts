import { describe, it } from 'mocha'
import { expect } from 'chai'
import { starMesh, type Mesh } from './helpers/mesh.js'
import type { RouteProgress } from '../src/index.js'
import { hashKey, hashPeerId } from '../src/ring/hash.js'
import { lexLess, minDistance } from '../src/ring/distance.js'
import { fromString as u8FromString } from 'uint8arrays/from-string'

// This file covers the *client-side* driver, `iterativeLookup`. Two neighbouring behaviours used
// to be tested here through `routeAct`, which is the wrong entry point for both — the guards they
// name live in `handleMaybeAct`, one layer above `routeAct`. They are pinned properly elsewhere,
// so do not re-add them here:
//   - breadcrumb-loop rejection → `pick-anchors.spec.ts` ("the breadcrumb-loop reply is a static
//     rejection, not a ring walk"), which drives `handleMaybeAct` and asserts the empty static shape.
//   - correlation-id dedup → the whole of `maybeact-dedup-phases.spec.ts`, which sends over the
//     wire because `routeAct` alone never touches the dedup cache.

/**
 * `n` in-memory nodes, services started BEFORE the star is dialed so each `peer:connect` handler
 * fires.
 *
 * Every case below tears the mesh down from a `finally`, so a failed assertion reports *itself*
 * rather than being buried under the exit watchdog's open-handle dump for the nodes the throw
 * skipped past. `mesh.stop()` settles each service stop rather than `Promise.all`ing them for the
 * same reason: one rejecting stop must not strand the other services or the nodes underneath them.
 */
const makeMesh = (n: number): Promise<Mesh> => starMesh(n)

describe('Iterative lookup', function () {
	this.timeout(25000)

	// `exhausted` is the *unconditional* terminal event: only `complete` returns early from the
	// attempt loop, every other path falls out of it and yields `exhausted`. And a digest-only
	// lookup can never yield `complete`, which needs a commit certificate. So the terminal event is
	// deterministic here, not a three-way choice.
	it('a digest-only probe ends exhausted, never completes, and collects real anchors', async () => {
		const mesh = await makeMesh(3)
		const { nodes, services } = mesh
		await new Promise(r => setTimeout(r, 2000))

		try {
			const otherIds = nodes.slice(1).map(n => n.peerId.toString())
			const key = u8FromString('test-key')
			const events: RouteProgress[] = []
			for await (const evt of services[0]!.iterativeLookup(key, {
				wantK: 7,
				minSigs: 3,
				digest: 'Zg',
				ttl: 3,
			})) {
				events.push(evt)
			}

			const types = events.map(e => e.type)
			const trail = types.join(' -> ')
			expect(types[types.length - 1], `terminal event; trail: ${trail}`).to.equal('exhausted')
			expect(types, `no activity to complete; trail: ${trail}`).to.not.include('complete')

			const probing = events.filter(e => e.type === 'probing')
			expect(probing.length, `the lookup actually probed someone; trail: ${trail}`).to.be.greaterThan(0)
			for (const p of probing) {
				expect(otherIds, 'a probe only ever targets another node').to.include(p.peerId!)
			}

			// Each responder is in-cluster on a three-node ring (k=7 > n=3), so it answers with real
			// hints rather than the empty `staticReject` shape.
			const anchored = events.filter(e => e.type === 'near_anchor')
			expect(anchored.length, `expected a near_anchor; trail: ${trail}`).to.be.greaterThan(0)
			const substantive = anchored.filter(
				e => (e.nearAnchor?.anchors.length ?? 0) > 0 && (e.nearAnchor?.cohort_hint.length ?? 0) > 0
			)
			expect(substantive.length, 'an in-cluster responder returns real anchors and a cohort hint').to.be.greaterThan(0)
		} finally {
			await mesh.stop()
		}
	})

	// The payload-inclusion heuristic may put the activity on the very first probe, in which case
	// the lookup completes at hop 0 with no `activity_sent` event at all. So this asserts the
	// invocation count and the returned certificate, never a specific event sequence.
	it('runs the activity on exactly one peer, and never on the initiator', async () => {
		const mesh = await makeMesh(3)
		const { services } = mesh
		await new Promise(r => setTimeout(r, 2000))

		try {
			const fired = services.map(() => 0)
			services.forEach((svc, i) => {
				svc.setActivityHandler(async (_activity, _cohort, _minSigs, _corrId) => {
					fired[i]!++
					return { commitCertificate: 'cert-ok' }
				})
			})

			const key = u8FromString('act-key')
			const events: string[] = []
			let completed: { commitCertificate: string } | undefined
			for await (const evt of services[0]!.iterativeLookup(key, {
				wantK: 7,
				minSigs: 3,
				activity: 'payload-data',
				ttl: 4,
			})) {
				events.push(evt.type)
				if (evt.type === 'complete') completed = evt.result
			}

			const trail = events.join(' -> ')
			expect(completed?.commitCertificate, `lookup did not complete; trail: ${trail}`).to.equal('cert-ok')
			// One peer performs the work and the certificate travels back; a forwarding hop must not
			// re-run it, and a replayed activity is answered from that peer's dedup cache.
			expect(fired.reduce((a, b) => a + b, 0), `total handler invocations; trail: ${trail}`).to.equal(1)
			// `iterativeLookup` never performs the activity locally — it seeds `visited` with self and
			// always sends.
			expect(fired[0], 'the initiator never runs the activity itself').to.equal(0)
		} finally {
			await mesh.stop()
		}
	})

	// Near-mode routing requires a hop to be strictly closer to the key than the sender, so a
	// forwarded message can never drift backwards. That rule is for *forwarding*: a lookup we
	// originate is aiming at the key's cluster, and when we are the peer nearest the key every
	// cluster member is farther from it than we are. Applying the rule here refuses to send at
	// all and the activity is silently never performed.
	it('still delivers activity when the initiator is the peer nearest the key', async () => {
		const mesh = await makeMesh(2)
		const { nodes, services } = mesh
		await new Promise(r => setTimeout(r, 2000))

		try {
			const selfCoord = await hashPeerId(nodes[0]!.peerId)
			const peerCoord = await hashPeerId(nodes[1]!.peerId)
			// Peer ids are random per run, so search for a key the initiator is strictly nearest to
			// rather than hoping the coin lands that way.
			let key: Uint8Array | undefined
			for (let i = 0; i < 256 && !key; i++) {
				const candidate = u8FromString(`nearest-initiator-${i}`)
				const coord = await hashKey(candidate)
				if (lexLess(minDistance(selfCoord, coord), minDistance(peerCoord, coord))) key = candidate
			}
			expect(key, 'a key the initiator is strictly nearest to').to.not.equal(undefined)

			let fired = 0
			services[1]!.setActivityHandler(async () => {
				fired++
				return { commitCertificate: 'cert-initiator-nearest' }
			})

			const events: string[] = []
			let completed: { commitCertificate: string } | undefined
			for await (const evt of services[0]!.iterativeLookup(key!, {
				wantK: 7,
				minSigs: 1,
				digest: 'Zg',
				activity: 'payload-data',
				ttl: 3,
			})) {
				events.push(evt.type)
				if (evt.type === 'complete') completed = evt.result
			}

			const trail = events.join(' -> ')
			expect(completed?.commitCertificate, `lookup did not complete; trail: ${trail}`).to.equal('cert-initiator-nearest')
			expect(fired, `the activity ran exactly once; trail: ${trail}`).to.equal(1)
		} finally {
			await mesh.stop()
		}
	})
})
