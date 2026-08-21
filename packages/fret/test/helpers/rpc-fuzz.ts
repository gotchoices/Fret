import type { Connection, Stream } from '@libp2p/interface'
import type { Uint8ArrayList } from 'uint8arraylist'
import * as lp from 'it-length-prefixed'
import { toString as u8ToString } from 'uint8arrays/to-string'
import { coordToBase64url } from '../../src/ring/hash.js'
import { makeProtocols } from '../../src/rpc/protocols.js'

const enc = new TextEncoder()

export const NETWORK = 'fuzz-test'
export const P = makeProtocols(NETWORK)

/**
 * A parseable Ed25519 peer id string built from `seed`: an identity multihash (0x00, len 0x24)
 * over a protobuf-encoded public key (0x08 0x01 0x12 0x20 + 32 key bytes), base58btc-encoded.
 * The bytes need not be a real curve point — `peerIdFromString` parses, it does not verify —
 * but they must be *shaped* like a peer id, because the wire-shape parsers reject a `from`
 * that will not parse before any handler-level identity check runs.
 */
export function peerIdStr(seed: number): string {
	const mh = new Uint8Array(38)
	mh.set([0x00, 0x24, 0x08, 0x01, 0x12, 0x20], 0)
	mh.fill(seed, 6)
	return u8ToString(mh, 'base58btc')
}

/**
 * A valid 32-byte ring coordinate for a sample entry — any repeated-byte fill decodes cleanly.
 * Module scope rather than per-describe: the wrong-width rule below is exactly what the snapshot
 * parser and the merge loop must agree on, and a second copy of it is the drift these tests exist
 * to catch.
 */
export function sampleCoord(byte: number): string {
	return coordToBase64url(new Uint8Array(32).fill(byte))
}

/** A wrong-width "coordinate" string — built with `u8ToString` directly (not `coordToBase64url`,
 * which is written for exactly-32-byte input) so an off-width array encodes without complaint and
 * the rejection under test is `base64urlToCoord`'s decode-side length check, not an encoder throw. */
export function wrongWidthCoord(byteLength: number): string {
	return u8ToString(new Uint8Array(byteLength).fill(3), 'base64url')
}

/** Two distinct, parseable peer ids: 'who the message claims' vs 'who the transport says'. */
export const PEER_CLAIMED = peerIdStr(1)
export const PEER_ACTUAL = peerIdStr(2)

// NOTE: seven files under test/ each define their own one-line `sleep(ms)`. This one was
// relocated here by the fixture move, not added by it. `wait-for.ts` offers no `sleep` to
// re-point at, and consolidating touches seven files for no behavior change; if a shared
// timing helper ever lands, fold all seven into it then.
export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

// Module-private on purpose: `baseMsg` is the only writer, and an importer that could read it
// would invite a second file driving the counter directly.
let seq = 0

/** A structurally valid `RouteAndMaybeAct` as a plain record, so rows can corrupt any field. */
export function baseMsg(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		v: 1,
		key: coordToBase64url(enc.encode(`fuzz-key-${seq}`)),
		want_k: 2,
		ttl: 4,
		min_sigs: 1,
		correlation_id: `fuzz-${++seq}`,
		timestamp: Date.now(),
		signature: '',
		...over,
	}
}

export function withoutKey(): Record<string, unknown> {
	const m = baseMsg()
	delete m.key
	return m
}

// ---------------------------------------------------------------------------------------------
// Stub streams modelling libp2p's status lifecycle, so release-exactly-once is countable.
// ---------------------------------------------------------------------------------------------

export interface InboundStub {
	stream: Stream
	closes: number
	aborts: number
	sends: number
	/** `close()` calls that hung rather than completing (only when `closeHangs`). */
	closeAttempts: number
	/**
	 * Chunk pulls the reader made. `lp.decode` pulls whole chunks, so a frame handed over as
	 * two chunks — the varint length prefix, then the body — makes "the body was never pulled"
	 * a *measurement* rather than an inference from the absence of a crash. Handed over as one
	 * chunk a single pull delivers both and the counter proves nothing.
	 */
	pulls: number
	/** Reply frames the handler wrote (empty when `sendThrows`). `sendFramed` passes a `Uint8ArrayList`. */
	replies: Array<Uint8Array | Uint8ArrayList>
	status: () => string
}

export interface InboundStubOpts {
	/** Make `send()` throw — the shape ping's unguarded tail used to die on. */
	sendThrows?: Error
	/** First read throws and flips status to `reset` — the remote tore the stream down. */
	resetOnRead?: boolean
	/** `close()` never resolves on its own — the remote accepted the reply and stopped reading. */
	closeHangs?: boolean
}

export function inboundStub(chunks: Uint8Array[], opts: InboundStubOpts = {}): InboundStub {
	let status = 'open'
	// Modelled on libp2p's own lifecycle, which the wrapper's release accounting reads: `close()`
	// closes the *write* end only and early-returns once it has, while `status` stays 'open' until
	// the remote closes its write end too — which for a FRET sender happens only after it has read
	// the reply. A stub that flipped `status` to 'closed' on close would let the wrapper pass its
	// assertions here for a reason production never supplies.
	let writeStatus = 'writable'
	let i = 0
	const rec: InboundStub = {
		stream: undefined as unknown as Stream,
		closes: 0, aborts: 0, sends: 0, closeAttempts: 0, pulls: 0, replies: [],
		status: () => status,
	}
	const stream = {
		id: 'stub-inbound',
		get status() { return status },
		get writeStatus() { return writeStatus },
		send: (b: Uint8Array | Uint8ArrayList): boolean => {
			rec.sends++
			if (opts.sendThrows) throw opts.sendThrows
			rec.replies.push(b)
			return true
		},
		close: async (o?: { signal?: AbortSignal }): Promise<void> => {
			if (writeStatus === 'closed') return
			// A remote that accepted the reply and stopped reading: `close()` resolves only once
			// pending data reached the transport, so it hangs until the caller's budget fires.
			// `writeStatus` sits at 'closing' meanwhile, which is what leaves the wrapper's abort
			// arm eligible when the budget does fire.
			if (opts.closeHangs) {
				rec.closeAttempts++
				writeStatus = 'closing'
				return await new Promise<void>((_res, rej) => {
					const s = o?.signal
					if (s == null) return // never settles — the unbudgeted behavior under test
					s.addEventListener('abort', () => { rej(new Error('close aborted')) }, { once: true })
				})
			}
			rec.closes++
			writeStatus = 'closed'
		},
		abort: (_e: Error): void => {
			rec.aborts++
			status = 'aborted'
			writeStatus = 'closed'
		},
		[Symbol.asyncIterator]: () => ({
			next: async (): Promise<IteratorResult<Uint8Array>> => {
				rec.pulls++
				if (opts.resetOnRead) {
					status = 'reset'
					writeStatus = 'closed'
					throw new Error('stream reset by remote')
				}
				return i < chunks.length
					? { done: false, value: chunks[i++]! }
					: { done: true, value: undefined }
			},
		}),
	}
	rec.stream = stream as unknown as Stream
	return rec
}

export type InboundHandler = (stream: Stream, connection: Connection) => Promise<void>

/** One length-prefixed frame carrying `text`, as the framed handlers now read. */
export function framed(text: string): Uint8Array {
	return lp.encode.single(enc.encode(text)).subarray()
}

export function json(obj: unknown): Uint8Array {
	return framed(JSON.stringify(obj))
}
