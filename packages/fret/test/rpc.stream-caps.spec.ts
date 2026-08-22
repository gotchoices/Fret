import { after, afterEach, before, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode, createMemoryNode, stopAll } from './helpers/libp2p.js'
import { sleep } from './helpers/rpc-fuzz.js'
import { decodeJson, encodeJson, registerRpcHandler, sendFramed } from '../src/rpc/protocols.js'
import { rpcRequest } from '../src/rpc/request.js'
import type { RpcOutcome } from '../src/rpc/outcome.js'

// What `registerRpcHandler`'s `maxInboundStreams` actually does on the wire, and what the sender
// on the refused end actually sees. One case pins three things at once:
//
//  1. the caps reach `node.handle` at all — nothing else in the suite drives them;
//  2. the exact off-by-one — libp2p compares `streamCount > limit` over the connection's streams
//     filtered by protocol and direction, and whether the stream being admitted is already in
//     that collection at check time decides whether the cap admits `limit` or `limit + 1`. The
//     number below is written from what this test *observed*, never derived from libp2p's source;
//  3. what a remote's inbound refusal actually surfaces to the sender as — the residual recorded
//     at `classify()` in `src/rpc/request.ts` predicted `unreachable` (and therefore a contact
//     strike against a healthy-but-overloaded peer). Observed on both transports below it is
//     `decode-error`: the reason still does not travel, but the teardown reaches the sender as
//     end-of-stream rather than as a reset, so the read raises `FrameTruncationError` and the
//     service decays relevance without booking a strike. If a future libp2p version changes
//     either the reason's visibility or the teardown shape, this case fails and that residual
//     gets revisited.
//
// The cap is per protocol **per connection**, so the requester dials once up front and every
// request reuses that one connection — a second connection would silently invalidate the case.
// Holding N streams open at once needs a handler that parks: `serve` waits on a gate the test
// releases, and the sender passes a `decode` so it stays parked reading rather than returning
// `ok` right after the write.

const NETWORK = 'stream-caps-test'
const PROTOCOL = `/optimystic/${NETWORK}/fret/1.0.0/capped`

/** Deliberately small, so N+1 concurrent streams is a handful rather than a load test. */
const MAX_INBOUND = 2
/** Two more than the cap, so the refused arm is plural and the admitted count is unambiguous. */
const CONCURRENT = 4

/**
 * **Observed, not assumed.** The remote aborts the muxed stream at its cap, so the sender's read
 * ends before a frame arrives and `readFramed` raises `FrameTruncationError` — which `classify()`
 * maps to `decode-error`, not to the `unreachable` the residual note at `classify()` predicted.
 * The practical difference is what the service does with it: `noteRpcFailure` decays relevance for
 * a `decode-error` and books **no contact strike**, so a peer refusing at its inbound cap is not
 * escalated toward `dead` — the harm that note warns about does not occur on either transport
 * below. If a libp2p upgrade ever turns that teardown into a reset the sender reads as
 * `unreachable`, this constant is where it shows up.
 */
const REFUSED_KIND = 'decode-error'

interface CappedReply { ok: true }

function decodeCappedReply(bytes: Uint8Array): CappedReply {
	const msg = decodeJson<Partial<CappedReply>>(bytes)
	if (msg.ok !== true) throw new Error('not a capped reply')
	return { ok: true }
}

/** A gate the handler parks on, so every admitted stream is held open simultaneously. */
function gate(): { promise: Promise<void>; open: () => void } {
	let open = (): void => {}
	const promise = new Promise<void>((resolve) => { open = resolve })
	return { promise, open }
}

/**
 * Both node factories, because the answer to "what does the sender see" is a transport-layer
 * question: the refusal reason never travels, so what reaches the sender is whatever the muxer
 * turns the aborted stream into. Pinning it on the memory transport alone would pin one muxer's
 * teardown shape rather than the behavior.
 */
const TRANSPORTS = [
	{ name: 'memory transport', make: createMemNode },
	{ name: 'tcp + noise', make: createMemoryNode },
] as const

for (const transport of TRANSPORTS) {
describe(`inbound stream caps (${transport.name})`, function () {
	this.timeout(30000)

	// No case here may leak a rejection. Registered on this describe rather than at file top
	// level — a top-level hook is a *root* hook and would cover the whole suite. Its twins in the
	// sibling rpc specs are deliberately copies, not a shared import.
	const unhandled: unknown[] = []
	const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }

	before(() => { process.on('unhandledRejection', onUnhandled) })
	after(() => { process.off('unhandledRejection', onUnhandled) })

	afterEach(async () => {
		await sleep(20) // detection is a tick behind the rejection
		const seen = unhandled.splice(0).map((r) => (r instanceof Error ? r.message : String(r)))
		expect(seen, 'unhandled rejection escaped').to.deep.equal([])
	})

	let responder: Libp2p
	let requester: Libp2p
	let responderId: string
	let entered = 0
	const held = gate()

	before(async () => {
		responder = await transport.make(); await responder.start()
		requester = await transport.make(); await requester.start()
		responderId = responder.peerId.toString()

		await registerRpcHandler(responder, PROTOCOL, async (stream) => {
			entered++
			await held.promise
			sendFramed(stream, encodeJson({ ok: true }))
		}, { maxInboundStreams: MAX_INBOUND })

		// FRET dials by bare peer id, so the requester needs an address first. One dial: every
		// request below reuses this connection, which is what makes the per-connection cap bind.
		await requester.dial(responder.getMultiaddrs()[0]!)
	})

	after(async () => {
		held.open() // never leave a parked handler behind, even if the case failed early
		await stopAll([requester, responder])
	})

	it('refuses the streams past its cap and the sender reads the refusal as a truncated read', async () => {
		const settled: Array<RpcOutcome<CappedReply>> = []
		const inflight = Array.from({ length: CONCURRENT }, () =>
			rpcRequest(requester, responderId, PROTOCOL, {
				decode: decodeCappedReply,
				maxBytes: 1024,
				timeoutMs: 4000,
			}).then((outcome) => { settled.push(outcome); return outcome })
		)

		// Every request either reached the handler (admitted, and now parked on the gate) or has
		// already failed (refused). Polling that sum is what makes the split observable *while*
		// the admitted streams are still open — the only window in which the cap is binding.
		// NOTE: convergence wait, not a fixed sleep — but it is the one timing-shaped construct
		// here, so it is where flake would appear on a loaded CI box. Hitting the 5 s ceiling does
		// not silently pass: the `admitted + refused === CONCURRENT` assertion below fails loudly.
		// If it ever does flake, raise the ceiling rather than replacing the poll with a sleep.
		const until = Date.now() + 5000
		while (entered + settled.length < CONCURRENT && Date.now() < until) await sleep(20)

		const admitted = entered
		const refused = settled.slice()

		expect(admitted + refused.length, 'every request either entered the handler or failed')
			.to.equal(CONCURRENT)

		// Observed, not derived: at `maxInboundStreams: 2` libp2p admitted exactly 2 concurrent
		// inbound streams on this protocol over one connection.
		expect(admitted, 'concurrent inbound streams admitted at the cap').to.equal(MAX_INBOUND)
		expect(refused.length, 'the rest were refused').to.equal(CONCURRENT - MAX_INBOUND)

		// The residual: the remote's reason does not travel, so the refusal is indistinguishable
		// from any other reset. `local-limit` is the *outbound* arm (our own ceiling) and must not
		// appear here — asserting its absence is what keeps the two arms from being conflated.
		for (const outcome of refused) {
			const detail = 'error' in outcome && outcome.error instanceof Error
				? ` (${outcome.error.name}: ${outcome.error.message})`
				: ''
			expect(outcome.kind, `a remote inbound-cap refusal, as observed${detail}`).to.equal(REFUSED_KIND)
		}

		held.open()
		const all = await Promise.all(inflight)
		expect(all.filter((o) => o.kind === 'ok').length, 'the admitted streams answered once released')
			.to.equal(MAX_INBOUND)
	})
})
}
