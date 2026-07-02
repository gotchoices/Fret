import { describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { Connection, PeerId, Stream } from '@libp2p/interface'
import { openRpcStream, isLimitedConnection } from '../src/rpc/protocols.js'

// Minimal recording stubs. openRpcStream only touches `node.getConnections`,
// `node.dialProtocol`, and per-connection `{ status, limits, remoteAddr,
// newStream }`, so no real transport / relay is needed.

interface StreamOpts {
	runOnLimitedConnection?: unknown
	negotiateFully?: unknown
}

interface StubConnection {
	status: string
	limits?: unknown
	remoteAddr?: { toString(): string }
	newStream?: (protocols: string[], opts: StreamOpts) => Promise<Stream>
	// recording spy: every newStream call is appended here
	calls: Array<{ protocols: string[]; opts: StreamOpts }>
}

function makeConnection(opts: {
	status?: string
	limited?: boolean
	remoteAddr?: string | null
	hasNewStream?: boolean
}): StubConnection {
	const calls: StubConnection['calls'] = []
	const conn: StubConnection = {
		status: opts.status ?? 'open',
		limits: opts.limited ? { bytes: 1024 } : undefined,
		remoteAddr: opts.remoteAddr === null
			? undefined
			: { toString: () => opts.remoteAddr ?? '/ip4/1.2.3.4/tcp/4001' },
		calls,
	}
	if (opts.hasNewStream !== false) {
		conn.newStream = async (protocols, streamOpts) => {
			calls.push({ protocols, opts: streamOpts })
			return { id: 'stub-stream' } as unknown as Stream
		}
	}
	return conn
}

function makeNode(connections: StubConnection[]): {
	node: Libp2p
	dialCalls: Array<{ protocols: string[]; opts: StreamOpts }>
} {
	const dialCalls: Array<{ protocols: string[]; opts: StreamOpts }> = []
	const node = {
		getConnections: (_pid?: PeerId) => connections as unknown as Connection[],
		dialProtocol: async (_pid: PeerId, protocols: string[], opts: StreamOpts) => {
			dialCalls.push({ protocols, opts })
			return { id: 'dialed-stream' } as unknown as Stream
		},
	}
	return { node: node as unknown as Libp2p, dialCalls }
}

const PID = { toString: () => 'stub-peer' } as unknown as PeerId
const PROTOCOLS = ['/optimystic/test/fret/1.0.0/ping']

// asserts on the runOnLimitedConnection key specifically rather than deep-equal
// on the whole opts object, so an unrelated future stream option won't break this
function expectRunsOnLimited(opts: StreamOpts, ctx: string): void {
	expect(opts.runOnLimitedConnection, `${ctx}: runOnLimitedConnection`).to.be.ok
}

describe('openRpcStream', () => {
	it('opens on a limited-only connection with runOnLimitedConnection (headline regression guard)', async () => {
		const limited = makeConnection({ limited: true })
		const { node } = makeNode([limited])

		const stream = await openRpcStream(node, PID, PROTOCOLS)

		expect(stream, 'stream').to.exist
		expect(limited.calls.length, 'limited newStream calls').to.equal(1)
		expect(limited.calls[0].protocols).to.deep.equal(PROTOCOLS)
		expectRunsOnLimited(limited.calls[0].opts, 'limited-only')
	})

	it('prefers the direct connection when both direct and limited are open', async () => {
		const direct = makeConnection({ limited: false })
		const limited = makeConnection({ limited: true })
		const { node } = makeNode([limited, direct]) // limited listed first on purpose

		await openRpcStream(node, PID, PROTOCOLS)

		expect(direct.calls.length, 'direct newStream calls').to.equal(1)
		expect(limited.calls.length, 'limited newStream calls').to.equal(0)
		expectRunsOnLimited(direct.calls[0].opts, 'direct-preferred')
	})

	it('ignores closed connections, opening on the open-limited one', async () => {
		const closedDirect = makeConnection({ status: 'closed', limited: false })
		const openLimited = makeConnection({ limited: true })
		const { node } = makeNode([closedDirect, openLimited])

		await openRpcStream(node, PID, PROTOCOLS)

		expect(closedDirect.calls.length, 'closed-direct newStream calls').to.equal(0)
		expect(openLimited.calls.length, 'open-limited newStream calls').to.equal(1)
	})

	it('ignores a connection with no newStream, opening on the open-limited one', async () => {
		const noStreamDirect = makeConnection({ limited: false, hasNewStream: false })
		const openLimited = makeConnection({ limited: true })
		const { node } = makeNode([noStreamDirect, openLimited])

		await openRpcStream(node, PID, PROTOCOLS)

		expect(openLimited.calls.length, 'open-limited newStream calls').to.equal(1)
	})

	it('returns undefined without dialing when requireExisting and no connection', async () => {
		const { node, dialCalls } = makeNode([])

		const stream = await openRpcStream(node, PID, PROTOCOLS, { requireExisting: true })

		expect(stream, 'stream').to.equal(undefined)
		expect(dialCalls.length, 'dialProtocol calls').to.equal(0)
	})

	it('falls through to dialProtocol (with runOnLimitedConnection) when no connection and not requireExisting', async () => {
		const { node, dialCalls } = makeNode([])

		await openRpcStream(node, PID, PROTOCOLS)

		expect(dialCalls.length, 'dialProtocol calls').to.equal(1)
		expect(dialCalls[0].protocols).to.deep.equal(PROTOCOLS)
		expectRunsOnLimited(dialCalls[0].opts, 'dial fallback')
	})
})

describe('isLimitedConnection', () => {
	function asConn(c: StubConnection): Connection {
		return c as unknown as Connection
	}

	it('is true when limits is set (primary signal)', () => {
		expect(isLimitedConnection(asConn(makeConnection({ limited: true })))).to.equal(true)
	})

	it('is true when remoteAddr contains /p2p-circuit (multiaddr fallback)', () => {
		const c = makeConnection({ limited: false, remoteAddr: '/ip4/1.2.3.4/tcp/4001/p2p-circuit' })
		expect(isLimitedConnection(asConn(c))).to.equal(true)
	})

	it('is false for a plain non-circuit remoteAddr with no limits', () => {
		const c = makeConnection({ limited: false, remoteAddr: '/ip4/1.2.3.4/tcp/4001' })
		expect(isLimitedConnection(asConn(c))).to.equal(false)
	})

	it('is false (no throw) when remoteAddr is absent and limits is null', () => {
		const c = makeConnection({ limited: false, remoteAddr: null })
		expect(isLimitedConnection(asConn(c))).to.equal(false)
	})
})
