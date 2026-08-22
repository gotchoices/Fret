import { after, afterEach, before, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode, createMemoryNode, stopAll } from './helpers/libp2p.js'
import { sleep } from './helpers/rpc-fuzz.js'
import { decodeJson, encodeJson, registerRpcHandler, sendFramed } from '../src/rpc/protocols.js'
import { rpcRequest } from '../src/rpc/request.js'
import type { RpcOutcome } from '../src/rpc/outcome.js'

// The **outbound** arm of the stream-cap story: this node's own per-connection ceiling refusing a
// stream we tried to open. Its sibling `test/rpc.stream-caps.spec.ts` drives the *inbound* cap and
// asserts this arm only negatively (a remote's refusal must never read as `local-limit`); nothing
// anywhere positively drove `maxOutboundStreams` firing, which is the arm whose scoring rule —
// `local-limit` scores nothing: no contact strike, no relevance decay, no backoff — a regression
// would silently change.
//
// Where libp2p reads the limit from decides the whole rig. `Connection.newStream`
// (`libp2p/dist/src/connection.js`) calls `findOutgoingStreamLimit(protocol, registrar, options)`,
// which reads `maxOutboundStreams` off the **dialing** node's own registrar entry for that protocol
// — i.e. off its `node.handle` registration — or off a `maxOutboundStreams` in the `newStream`
// options bag. FRET's `openRpcStream` passes no such option, so the only lever is the registrar:
// the *requester* registers the protocol purely to declare its outbound cap, and its handler is
// never entered by anything. That reads as a mistake without this paragraph; it is the mirror image
// of the inbound case, which registers on the responder.
//
// Two further consequences of where that check sits, both load-bearing here:
//
//  - it compares `streamCount > outgoingLimit` over the connection's *outbound* streams for that
//    protocol, so the cap is per protocol **per connection** — the requester dials once up front
//    and every request reuses that one connection, exactly as the inbound case does. A second
//    connection would silently invalidate the case.
//  - it runs **after** `mss.select` has negotiated the protocol, so a refused stream has already
//    reached the responder and its handler may have been entered before the local abort. The
//    responder-side "entered" count therefore may exceed the admitted count, and this case
//    deliberately does not use it as an observable — the sender-side settled outcomes are what is
//    reliable on this arm. (The inbound case's `admitted + refused === CONCURRENT` convergence poll
//    is *not* reusable here for that reason.)

const NETWORK = 'stream-caps-outbound-test'
const PROTOCOL = `/optimystic/${NETWORK}/fret/1.0.0/capped-out`

/** Deliberately small, so N+2 concurrent streams is a handful rather than a load test. */
const MAX_OUTBOUND = 2
/** Two more than the cap, so the refused arm is plural and the admitted count is unambiguous. */
const CONCURRENT = 4
/**
 * Generously above `CONCURRENT`, so the responder's *inbound* cap provably cannot bind. Leaving it
 * at libp2p's default would let the two arms be conflated: an inbound refusal surfaces as
 * `decode-error` (see the sibling spec), so a run in which both caps fired would still look like a
 * clean split until someone read the kinds.
 */
const RESPONDER_MAX_INBOUND = 64

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
 * Both node factories, for the same reason the inbound case uses both: the cap is enforced by
 * libp2p's connection layer over the muxer's own stream collection, so pinning it on one transport
 * would pin one muxer's accounting rather than the behavior.
 */
const TRANSPORTS = [
	{ name: 'memory transport', make: createMemNode },
	{ name: 'tcp + noise', make: createMemoryNode },
] as const

for (const transport of TRANSPORTS) {
describe(`outbound stream caps (${transport.name})`, function () {
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
	const held = gate()

	before(async () => {
		responder = await transport.make(); await responder.start()
		requester = await transport.make(); await requester.start()
		responderId = responder.peerId.toString()

		await registerRpcHandler(responder, PROTOCOL, async (stream) => {
			await held.promise
			sendFramed(stream, encodeJson({ ok: true }))
		}, { maxInboundStreams: RESPONDER_MAX_INBOUND })

		// The rig's whole point: a handler registered on the **requester**, which never serves a
		// request, purely so libp2p's registrar has an outbound cap to read for this protocol.
		await registerRpcHandler(requester, PROTOCOL, async () => {
			throw new Error('the requester never serves this protocol')
		}, { maxOutboundStreams: MAX_OUTBOUND })

		// FRET dials by bare peer id, so the requester needs an address first. One dial: every
		// request below reuses this connection, which is what makes the per-connection cap bind.
		await requester.dial(responder.getMultiaddrs()[0]!)
	})

	after(async () => {
		held.open() // never leave a parked handler behind, even if the case failed early
		await stopAll([requester, responder])
	})

	it('refuses our own streams past the outbound cap and reports them as local-limit', async () => {
		const settled: Array<RpcOutcome<CappedReply>> = []
		const inflight = Array.from({ length: CONCURRENT }, () =>
			rpcRequest(requester, responderId, PROTOCOL, {
				decode: decodeCappedReply,
				maxBytes: 1024,
				timeoutMs: 4000,
			}).then((outcome) => { settled.push(outcome); return outcome })
		)

		// A refusal is raised **locally**, before any reply is waited on, so the refused requests
		// settle while the admitted ones are still parked on the gate — that gap is the only window
		// in which the cap is observably binding. Wait for the first refusal, then give stragglers a
		// moment; settling *more* than expected does not silently pass, since the count is asserted
		// exactly below.
		// NOTE: this is the one timing-shaped construct here, so it is where flake would appear on a
		// loaded CI box. If it ever does, raise the ceiling rather than replacing the poll with a
		// bare sleep.
		const until = Date.now() + 5000
		while (settled.length === 0 && Date.now() < until) await sleep(20)
		await sleep(200)

		const refused = settled.slice()

		// Observed, not derived: `newStream` counts the stream it is opening before comparing, so at
		// `maxOutboundStreams: 2` libp2p admitted exactly 2 concurrent outbound streams on this
		// protocol over one connection — the same shape the inbound case observed at its own cap.
		expect(refused.length, 'concurrent outbound streams refused past the cap')
			.to.equal(CONCURRENT - MAX_OUTBOUND)

		// The arm under test. `local-limit` is *our own* ceiling: `TooManyOutboundProtocolStreamsError`
		// out of `newStream`, matched by `isStreamLimitError` and mapped by `classify()` in
		// `src/rpc/request.ts`. It must never be `decode-error` — that is the inbound arm (a remote's
		// refusal reaching us as a truncated read), and asserting the kind is what keeps the two from
		// being conflated in either direction.
		for (const outcome of refused) {
			const detail = 'error' in outcome && outcome.error instanceof Error
				? ` (${outcome.error.name}: ${outcome.error.message})`
				: ''
			expect(outcome.kind, `our own outbound ceiling firing${detail}`).to.equal('local-limit')
		}

		held.open()
		const all = await Promise.all(inflight)
		expect(all.filter((o) => o.kind === 'ok').length, 'the admitted streams answered once released')
			.to.equal(MAX_OUTBOUND)
	})
})
}
