import { afterEach, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { Connection, Stream } from '@libp2p/interface'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { NETWORK, P } from './helpers/rpc-fuzz.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { registerRpcHandler } from '../src/index.js'

// The *profile split* half of the stream-cap story: which numbers FRET asks libp2p to enforce,
// and that a start->stop->start cycle re-applies them. Its sibling `test/rpc.stream-caps.spec.ts`
// owns the other half — that libp2p then actually enforces a cap, observed at a rigged cap of 2
// over a real transport. Neither subsumes the other: a spy here proves the value *reached*
// `node.handle` for every protocol on both profiles (which a two-node enforcement test cannot
// state without standing up ten connections), and the enforcement spec proves the value means
// something once it arrives (which a spy cannot see at all).
//
// Counting real `node.handle` calls, rather than reading the caps back off `FretService`, is what
// pins the split: `streamCaps()` is private and its return value is only meaningful if it is
// forwarded, and the forwarding is five separate spreads through four registrar functions.

/** What `registerJsonHandler` / `registerRpcHandler` forward into `node.handle`'s options. */
interface HandleOpts {
	maxInboundStreams?: number
	maxOutboundStreams?: number
}

interface Registration {
	protocol: string
	opts: HandleOpts | undefined
}

/**
 * Replace `node.handle` / `node.unhandle` with recorders and return the registration log.
 *
 * Both halves are stubbed, not only `handle`: nothing is ever registered with the real registrar,
 * so `stop()`'s `unhandle` of a protocol libp2p never saw is at best a no-op and at worst a throw.
 * Stubbing it keeps the lifecycle case measuring the service rather than the registrar's tolerance
 * for that.
 *
 * Nothing restores. Each case builds its own node in `beforeEach` and stops it in `afterEach`, and
 * a node whose `handle` is a recorder has no inbound handlers to tear down.
 */
function spyHandlers(node: Libp2p): { handled: Registration[]; unhandled: string[] } {
	const handled: Registration[] = []
	const unhandled: string[] = []
	const holder = node as unknown as {
		handle: (p: string | string[], h: unknown, o?: HandleOpts) => Promise<void>
		unhandle: (p: string | string[]) => Promise<void>
	}
	holder.handle = async (protocol, _handler, opts) => {
		for (const p of Array.isArray(protocol) ? protocol : [protocol]) handled.push({ protocol: p, opts })
	}
	holder.unhandle = async (protocol) => {
		for (const p of Array.isArray(protocol) ? protocol : [protocol]) unhandled.push(p)
	}
	return { handled, unhandled }
}

/** The five protocols `registerRpcHandlers` registers, in no particular order. */
const ALL_PROTOCOLS = [
	P.PROTOCOL_NEIGHBORS,
	P.PROTOCOL_NEIGHBORS_ANNOUNCE,
	P.PROTOCOL_MAYBE_ACT,
	P.PROTOCOL_LEAVE,
	P.PROTOCOL_PING,
]

// Pinned as literals rather than read back out of `FretService.streamCaps()`, so the expectation
// is not derived from the thing under test. These are the numbers `docs/fret.md` states under
// *Stream management*; a change to either must be a change here too.
const profiles: Array<{ profile: 'core' | 'edge'; caps: Required<HandleOpts> }> = [
	{ profile: 'core', caps: { maxInboundStreams: 128, maxOutboundStreams: 256 } },
	{ profile: 'edge', caps: { maxInboundStreams: 32, maxOutboundStreams: 64 } },
]

describe('RPC stream caps: profile split', function () {
	this.timeout(30000)

	let node: Libp2p

	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
	})

	afterEach(async () => { await stopAll([node]) })

	/**
	 * Assert the log carries exactly the five protocols, once each, all at `caps`.
	 *
	 * "Five distinct protocols" is asserted as a set rather than a count: `registerNeighbors`
	 * registers *two* of the five, and the announce one only when an `onAnnounce` callback is
	 * supplied. `FretService` always supplies one, so all five must appear — and if that ever
	 * stops being true, this is what catches it rather than a count that a duplicate could satisfy.
	 */
	function expectAllFiveAt(handled: Registration[], caps: Required<HandleOpts>): void {
		expect(handled.map((r) => r.protocol).sort(), 'all five protocols, once each').to.deep.equal(
			[...ALL_PROTOCOLS].sort()
		)
		for (const r of handled) {
			expect(r.opts, `${r.protocol}: registration options reached node.handle`).to.not.equal(undefined)
			expect(
				{ maxInboundStreams: r.opts!.maxInboundStreams, maxOutboundStreams: r.opts!.maxOutboundStreams },
				`${r.protocol}: stream caps`
			).to.deep.equal(caps)
		}
	}

	for (const { profile, caps } of profiles) {
		describe(profile, () => {
			it('passes its profile caps to node.handle for all five protocols', async () => {
				const svc = new CoreFretService(node, { profile, networkName: NETWORK })
				const { handled } = spyHandlers(node)

				// Private, and it is the whole subject: it computes `streamCaps()` once and passes
				// it as the last positional argument to all four registrars. Called directly rather
				// than via `start()` so the assertion is about registration alone — `start()` also
				// arms stabilization loops and seeds from the peerStore, none of which this case is
				// about. The lifecycle case below drives the real `start()`.
				await (svc as unknown as { registerRpcHandlers(): Promise<void> }).registerRpcHandlers()

				expectAllFiveAt(handled, caps)
			})

			it('re-applies the caps after a start -> stop -> start cycle', async () => {
				// The caps are applied inside `registerRpcHandlers`, which is on the `start()` path,
				// and `stop()` unhandles all five protocols. So a cap applied once at construction
				// would be silently dropped by this cycle — asserted rather than assumed.
				const svc = new CoreFretService(node, { profile, networkName: NETWORK })
				const { handled, unhandled } = spyHandlers(node)

				// Every assertion sits inside the try, so a failed one still stops the service:
				// `start()` arms the stabilization loop, and a leaked timer fails the repo's
				// mocha exit watchdog for the whole run rather than only this case.
				try {
					await svc.start()
					expectAllFiveAt(handled.splice(0), caps)

					await svc.stop()
					expect(unhandled.sort(), 'stop() unhandles all five').to.deep.equal([...ALL_PROTOCOLS].sort())
					expect(handled, 'stop() registers nothing').to.deep.equal([])

					await svc.start()
					expectAllFiveAt(handled.splice(0), caps)
				} finally {
					await svc.stop()
				}
			})
		})
	}

	it('leaves the caps absent when a caller omits them, so an external caller still compiles', async () => {
		// The "also confirm while you are here" arm. The new stream-cap fields are optional on the
		// root-exported inbound seam, so a consumer registering its own protocol over the same node
		// — the case `test/package-exports.spec.ts` guards the reachability of — needs no cap at all.
		// Optionality is a *compile-time* claim, so the value of this case is that it type-checks
		// with no cap fields present; the runtime assertion below is the second half, that omitting
		// them forwards `undefined` rather than fabricating a default.
		const { handled } = spyHandlers(node)

		await registerRpcHandler(
			node,
			'/external-consumer/1.0.0',
			async (_stream: Stream, _connection: Connection) => { /* never invoked */ },
			{}
		)

		expect(handled.length, 'one registration').to.equal(1)
		expect(handled[0]!.opts?.maxInboundStreams, 'no inbound cap requested').to.equal(undefined)
		expect(handled[0]!.opts?.maxOutboundStreams, 'no outbound cap requested').to.equal(undefined)
	})
})
