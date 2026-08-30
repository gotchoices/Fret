import { after, afterEach, before, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Connection, Stream } from '@libp2p/interface'
import { assertLimited, createRelayTopology, type RelayTopology } from './helpers/relay.js'
import { stopAll } from './helpers/libp2p.js'
import { sleep } from './helpers/rpc-fuzz.js'
import { decodeJson, encodeJson, registerRpcHandler, sendFramed } from '../src/rpc/protocols.js'
import { rpcRequest } from '../src/rpc/request.js'

// Can a peer that is only reachable *through a relay* answer a FRET RPC?
//
// libp2p marks a relayed connection **limited** and refuses to run a protocol over it unless
// BOTH ends opted in for that protocol — the dialer through `NewStreamOptions`, the listener
// through the options the registrar stored for its handler. FRET opted in only when calling out,
// so a phone / browser / home-router peer could call every FRET protocol and answer none of them:
// connected, and unroutable, because the ring-maintenance and lookup RPCs are how a peer is found.
//
// **The negative control is what makes this test real.** A positive case alone would pass even if
// the connection were not actually limited — i.e. if the rig had quietly stopped testing the thing
// it is named after. So the same sender, over the same connection, is also pointed at a protocol
// registered with a *bare* `node.handle` (no opt-in). That arm must be refused. Two independent
// guards against a vacuous green:
//
//   1. `assertLimited` reads `connection.limits` on both ends — the exact field libp2p's inbound
//      gate tests — and throws if the connection turned out to be direct;
//   2. the bare control must be refused, which can only happen when the gate is engaged.
//
// Mutation results (run by hand, recorded here because a mutation nobody ran proves nothing):
//   - flipping `runOnLimitedConnection` to `false` in `handleOptions` reddens the positive case
//     (`decode-error`); the control stays green;
//   - adding `runOnLimitedConnection: true` to the bare control's `node.handle` reddens the
//     control; the positive case stays green;
//   - flipping `runOnLimitedConnection` to `false` in `openRpcStream` — the *sender* half —
//     reddens the positive case too (`unreachable`), since libp2p refuses at the dial.
//
// So both ends' opt-ins are covered, but only *jointly*: the positive case fails if either side
// loses its opt-in, and its `kind` is what tells them apart (`unreachable` = the dialer refused
// locally, `decode-error` = the listener tore the stream down). The two arms differ only in the
// listener's stored handler options, which is what attributes a green control to the receive side.

const NETWORK = 'relay-limited-test'
/** Registered through the seam under test — opts in for relayed traffic as a constant. */
const PROTOCOL_SEAM = `/optimystic/${NETWORK}/fret/1.0.0/seam`
/** Registered with a bare `node.handle` — the negative control; no opt-in. */
const PROTOCOL_BARE = `/optimystic/${NETWORK}/fret/1.0.0/bare`

interface Reply { ok: true }

function decodeReply(bytes: Uint8Array): Reply {
	const msg = decodeJson<Partial<Reply>>(bytes)
	if (msg.ok !== true) throw new Error('not a reply')
	return { ok: true }
}

describe('inbound RPC over a relayed (limited) connection', function () {
	// Three libp2p nodes, a reservation and a circuit dial — slower than the in-memory specs.
	this.timeout(60000)

	const unhandled: unknown[] = []
	const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }

	before(() => { process.on('unhandledRejection', onUnhandled) })
	after(() => { process.off('unhandledRejection', onUnhandled) })

	afterEach(async () => {
		await sleep(20) // detection is a tick behind the rejection
		const seen = unhandled.splice(0).map((r) => (r instanceof Error ? r.message : String(r)))
		expect(seen, 'unhandled rejection escaped').to.deep.equal([])
	})

	let topology: RelayTopology
	let dialerToListener: Connection
	const entered = { seam: 0, bare: 0 }

	before(async () => {
		topology = await createRelayTopology()
		const { listener, dialer } = topology

		await registerRpcHandler(listener, PROTOCOL_SEAM, async (stream) => {
			entered.seam++
			sendFramed(stream, encodeJson({ ok: true }))
		})

		// The control. Byte-for-byte the same handler body, registered the one way that does not
		// opt in — which is exactly what `registerRpcHandler` looked like before this fix.
		await listener.handle(PROTOCOL_BARE, async (stream: Stream) => {
			entered.bare++
			sendFramed(stream, encodeJson({ ok: true }))
		})

		dialerToListener = assertLimited(dialer, listener)
		// Both ends must agree the connection is limited: the gate that matters runs on the
		// *listener*, reading its own connection object, not the dialer's.
		assertLimited(listener, dialer)
	})

	after(async () => {
		await stopAll(topology?.all ?? [])
	})

	it('carries the connection as limited, with the relay default caps applied', () => {
		const limits = (dialerToListener as { limits?: { bytes?: bigint; seconds?: number } }).limits
		expect(limits, 'the relayed connection is limited').to.not.equal(undefined)
		// Not decoration: the ticket's stated tradeoff is that a deployment whose relays impose no
		// limits never meets this bug, because libp2p only gates connections it marked limited. So
		// the rig has to be running against a relay that *does* cap — libp2p's stock defaults, 2
		// minutes and 128 KiB. (They arrive as non-enumerable getters, so `deep.equal` on the
		// object would see `{}` and pass vacuously; read the fields.)
		expect(typeof limits?.bytes, 'a data cap is in force').to.equal('bigint')
		expect(typeof limits?.seconds, 'a duration cap is in force').to.equal('number')
	})

	it('reaches a handler registered through the seam', async () => {
		const before = entered.seam
		const outcome = await rpcRequest(topology.dialer, topology.listener.peerId.toString(), PROTOCOL_SEAM, {
			decode: decodeReply,
			maxBytes: 1024,
			timeoutMs: 15000,
		})

		expect(outcome.kind, 'the relayed RPC completed').to.equal('ok')
		if (outcome.kind === 'ok') expect(outcome.value).to.deep.equal({ ok: true })
		expect(entered.seam - before, 'the handler ran once').to.equal(1)
	})

	it('never reaches a handler registered without the opt-in (negative control)', async () => {
		const before = entered.bare
		const outcome = await rpcRequest(topology.dialer, topology.listener.peerId.toString(), PROTOCOL_BARE, {
			decode: decodeReply,
			maxBytes: 1024,
			timeoutMs: 15000,
		})

		// The refusal reason does not travel (libp2p aborts the muxed stream at the listener), so
		// what the sender books is a transport-shaped failure rather than a named one — asserting
		// on the *kind* here would pin a teardown shape that is libp2p's, not ours. What must hold
		// is that the request did not succeed and the handler never ran.
		expect(outcome.kind, 'the bare-registered protocol is refused over a limited connection')
			.to.not.equal('ok')
		expect(entered.bare - before, 'the bare handler never ran').to.equal(0)
	})
})
