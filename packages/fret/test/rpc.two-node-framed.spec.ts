import { after, before, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { decodeJson, registerJsonHandler } from '../src/rpc/protocols.js'
import { rpcRequest } from '../src/rpc/request.js'

// End-to-end smoke test for the invariant the framed-read work exists to protect: **a reply that
// was really written is never reported as cut off.** The regression guard that landed drives
// `readFramed` against a stub stream at the seam; this drives the same invariant over a real
// libp2p transport with two in-memory nodes, one framed request and one framed reply per cell.
//
// **Smoke only, deliberately.** Every cell asserts that the outcome is `ok` — nothing here is
// keyed on *how many* microtasks a handler awaited before replying. The original failing cell was
// never stable across runs, so a depth-indexed assertion would pin scheduler behavior rather than
// the invariant and would flake. The depths exist to vary *when* the reply is written relative to
// the reader's first pull, not to be measured.
//
// Two axes:
//   - timing: the responder awaits 0, 1, 2 or 4 extra microtasks before returning its reply;
//   - shape: the reply carries a body, or is a bare acknowledgement.

/** Extra microtasks a responder awaits before returning — the timing axis. */
const MICROTASK_DEPTHS = [0, 1, 2, 4] as const

/** The shape axis: a reply carrying a payload field, and one that is a bare acknowledgement. */
const SHAPES = [
	{ name: 'with-body', withBody: true },
	{ name: 'no-body', withBody: false },
] as const

/** A reply cell's answer. `body` is absent for the no-body arm — `undefined` cannot travel. */
interface SmokeReplyV1 {
	ok: true
	cell: string
	body?: string
}

/** Big enough that a body-carrying frame is plainly a different length from a bare one. */
const BODY = 'x'.repeat(512)

function protocolFor(cell: string): string {
	return `/optimystic/two-node-smoke/fret/1.0.0/${cell}`
}

/**
 * Validating decoder — `rpcRequest`'s `decode` both selects the reply type and selects the
 * overload, so a real validator here is what keeps `ok.value` typed rather than `undefined`.
 */
async function decodeSmokeReply(bytes: Uint8Array): Promise<SmokeReplyV1> {
	const msg = await decodeJson<Partial<SmokeReplyV1>>(bytes)
	if (msg.ok !== true || typeof msg.cell !== 'string') throw new Error('not a smoke reply')
	return typeof msg.body === 'string'
		? { ok: true, cell: msg.cell, body: msg.body }
		: { ok: true, cell: msg.cell }
}

describe('framed request/reply over two real nodes', function () {
	// In-memory transport and handlers that do no work; the budget is for node start/stop, not
	// for the exchanges themselves.
	this.timeout(20000)

	let responder: Libp2p
	let requester: Libp2p
	let responderId: string

	before(async () => {
		responder = await createMemNode(); await responder.start()
		requester = await createMemNode(); await requester.start()
		responderId = responder.peerId.toString()

		for (const depth of MICROTASK_DEPTHS) {
			for (const shape of SHAPES) {
				const cell = `d${depth}-${shape.name}`
				// Reply-only: this protocol reads no request body at all, so the options bag has no
				// `parse` key — the absence is what TypeScript narrows the overload on.
				await registerJsonHandler<SmokeReplyV1>(responder, protocolFor(cell), {
					serve: async (): Promise<SmokeReplyV1> => {
						for (let i = 0; i < depth; i++) await Promise.resolve()
						return shape.withBody ? { ok: true, cell, body: BODY } : { ok: true, cell }
					},
				})
			}
		}

		// FRET dials by bare peer id, so the requester needs an address for the responder before
		// `rpcRequest` can reach it. One dial up front; every cell reuses the connection.
		await requester.dial(responder.getMultiaddrs()[0]!)
	})

	after(async () => { await stopAll([requester, responder]) })

	for (const depth of MICROTASK_DEPTHS) {
		for (const shape of SHAPES) {
			const cell = `d${depth}-${shape.name}`

			it(`answers ok for a reply written after ${depth} microtask(s), ${shape.name}`, async () => {
				const res = await rpcRequest(requester, responderId, protocolFor(cell), {
					decode: decodeSmokeReply,
				})

				// The whole assertion: a reply the responder really wrote came back as an answer,
				// never as `decode-error` (the false-truncation shape) or `timeout`.
				const detail = 'error' in res && res.error instanceof Error ? ` (${res.error.message})` : ''
				expect(res.kind, `${cell}: expected ok, got '${res.kind}'${detail}`).to.equal('ok')
				if (res.kind !== 'ok') return
				expect(res.value.cell, 'the answer is this cell’s reply').to.equal(cell)
				expect(res.value.body, 'the body arm round-trips its payload').to.equal(
					shape.withBody ? BODY : undefined
				)
			})
		}
	}
})
