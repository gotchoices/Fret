import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemoryNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { registerMaybeAct } from '../src/rpc/maybe-act.js'
import { registerPing, sendPing } from '../src/rpc/ping.js'
import { PROTOCOL_MAYBE_ACT, PROTOCOL_PING } from '../src/rpc/protocols.js'
import { validateTimestamp, readAllBounded } from '../src/rpc/protocols.js'

describe('Payload bounds and TTL validation', function () {
	this.timeout(15000)

	describe('validateTimestamp', () => {
		it('accepts timestamps within ±5 min', () => {
			expect(validateTimestamp(Date.now())).to.equal(true)
			expect(validateTimestamp(Date.now() - 60_000)).to.equal(true)
			expect(validateTimestamp(Date.now() + 60_000)).to.equal(true)
			expect(validateTimestamp(Date.now() - 299_000)).to.equal(true)
		})

		it('rejects timestamps outside ±5 min', () => {
			expect(validateTimestamp(Date.now() - 301_000)).to.equal(false)
			expect(validateTimestamp(Date.now() + 301_000)).to.equal(false)
			expect(validateTimestamp(Date.now() - 600_000)).to.equal(false)
		})

		it('supports custom drift window', () => {
			expect(validateTimestamp(Date.now() - 50_000, 30_000)).to.equal(false)
			expect(validateTimestamp(Date.now() - 10_000, 30_000)).to.equal(true)
		})
	})

	describe('readAllBounded', () => {
		it('reads data within limit', async () => {
			const data = new Uint8Array([1, 2, 3, 4, 5])
			async function* gen() { yield data }
			const result = await readAllBounded(gen(), 10)
			expect(result).to.deep.equal(data)
		})

		it('rejects data exceeding limit', async () => {
			const chunk = new Uint8Array(100)
			async function* gen() { yield chunk }
			try {
				await readAllBounded(gen(), 50)
				throw new Error('should have thrown')
			} catch (err: any) {
				expect(err.message).to.include('payload too large')
			}
		})

		it('rejects multi-chunk data exceeding limit', async () => {
			const chunk = new Uint8Array(30)
			async function* gen() { yield chunk; yield chunk; yield chunk }
			try {
				await readAllBounded(gen(), 50)
				throw new Error('should have thrown')
			} catch (err: any) {
				expect(err.message).to.include('payload too large')
			}
		})

		it('reads to completion across a >100ms gap between chunks', async () => {
			const first = new Uint8Array([1, 2, 3])
			const second = new Uint8Array([4, 5, 6])
			async function* gen() {
				yield first
				await new Promise(r => setTimeout(r, 150))
				yield second
			}
			const result = await readAllBounded(gen(), 100)
			expect(result).to.deep.equal(new Uint8Array([1, 2, 3, 4, 5, 6]))
		})

		it('throws when a stalled peer exhausts the overall deadline', async () => {
			async function* gen() {
				yield new Uint8Array([1, 2, 3])
				await new Promise(() => {}) // never yields again, never closes
			}
			const start = Date.now()
			try {
				await readAllBounded(gen(), 100, 200)
				throw new Error('should have thrown')
			} catch (err: any) {
				expect(err.message).to.include('read timed out')
				// A timeout must not masquerade as EOF: the partial buffer is never returned.
				expect(err.message).to.include('3 bytes read')
			}
			expect(Date.now() - start).to.be.lessThan(2000)
		})

		it('throws rather than truncating when the deadline expires mid-stream', async () => {
			async function* gen() {
				yield new Uint8Array([1, 2, 3])
				await new Promise(r => setTimeout(r, 300))
				yield new Uint8Array([4, 5, 6])
			}
			try {
				await readAllBounded(gen(), 100, 150)
				throw new Error('should have thrown')
			} catch (err: any) {
				expect(err.message).to.include('read timed out')
			}
		})

		it('returns an empty buffer when the peer closes without sending', async () => {
			async function* gen(): AsyncGenerator<Uint8Array> { /* immediate EOF */ }
			const result = await readAllBounded(gen(), 100)
			expect(result).to.deep.equal(new Uint8Array(0))
		})

		it('ends a real libp2p read promptly when the responder closes before we subscribe', async () => {
			// libp2p's async-iterator adaptor subscribes to the one-shot remoteCloseWrite
			// event when iteration STARTS, so a responder that closes first (the norm for a
			// small reply) leaves the iterator with no EOF to yield. Without the state poll
			// this read runs to the full deadline; assert it does not.
			const a = await createMemoryNode(); await a.start()
			const b = await createMemoryNode(); await b.start()
			try {
				await registerPing(a, PROTOCOL_PING)
				await b.dial(a.getMultiaddrs()[0]!)
				const start = Date.now()
				const res = await sendPing(b, a.peerId.toString(), PROTOCOL_PING)
				const elapsed = Date.now() - start
				expect(res.ok, 'ping answered').to.equal(true)
				expect(elapsed, `round-trip took ${elapsed}ms — read is stalling to its deadline`).to.be.lessThan(1000)
			} finally {
				await b.stop(); await a.stop()
			}
		})
	})

	describe('oversized payload at RPC layer', () => {
		it('rejects oversized maybeAct payload without crashing', async () => {
			const a = await createMemoryNode(); await a.start()
			await registerMaybeAct(
				a,
				async () => ({ v: 1 as const, anchors: [], cohort_hint: [], estimated_cluster_size: 1, confidence: 0 }),
				PROTOCOL_MAYBE_ACT,
				256
			)
			const b = await createMemoryNode(); await b.start()
			await b.dial(a.getMultiaddrs()[0]!)

			const stream = await b.dialProtocol(a.peerId, [PROTOCOL_MAYBE_ACT])
			const oversized = new Uint8Array(512).fill(65)
			stream.send(oversized)
			await stream.close()
			// handler should log error and not crash
			const timer = setTimeout(() => { try { stream.abort(new Error('timeout')) } catch {} }, 1000)
			try { for await (const _ of stream) break } catch {}
			clearTimeout(timer)
			await b.stop(); await a.stop()
		})
	})

	describe('timestamp bounds in handleMaybeAct', () => {
		it('rejects stale timestamp and increments diagnostic', async () => {
			const nodes = []
			for (let i = 0; i < 2; i++) {
				const n = await createMemoryNode(); await n.start(); nodes.push(n)
			}
			await nodes[1]!.dial(nodes[0]!.getMultiaddrs()[0]!)

			const svc = new CoreFretService(nodes[0]!, { profile: 'edge', k: 7 })
			await svc.start()
			await new Promise(r => setTimeout(r, 500))

			const msg = {
				v: 1 as const,
				key: 'aWQ',
				want_k: 7,
				ttl: 3,
				min_sigs: 3,
				breadcrumbs: [] as string[],
				correlation_id: 'c3RhbGU',
				timestamp: Date.now() - 600_000, // 10 min in past
				signature: ''
			}

			const result = await (svc as any).handleMaybeAct(msg)
			// Should return a NearAnchor (rejected via nearAnchorOnly)
			expect(result).to.have.property('anchors')

			const diag = svc.getDiagnostics()
			expect((diag as any).rejected.timestampBounds).to.be.greaterThan(0)

			await svc.stop()
			await stopAll(nodes)
		})

		it('rejects future timestamp', async () => {
			const node = await createMemoryNode(); await node.start()
			const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
			await svc.start()
			await new Promise(r => setTimeout(r, 300))

			const msg = {
				v: 1 as const,
				key: 'aWQ',
				want_k: 7,
				ttl: 3,
				min_sigs: 3,
				breadcrumbs: [] as string[],
				correlation_id: 'ZnV0dXJl',
				timestamp: Date.now() + 600_000, // 10 min in future
				signature: ''
			}

			const result = await (svc as any).handleMaybeAct(msg)
			expect(result).to.have.property('anchors')

			await svc.stop(); await node.stop()
		})
	})

	describe('TTL ≤ 0 rejection', () => {
		it('rejects msg with ttl=0 and increments diagnostic', async () => {
			const node = await createMemoryNode(); await node.start()
			const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
			await svc.start()
			await new Promise(r => setTimeout(r, 300))

			const msg = {
				v: 1 as const,
				key: 'aWQ',
				want_k: 7,
				ttl: 0,
				min_sigs: 3,
				breadcrumbs: [] as string[],
				correlation_id: 'dHRs',
				timestamp: Date.now(),
				signature: ''
			}

			const result = await (svc as any).handleMaybeAct(msg)
			expect(result).to.have.property('anchors')

			const diag = svc.getDiagnostics()
			expect((diag as any).rejected.ttlExpired).to.be.greaterThan(0)

			await svc.stop(); await node.stop()
		})
	})

	describe('rate limit busy response', () => {
		it('returns BusyResponseV1 when maybeAct bucket exhausted', async () => {
			const node = await createMemoryNode(); await node.start()
			const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
			await svc.start()
			await new Promise(r => setTimeout(r, 300))

			// Drain the maybeAct bucket
			const bucket = (svc as any).bucketMaybeAct
			while (bucket.tryTake()) { /* drain */ }

			const msg = {
				v: 1 as const,
				key: 'aWQ',
				want_k: 7,
				ttl: 3,
				min_sigs: 3,
				breadcrumbs: [] as string[],
				correlation_id: 'cmF0ZQ',
				timestamp: Date.now(),
				signature: ''
			}

			const result = await (svc as any).handleMaybeAct(msg)
			expect(result).to.have.property('busy', true)
			expect(result).to.have.property('retry_after_ms')
			expect(result.retry_after_ms).to.be.a('number')
			expect(result.retry_after_ms).to.be.greaterThan(0)

			const diag = svc.getDiagnostics()
			expect((diag as any).rejected.rateLimited).to.be.greaterThan(0)

			await svc.stop(); await node.stop()
		})

		it('returns BusyResponseV1 when neighbors bucket exhausted', async () => {
			const node = await createMemoryNode(); await node.start()
			const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
			await svc.start()
			await new Promise(r => setTimeout(r, 300))

			// Drain the neighbors bucket
			const bucket = (svc as any).bucketNeighbors
			while (bucket.tryTake()) { /* drain */ }

			const result = await (svc as any).handleNeighborsRequest()
			expect(result).to.have.property('busy', true)
			expect(result).to.have.property('retry_after_ms')

			await svc.stop(); await node.stop()
		})
	})

	describe('valid message passes through', () => {
		it('processes valid maybeAct message normally', async () => {
			const node = await createMemoryNode(); await node.start()
			const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
			await svc.start()
			await new Promise(r => setTimeout(r, 300))

			const msg = {
				v: 1 as const,
				key: 'aWQ',
				want_k: 7,
				ttl: 3,
				min_sigs: 3,
				breadcrumbs: [] as string[],
				correlation_id: 'dmFsaWQ',
				timestamp: Date.now(),
				signature: ''
			}

			const result = await (svc as any).handleMaybeAct(msg)
			// Should get a NearAnchor with valid response (not busy, not rejected)
			expect(result).to.have.property('anchors')
			expect(result).to.not.have.property('busy')

			await svc.stop(); await node.stop()
		})
	})

	describe('rejection diagnostics', () => {
		it('tracks multiple rejection types independently', async () => {
			const node = await createMemoryNode(); await node.start()
			const svc = new CoreFretService(node, { profile: 'edge', k: 7 })
			await svc.start()
			await new Promise(r => setTimeout(r, 300))

			// Trigger timestamp rejection
			await (svc as any).handleMaybeAct({
				v: 1, key: 'aWQ', want_k: 7, ttl: 3, min_sigs: 3,
				breadcrumbs: [], correlation_id: 'dHMx',
				timestamp: Date.now() - 600_000, signature: ''
			})

			// Trigger TTL rejection
			await (svc as any).handleMaybeAct({
				v: 1, key: 'aWQ', want_k: 7, ttl: 0, min_sigs: 3,
				breadcrumbs: [], correlation_id: 'dHRsMQ',
				timestamp: Date.now(), signature: ''
			})

			const diag = svc.getDiagnostics() as any
			expect(diag.rejected.timestampBounds).to.equal(1)
			expect(diag.rejected.ttlExpired).to.equal(1)

			await svc.stop(); await node.stop()
		})
	})
})
