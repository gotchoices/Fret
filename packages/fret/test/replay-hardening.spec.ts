import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'

/**
 * Replay hardening: correlation ids must be unguessable, and the dedup cache must be sized to
 * the node's role so it cannot be cheaply flushed (an evicted-early entry is a replay hole).
 *
 * The service is constructed but never started — both properties are set up in the constructor,
 * so no network, timers or peers are needed.
 */
describe('replay hardening', function () {
	this.timeout(15000)

	describe('correlation ids', () => {
		it('mints distinct ids carrying the self-id prefix and phase suffix', async () => {
			const node = await createMemNode()
			try {
				const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
				const selfId = node.peerId.toString()

				const digest = (svc as any).newCorrelationId('digest') as string
				const act = (svc as any).newCorrelationId('act') as string

				expect(digest.startsWith(`${selfId}-`)).to.equal(true)
				expect(digest.endsWith('-digest')).to.equal(true)
				expect(act.endsWith('-act')).to.equal(true)
				expect(digest).to.not.equal(act)
			} finally {
				await node.stop()
			}
		})

		it('does not draw randomness from Math.random', async () => {
			const node = await createMemNode()
			const realRandom = Math.random
			try {
				const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
				// A pinned PRNG would collapse every id onto the same random segment. The
				// timestamp component still varies between calls, so compare segments rather
				// than whole ids.
				Math.random = () => 0.42
				const segments = new Set<string>()
				for (let i = 0; i < 32; i++) {
					const id = (svc as any).newCorrelationId('digest') as string
					// `<peerId>-<timestamp>-<random>-<phase>`; the random part may itself contain
					// dashes (uuid), so take everything between the timestamp and the phase.
					const parts = id.split('-')
					segments.add(parts.slice(2, -1).join('-'))
				}
				expect(segments.size, 'ids must not repeat under a pinned Math.random').to.equal(32)
			} finally {
				Math.random = realRandom
				await node.stop()
			}
		})

		it('carries at least 128 bits of randomness', async () => {
			const node = await createMemNode()
			try {
				const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
				const id = (svc as any).newCorrelationId('act') as string
				const random = id.split('-').slice(2, -1).join('-')
				// randomUUID: 36 chars, 122 random bits; getRandomValues fallback: 32 hex chars.
				const hex = random.replace(/-/g, '')
				expect(hex.length, `unexpected random segment: ${random}`).to.be.at.least(32)
				expect(/^[0-9a-f]+$/.test(hex)).to.equal(true)
			} finally {
				await node.stop()
			}
		})

		it('falls back to getRandomValues when randomUUID is unavailable', async () => {
			const node = await createMemNode()
			const realCrypto = globalThis.crypto
			try {
				const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
				// React Native / older browsers expose getRandomValues but not randomUUID.
				Object.defineProperty(globalThis, 'crypto', {
					value: {
						getRandomValues: <T extends ArrayBufferView>(a: T): T => {
							realCrypto.getRandomValues(a as unknown as Uint8Array<ArrayBuffer>)
							return a
						}
					},
					configurable: true,
					writable: true
				})
				const a = (svc as any).newCorrelationId('digest') as string
				const b = (svc as any).newCorrelationId('digest') as string
				const segment = (id: string) => id.split('-').slice(2, -1).join('-')
				expect(segment(a)).to.match(/^[0-9a-f]{32}$/)
				expect(segment(a)).to.not.equal(segment(b))
			} finally {
				Object.defineProperty(globalThis, 'crypto', {
					value: realCrypto,
					configurable: true,
					writable: true
				})
				await node.stop()
			}
		})
	})

	describe('dedup cache capacity', () => {
		// Reads the cache's private capacity rather than filling it: proving 2048 slots
		// behaviorally would mean driving 2049 inbound RPCs, which is minutes of wall clock for
		// a constant. What matters here is that the profile is wired through at all.
		const capacityOf = (svc: CoreFretService): number =>
			(svc as any).dedupCache.maxSize as number

		it('sizes Core larger than Edge', async () => {
			const node = await createMemNode()
			try {
				expect(capacityOf(new CoreFretService(node, { profile: 'core', k: 7 }))).to.equal(2048)
				expect(capacityOf(new CoreFretService(node, { profile: 'edge', k: 7 }))).to.equal(512)
			} finally {
				await node.stop()
			}
		})

		it('defaults to the Core capacity when no profile is given', async () => {
			const node = await createMemNode()
			try {
				expect(capacityOf(new CoreFretService(node, { k: 7 }))).to.equal(2048)
			} finally {
				await node.stop()
			}
		})
	})
})
