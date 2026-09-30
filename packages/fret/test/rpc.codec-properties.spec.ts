import { afterEach, before, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import type { Libp2p } from 'libp2p'
import type { PeerId, Stream } from '@libp2p/interface'
import { fromString as u8FromString } from 'uint8arrays/from-string'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { PeerRecord, RecordEnvelope } from '@libp2p/peer-record'
import { multiaddr } from '@multiformats/multiaddr'
import { toString as u8ToString } from 'uint8arrays/to-string'
import { disable, enable } from '@libp2p/logger'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import * as lp from 'it-length-prefixed'
import { decodeJson, encodeJson, makeProtocols, readFramed, sendFramed } from '../src/rpc/protocols.js'
import {
	COORD_BYTES,
	base64urlToCoord,
	coordToBase64url,
	coordToHex,
	hexToCoord,
	hashKey,
} from '../src/ring/hash.js'
import { DigitreeStore, type SerializedPeerEntry, type SerializedTable } from '../src/store/digitree-store.js'
import type { TokenBucket } from '../src/utils/token-bucket.js'
import type { LeaveNoticeV1 } from '../src/rpc/leave.js'
import type { PingResponseV1 } from '../src/rpc/ping.js'
import {
	MAX_ACTIVITY_BYTES,
	MAYBE_ACT_OVERHEAD_BYTES,
	MAX_NEIGHBORS_BYTES,
	MAX_SNAPSHOT_METADATA_BYTES_CORE,
	MAX_SNAPSHOT_METADATA_BYTES_EDGE,
	MAX_SNAPSHOT_HINT_BYTES_CORE,
	MAX_SNAPSHOT_HINT_BYTES_EDGE,
	MAX_ADDRESS_RECORD_CHARS,
	MAX_BREADCRUMBS,
	MAX_CORRELATION_ID_CHARS,
	MAX_DIGEST_CHARS,
	MAX_REPLACEMENTS,
	makeSnapshotParser,
	parseLeaveNotice,
	parseMaybeActReply,
	parseNearAnchor,
	parsePingResponse,
	parseRouteAndMaybeAct,
	type Parser,
} from '../src/rpc/validate.js'
import type { BusyResponseV1, NearAnchorV1, NeighborSnapshotV1, RouteAndMaybeActV1 } from '../src/index.js'
import type { Connection } from '@libp2p/interface'
import type { RpcOutcome } from '../src/rpc/outcome.js'
import { sendPing } from '../src/rpc/ping.js'
import { fetchNeighbors } from '../src/rpc/neighbors.js'
import { sendMaybeAct } from '../src/rpc/maybe-act.js'

// The second half of the fuzz tier from `plan/7-rpc-codec-fuzzing`. `rpc-handler-fault-isolation`
// (`test/rpc.handler-fuzz.spec.ts`) made malformed input safe to *receive*; this file proves three
// separate claims that nothing previously checked:
//
//   1. The codec is lossless — `encodeJson` → `decodeJson` is the identity on every value the wire
//      formats in `docs/fret.md` admit, and the coordinate codecs round-trip and reject.
//   2. The byte caps bite *before* a full parse — measured as how much of the source
//      `readFramed` consumed, not inferred from the absence of a crash.
//   3. The five inbound token buckets bound what they claim to, each in the form its own protocol
//      makes observable.
//
// Nothing here changes `src/`. Where a property exposes a real limit of the codec (`-0`, `NaN`,
// `undefined` inside `metadata`) the limit is pinned as today's documented contract with a note
// saying so, rather than papered over — see the `## Review findings` section of the handoff.
//
// **Per-peer rate limiting is deliberately absent, not missing coverage.** `docs/fret.md` lists it
// under *Not yet implemented* and `tickets/backlog/impl/4-per-peer-rate-limiting` owns it. Only the
// five global buckets exist, so only those are tested here.

const enc = new TextEncoder()

const NETWORK = 'codec-props'
const P = makeProtocols(NETWORK)

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

/** Poll `predicate` until true, or fail after `limitMs`. */
async function waitUntil(predicate: () => boolean, limitMs: number, what: string): Promise<void> {
	const until = Date.now() + limitMs
	while (!predicate() && Date.now() < until) await sleep(10)
	expect(predicate(), `${what} within ${limitMs}ms`).to.equal(true)
}

// =================================================================================================
// Phase 1 — round-trip
// =================================================================================================

/**
 * Strings that exercise what JSON quietly mangles, in the peer-id and metadata positions where the
 * wire actually carries free-form text.
 *
 * `fc.string({ unit: 'binary' })` reaches astral code points but — measured over 2000 samples —
 * never produces a *lone* surrogate, which is the case that matters: a lone surrogate is
 * unrepresentable in UTF-8, so an encoder that round-tripped through raw bytes would corrupt it.
 * (`JSON.stringify` is well-formed since ES2019 and emits a `\udXXX` escape instead, so the pair
 * survives — that is the claim under test.) The third arm therefore builds strings out of an
 * explicit alphabet containing unpaired surrogates rather than trusting the generator to find one.
 */
const LONE_SURROGATE_ALPHABET = ['\uD800', '\uDBFF', '\uDC00', '\uDFFF', 'a', 'é', '中', '\u0000', '"', '\\']

const arbNastyString = fc.oneof(
	fc.string(),
	fc.string({ unit: 'binary' }),
	fc.string({ unit: fc.constantFrom(...LONE_SURROGATE_ALPHABET), maxLength: 8 })
)

/**
 * Any number JSON is expected to carry losslessly. `-0`, `NaN` and `±Infinity` are excluded here
 * and pinned separately below as *documented losses* — including them would make this property
 * assert something the codec does not do.
 */
const arbJsonNumber = fc.oneof(
	fc.integer(),
	fc.double({ noNaN: true, noDefaultInfinity: true }),
	fc.constantFrom(
		0,
		1,
		Number.MAX_SAFE_INTEGER,
		Number.MAX_SAFE_INTEGER + 2, // beyond the safe range: still an exact double, so still exact
		-Number.MAX_SAFE_INTEGER - 2,
		1e308,
		5e-324
	)
).filter((n) => !Object.is(n, -0))

const arbUnitInterval = fc.double({ min: 0, max: 1, noNaN: true })

/**
 * Same shape as {@link arbJsonNumber} but floored at 0 — for fields this node's own encoder
 * never emits negative (e.g. `size_estimate`, whose valid range is `[0, Infinity]` per
 * `validate.ts`). `-0` is filtered for the same reason as `arbJsonNumber`.
 */
const arbNonNegativeJsonNumber = fc.oneof(
	fc.integer({ min: 0 }),
	fc.double({ min: 0, noNaN: true, noDefaultInfinity: true }),
	fc.constantFrom(
		0,
		1,
		Number.MAX_SAFE_INTEGER,
		Number.MAX_SAFE_INTEGER + 2,
		1e308,
		5e-324
	)
).filter((n) => !Object.is(n, -0))

const arbCoordBytes = fc.uint8Array({ minLength: COORD_BYTES, maxLength: COORD_BYTES })
const arbCoordB64 = arbCoordBytes.map(coordToBase64url)

/**
 * `metadata` is `Record<string, unknown>` on the wire, so its values are arbitrary JSON. Keys are
 * kept off `__proto__` deliberately: `JSON.parse` makes it an own property while an object literal
 * would set the prototype, so a generated `__proto__` key would compare two structurally different
 * objects and fail the property for a reason that has nothing to do with the codec.
 */
const arbMetadataKey = fc.oneof(
	fc.stringMatching(/^[a-zA-Z0-9_-]{1,10}$/),
	fc.constantFrom('é', '中', 'ключ', '\u{1F600}')
).filter((k) => k !== '__proto__')

/**
 * Arbitrary JSON, built explicitly rather than with `fc.jsonValue()` so its number leaves are
 * {@link arbJsonNumber} — i.e. `-0`-free. `fc.jsonValue()` emits `-0` at any nesting depth, and
 * `-0` is a *documented loss* of the codec (pinned on its own below), so leaving it in the
 * identity property makes that property assert something the codec does not do.
 */
const arbJsonValue: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
	value: fc.oneof(
		{ maxDepth: 2 },
		fc.constant(null),
		fc.boolean(),
		arbJsonNumber,
		arbNastyString,
		fc.array(tie('value'), { maxLength: 3 }),
		fc.dictionary(arbMetadataKey, tie('value'), { maxKeys: 3 })
	),
})).value

const arbMetadata = fc.dictionary(arbMetadataKey, arbJsonValue, { maxKeys: 5 })

/**
 * Make `optionalKeys` genuinely optional — present or absent with even weight, including the
 * all-absent case.
 *
 * `fc.record`'s own `requiredKeys` is not usable for this: measured over 400 samples of a record
 * with four optional keys it produced the all-present shape 182 times and the all-absent shape
 * **zero** times, so a property built on it would silently never exercise a message that omits its
 * optional fields — exactly the coverage this file's distribution assertions exist to guarantee.
 * `fc.subarray` over the key list is uniform across subsets, empty one included.
 */
function withOptionals<T extends object>(
	full: fc.Arbitrary<T>,
	optionalKeys: Array<keyof T & string>
): fc.Arbitrary<T> {
	return fc.tuple(full, fc.subarray(optionalKeys)).map(([value, keep]) => {
		const out = { ...value } as Record<string, unknown>
		for (const k of optionalKeys) if (!keep.includes(k)) delete out[k]
		return out as T
	})
}

const SNAPSHOT_OPTIONALS = ['sample', 'size_estimate', 'confidence', 'metadata', 'hints'] as const
const MAYBE_ACT_OPTIONALS = ['wants', 'digest', 'activity', 'breadcrumbs'] as const
const LEAVE_OPTIONALS = ['replacements'] as const
const PEER_ENTRY_OPTIONALS = ['membership', 'negotiateFailures', 'contactFailures', 'metadata'] as const

const arbNeighborSnapshot: fc.Arbitrary<NeighborSnapshotV1> = withOptionals(fc.record(
	{
		v: fc.constant(1 as const),
		from: arbNastyString,
		timestamp: arbJsonNumber,
		successors: fc.array(arbNastyString, { maxLength: 8 }),
		predecessors: fc.array(arbNastyString, { maxLength: 8 }),
		sample: fc.array(
			fc.record({ id: arbNastyString, coord: arbCoordB64, relevance: arbJsonNumber }),
			{ maxLength: 6 }
		),
		size_estimate: arbJsonNumber,
		confidence: arbUnitInterval,
		sig: arbNastyString,
		metadata: arbMetadata,
		// Junk on purpose, like the ids: the parser must drop these without throwing.
		hints: fc.array(fc.record({ id: arbNastyString, record: arbNastyString }), { maxLength: 4 }),
	}
), [...SNAPSHOT_OPTIONALS])

const arbRouteAndMaybeAct = withOptionals(fc.record(
	{
		v: fc.constant(1 as const),
		key: arbCoordB64,
		want_k: arbJsonNumber,
		wants: arbJsonNumber,
		ttl: arbJsonNumber,
		min_sigs: arbJsonNumber,
		digest: arbNastyString,
		activity: arbNastyString,
		breadcrumbs: fc.array(arbNastyString, { maxLength: 8 }),
		correlation_id: arbNastyString,
		timestamp: arbJsonNumber,
		signature: arbNastyString,
	}
), [...MAYBE_ACT_OPTIONALS])

const arbNearAnchor: fc.Arbitrary<NearAnchorV1> = fc.record({
	v: fc.constant(1 as const),
	anchors: fc.array(arbNastyString, { maxLength: 2 }),
	cohort_hint: fc.array(arbNastyString, { maxLength: 8 }),
	estimated_cluster_size: arbJsonNumber,
	confidence: arbUnitInterval,
})

const arbLeaveNotice = withOptionals(fc.record(
	{
		v: fc.constant(1 as const),
		from: arbNastyString,
		replacements: fc.array(arbNastyString, { maxLength: 12 }),
		timestamp: arbJsonNumber,
	}
), [...LEAVE_OPTIONALS])

const arbSerializedPeerEntry: fc.Arbitrary<SerializedPeerEntry> = withOptionals(fc.record(
	{
		id: arbNastyString,
		coord: arbCoordB64,
		relevance: arbJsonNumber,
		lastAccess: arbJsonNumber,
		state: fc.constantFrom('connected' as const, 'disconnected' as const, 'dead' as const),
		membership: fc.constantFrom('unknown' as const, 'member' as const, 'foreign' as const),
		negotiateFailures: fc.nat({ max: 5 }),
		contactFailures: fc.nat({ max: 5 }),
		accessCount: fc.nat({ max: 1000 }),
		successCount: fc.nat({ max: 1000 }),
		failureCount: fc.nat({ max: 1000 }),
		// `null` is the documented "never measured" value and must survive as `null` — not as 0,
		// and not by vanishing. See the *bucketless sparsity model* note in `docs/fret.md`.
		avgLatencyMs: fc.option(arbJsonNumber, { nil: null }),
		metadata: arbMetadata,
	}
), [...PEER_ENTRY_OPTIONALS])

const arbSerializedTable: fc.Arbitrary<SerializedTable> = fc.record({
	v: fc.constant(1 as const),
	peerId: arbNastyString,
	timestamp: arbJsonNumber,
	entries: fc.array(arbSerializedPeerEntry, { maxLength: 8 }),
})

describe('RPC codec properties', function () {
	this.timeout(60_000)

	const opts = { numRuns: 200 }

	describe('encodeJson / decodeJson round-trip', () => {
		/**
		 * One driver for all five wire types. `region` records what the generator actually produced
		 * so a green run cannot silently mean "the interesting shapes were never generated" — the
		 * same discipline as `test/nexthop-cost.spec.ts` and `test/peer-discovery.spec.ts`.
		 */
		async function assertRoundTrips<T>(
			arb: fc.Arbitrary<T>,
			optionalKeys: Array<keyof T & string>
		): Promise<void> {
			const region = { withOptionals: 0, withoutOptionals: 0 }

			await fc.assert(
				fc.asyncProperty(arb, async (value) => {
					const present = optionalKeys.filter((k) => (value as Record<string, unknown>)[k] !== undefined)
					if (present.length === optionalKeys.length) region.withOptionals++
					if (present.length === 0) region.withoutOptionals++

					const decoded = await decodeJson(await encodeJson(value))
					expect(decoded).to.deep.equal(value)
				}),
				opts
			)

			expect(region.withOptionals, 'no all-optionals-present case was generated').to.be.greaterThan(0)
			expect(region.withoutOptionals, 'no all-optionals-absent case was generated').to.be.greaterThan(0)
		}

		it('round-trips NeighborSnapshotV1, including every optional field', async () => {
			await assertRoundTrips(arbNeighborSnapshot, [...SNAPSHOT_OPTIONALS])
		})

		it('round-trips RouteAndMaybeActV1, including every optional field', async () => {
			await assertRoundTrips(arbRouteAndMaybeAct, ['wants', 'digest', 'activity', 'breadcrumbs'])
		})

		it('round-trips NearAnchorV1', async () => {
			await fc.assert(
				fc.asyncProperty(arbNearAnchor, async (value) => {
					expect(await decodeJson(await encodeJson(value))).to.deep.equal(value)
				}),
				opts
			)
		})

		it('round-trips LeaveNoticeV1, including the optional replacements list', async () => {
			await assertRoundTrips(arbLeaveNotice, ['replacements'])
		})

		it('round-trips SerializedTable, including a null avgLatencyMs', async () => {
			const region = { nullLatency: 0, numericLatency: 0, absentMembership: 0 }

			await fc.assert(
				fc.asyncProperty(arbSerializedTable, async (table) => {
					for (const e of table.entries) {
						if (e.avgLatencyMs === null) region.nullLatency++
						else region.numericLatency++
						if (e.membership === undefined) region.absentMembership++
					}
					expect(await decodeJson(await encodeJson(table))).to.deep.equal(table)
				}),
				opts
			)

			expect(region.nullLatency, 'no null avgLatencyMs was generated').to.be.greaterThan(0)
			expect(region.numericLatency, 'no measured avgLatencyMs was generated').to.be.greaterThan(0)
			expect(region.absentMembership, 'no pre-membership-style entry was generated').to.be.greaterThan(0)
		})
	})

	// ---------------------------------------------------------------------------------------------
	// The reject half of the codec, held to the same standard as the coordinate codecs below:
	// "accepts exactly X" is only half a contract. Every body-reading handler relies on `decodeJson`
	// refusing a non-object top level and never re-checks what it got back, so the refusal is load
	// bearing rather than defensive. The padding rules are the other untested half — `decodeJson`
	// trims NUL/tab/LF/CR/space from both ends before parsing. Under length-prefix framing the
	// muxer never touches body bytes, so the trim is interop-defensive: it forgives a sender that
	// frames padding inside the counted body, rather than a transport that pads the frame.
	// ---------------------------------------------------------------------------------------------
	describe('decodeJson rejects what is not a message', () => {
		/** The error `decodeJson` threw; fails the test if it accepted the bytes instead. */
		async function decodeError(bytes: Uint8Array): Promise<Error> {
			let err: unknown
			try { await decodeJson(bytes) } catch (e) { err = e }
			expect(err, `decodeJson accepted ${JSON.stringify(new TextDecoder().decode(bytes))}`)
				.to.be.instanceOf(Error)
			return err as Error
		}

		const arbNonObjectJson = fc.oneof(
			fc.constant(null),
			fc.boolean(),
			arbJsonNumber,
			arbNastyString,
			fc.array(arbJsonValue, { maxLength: 3 })
		)

		it('rejects every non-object top-level value', async () => {
			const region = { array: 0, scalar: 0 }

			await fc.assert(
				fc.asyncProperty(arbNonObjectJson, async (value) => {
					if (Array.isArray(value)) region.array++
					else region.scalar++
					const err = await decodeError(await encodeJson(value))
					expect(err.message).to.equal('non-object JSON payload')
				}),
				opts
			)

			expect(region.array, 'no top-level array was generated').to.be.greaterThan(0)
			expect(region.scalar, 'no top-level scalar was generated').to.be.greaterThan(0)
		})

		it('rejects an empty body, and one that is nothing but padding', async () => {
			expect((await decodeError(new Uint8Array(0))).message).to.equal('empty response')

			for (const pad of [[0], [0, 0, 0], [32, 9, 10, 13]]) {
				expect((await decodeError(Uint8Array.from(pad))).message).to.equal('whitespace response')
			}
		})

		it('strips padding from both ends of a real message rather than failing on it', async () => {
			const message = { v: 1, from: 'p', timestamp: 1 }
			const body = await encodeJson(message)
			const padded = new Uint8Array(body.byteLength + 4)
			padded.set([0, 32], 0)
			padded.set(body, 2)
			padded.set([10, 0], body.byteLength + 2)

			expect(await decodeJson(padded)).to.deep.equal(message)
		})
	})

	// ---------------------------------------------------------------------------------------------
	// A NUL in the padding points at a framing bug on the sender, so `decodeJson` counts the NULs it
	// stripped and writes one line naming the count. Ordinary whitespace padding stays silent. The
	// line is namespace-gated, which is what keeps it from being an amplification path given that
	// `decodeJson` runs ahead of the maybeAct token bucket (see the `NOTE:` at the site).
	// ---------------------------------------------------------------------------------------------
	describe('decodeJson reports stripped NUL padding, and only NUL padding', () => {
		const HANDLER_ERROR_NAMESPACE = 'optimystic:fret:rpc:handler:error'

		/**
		 * `log` is a module-private const in `protocols.ts`, so re-creating the logger here yields a
		 * different weald instance and would intercept nothing. Enable the real namespace instead and
		 * capture weald's node sink, `process.stderr.write`.
		 *
		 * `enable()` writes `process.env.DEBUG` as a side effect (weald's `enable` calls `save()`), so
		 * the developer's own `DEBUG` is read first and restored afterwards.
		 */
		async function linesFromDecode(body: Uint8Array): Promise<string[]> {
			const previousDebug = process.env.DEBUG
			const previousWrite = process.stderr.write.bind(process.stderr)
			const lines: string[] = []

			enable(HANDLER_ERROR_NAMESPACE)
			process.stderr.write = ((chunk: unknown) => {
				lines.push(String(chunk))
				return true
			}) as typeof process.stderr.write

			try {
				decodeJson(body)
			} finally {
				process.stderr.write = previousWrite
				if (previousDebug === undefined) {
					disable()
					delete process.env.DEBUG
				} else {
					enable(previousDebug)
				}
			}

			return lines
		}

		function padded(before: number[], after: number[]): Uint8Array {
			const body = encodeJson({ v: 1, from: 'p', timestamp: 1 })
			const out = new Uint8Array(before.length + body.byteLength + after.length)
			out.set(before, 0)
			out.set(body, before.length)
			out.set(after, before.length + body.byteLength)
			return out
		}

		// `%d` is not a weald formatter, so it falls through to `util.format`, which substitutes it —
		// the count really is in the emitted line. The whole formatted string is not pinned because it
		// carries weald's namespace prefix and its elapsed `+Nms` suffix.
		function strippedCount(line: string): number {
			const match = /stripped (\d+) NUL/.exec(line)
			expect(match, `no NUL count in ${JSON.stringify(line)}`).to.not.equal(null)
			return Number(match?.[1])
		}

		const nulCases: Array<[string, number[], number[], number]> = [
			['at the start only', [0, 0], [], 2],
			['at the end only', [], [0], 1],
			['at both ends', [0, 32], [10, 0, 0], 3],
		]

		for (const [where, before, after, expected] of nulCases) {
			it(`logs once with the count when NUL padding sits ${where}`, async () => {
				const lines = await linesFromDecode(padded(before, after))

				expect(lines.length, 'exactly one line per decode').to.equal(1)
				expect(strippedCount(lines[0])).to.equal(expected)
			})
		}

		it('says nothing about padding that carries no NUL', async () => {
			const lines = await linesFromDecode(padded([9, 32], [10, 13, 32]))

			expect(lines).to.deep.equal([])
		})
	})

	// ---------------------------------------------------------------------------------------------
	// The values JSON quietly mangles. Finding them is the point of this file, so each is pinned
	// explicitly rather than excluded from the generators and forgotten.
	// ---------------------------------------------------------------------------------------------
	describe('JSON sharp edges (today\'s contract, stated not endorsed)', () => {
		it('carries a null avgLatencyMs through as null — never 0, never absent', async () => {
			const entry = { id: 'p', coord: coordToBase64url(new Uint8Array(COORD_BYTES)), avgLatencyMs: null }

			const back = await decodeJson<typeof entry>(await encodeJson(entry))

			// The distinction is load-bearing: `null` scores the midpoint latency penalty while `0`
			// is the best possible measured link (`docs/fret.md`, *Relevance score calculation*).
			expect(back.avgLatencyMs).to.equal(null)
			expect('avgLatencyMs' in back, 'the key survives rather than vanishing').to.equal(true)
		})

		it('preserves a lone surrogate in a peer-id position', async () => {
			const notice: LeaveNoticeV1 = { v: 1, from: 'peer-\uD800-tail', timestamp: 1 }

			const back = await decodeJson<LeaveNoticeV1>(await encodeJson(notice))

			// Well-formed `JSON.stringify` emits `\ud800` as an escape, so the unpaired code unit
			// never reaches UTF-8 and survives verbatim.
			expect(back.from).to.equal(notice.from)
			expect(back.from.charCodeAt(5)).to.equal(0xd800)
		})

		it('preserves non-ASCII in metadata keys and values', async () => {
			const snap = { v: 1 as const, metadata: { '中': '\u{1F600}é' } }

			expect(await decodeJson(await encodeJson(snap))).to.deep.equal(snap)
		})

		// NOTE (contract, not a defect to fix here): `JSON.stringify` drops an own property whose
		// value is `undefined`. So a metadata entry set to `undefined` does not survive the codec —
		// the receiver sees the key as absent. Callers must not use `undefined` to mean anything
		// other than "absent"; `null` is the value that round-trips.
		it('drops a metadata value of undefined — absence is what the wire can express', async () => {
			const snap = { v: 1, metadata: { present: 1, gone: undefined } }

			const back = await decodeJson<{ metadata: Record<string, unknown> }>(await encodeJson(snap))

			expect(Object.keys(back.metadata)).to.deep.equal(['present'])
		})

		// NOTE (contract, not a defect to fix here): `-0` serialises as `0`, so its sign is lost.
		// No FRET field distinguishes the two today (relevance, latency and estimates are all
		// magnitudes), which is why this is pinned rather than fixed — a codec that preserved it
		// would have to stop being JSON.
		it('loses the sign of negative zero', async () => {
			const back = await decodeJson<{ relevance: number }>(await encodeJson({ relevance: -0 }))

			expect(Object.is(back.relevance, -0), '-0 does not survive JSON').to.equal(false)
			expect(back.relevance).to.equal(0)
		})

		// NOTE (contract, not a defect to fix here): `NaN` and `±Infinity` serialise as `null`.
		// Every consumer of these fields already guards with `Number.isFinite` — the maybeAct
		// validator (`parseRouteAndMaybeAct`) rejects a non-finite `ttl` / `want_k` /
		// `min_sigs` / `timestamp` outright — so the lossy encoding cannot reach routing logic.
		it('turns a non-finite number into null', async () => {
			const back = await decodeJson<Record<string, unknown>>(
				await encodeJson({ a: NaN, b: Infinity, c: -Infinity })
			)

			expect(back).to.deep.equal({ a: null, b: null, c: null })
		})

		it('carries an integer beyond MAX_SAFE_INTEGER without changing its value', async () => {
			// Not a claim that integers above 2^53 are *distinguishable* — they are not, in JS or in
			// JSON. The claim is that the codec adds no further error: whatever double went in comes
			// back bit-identical, because `JSON.stringify` emits the shortest round-tripping form.
			const big = Number.MAX_SAFE_INTEGER + 2
			const back = await decodeJson<{ timestamp: number; size_estimate: number }>(
				await encodeJson({ timestamp: big, size_estimate: -big })
			)

			expect(back.timestamp).to.equal(big)
			expect(back.size_estimate).to.equal(-big)
		})
	})

	// ---------------------------------------------------------------------------------------------
	// Coordinate codecs — the other half of the round trip, with their own known-sharp edges
	// (`docs/fret.md`, *Digitree implementation*). A wrong-length coordinate produces a wrong-length
	// tree key that sorts into an arbitrary ring position, so "rejects" matters as much as
	// "round-trips".
	// ---------------------------------------------------------------------------------------------
	describe('coordinate codecs', () => {
		it('base64url round-trips every 32-byte coordinate', () => {
			fc.assert(
				fc.property(arbCoordBytes, (coord) => {
					expect(base64urlToCoord(coordToBase64url(coord))).to.deep.equal(coord)
				}),
				opts
			)
		})

		it('hex round-trips every 32-byte coordinate', () => {
			fc.assert(
				fc.property(arbCoordBytes, (coord) => {
					expect(hexToCoord(coordToHex(coord))).to.deep.equal(coord)
				}),
				opts
			)
		})

		it('base64urlToCoord accepts exactly the strings decoding to 32 bytes, and rejects the rest', () => {
			const region = { accepted: 0, wrongLength: 0, undecodable: 0 }

			// Valid encodings mixed in on purpose: over `fc.string()` alone the accept region is
			// never reached, so the property would only ever prove that garbage is refused.
			const arb = fc.oneof(
				arbCoordB64,
				fc.string(),
				fc.uint8Array({ maxLength: 40 }).map(coordToBase64url),
				fc.constantFrom('', '!!!', 'A'.repeat(43), 'A'.repeat(44), 'A'.repeat(45))
			)

			fc.assert(
				fc.property(arb, (s) => {
					let raw: Uint8Array | undefined
					try { raw = u8FromString(s, 'base64url') } catch { raw = undefined }

					if (raw?.length === COORD_BYTES) {
						region.accepted++
						expect(base64urlToCoord(s)).to.deep.equal(raw)
						return
					}
					if (raw === undefined) region.undecodable++
					else region.wrongLength++
					expect(() => base64urlToCoord(s), `must reject ${JSON.stringify(s)}`).to.throw()
				}),
				opts
			)

			expect(region.accepted, 'no valid 32-byte encoding was generated').to.be.greaterThan(0)
			expect(region.wrongLength, 'no decodable-but-wrong-length string was generated').to.be.greaterThan(0)
			expect(region.undecodable, 'no undecodable string was generated').to.be.greaterThan(0)
		})

		it('hexToCoord accepts exactly 64 hex characters, and rejects the rest', () => {
			const region = { accepted: 0, rejected: 0 }

			const arb = fc.oneof(
				arbCoordBytes.map(coordToHex),
				fc.string(),
				fc.stringMatching(/^[0-9a-fA-F]{0,70}$/),
				fc.constantFrom('', 'g'.repeat(64), '0'.repeat(63), '0'.repeat(65), '0x' + '0'.repeat(62))
			)

			fc.assert(
				fc.property(arb, (s) => {
					const valid = /^[0-9a-fA-F]{64}$/.test(s)
					if (valid) {
						region.accepted++
						expect(coordToHex(hexToCoord(s))).to.equal(s.toLowerCase())
						return
					}
					region.rejected++
					// The regression this guards: `parseInt` on a non-hex pair returned NaN, which
					// coerces to 0 inside a Uint8Array — so `'gg…'` used to decode to a plausible
					// near-zero coordinate instead of throwing.
					expect(() => hexToCoord(s), `must reject ${JSON.stringify(s)}`).to.throw()
				}),
				opts
			)

			expect(region.accepted, 'no valid 64-char hex string was generated').to.be.greaterThan(0)
			expect(region.rejected, 'no invalid hex string was generated').to.be.greaterThan(0)
		})
	})

	// ---------------------------------------------------------------------------------------------
	// Store export/import over generated tables. `test/digitree.persistence.spec.ts` already pins
	// export/import equivalence for concrete tables and every documented normalization
	// (state → disconnected, failure counters → 0, malformed coord rejects the whole snapshot), so
	// this adds only what a generator can say that fixed cases cannot: whatever the input, the
	// normalization is a *fixpoint* and no distinct id is lost.
	// ---------------------------------------------------------------------------------------------
	describe('SerializedTable through the store', () => {
		it('normalizes to a fixpoint and keeps every distinct id', () => {
			const region = { withDuplicateIds: 0, withoutDuplicateIds: 0 }

			fc.assert(
				fc.property(fc.array(arbSerializedPeerEntry, { maxLength: 10 }), (entries) => {
					const distinct = new Set(entries.map((e) => e.id))
					if (distinct.size < entries.length) region.withDuplicateIds++
					else region.withoutDuplicateIds++

					const first = new DigitreeStore()
					const stored = first.importEntries(entries)
					const once = first.exportEntries()

					// Import replaces by id, so the count is distinct ids — not input records.
					expect(stored).to.equal(distinct.size)
					expect(new Set(once.map((e) => e.id))).to.deep.equal(distinct)

					const second = new DigitreeStore()
					second.importEntries(once)
					expect(second.exportEntries(), 'normalization is idempotent').to.deep.equal(once)
				}),
				opts
			)

			expect(region.withDuplicateIds, 'no duplicate-id snapshot was generated').to.be.greaterThan(0)
			expect(region.withoutDuplicateIds, 'no duplicate-free snapshot was generated').to.be.greaterThan(0)
		})
	})

	// ---------------------------------------------------------------------------------------------
	// `readFramed` reassembly. Driven from a plain async iterable — it accepts one — so no
	// transport is involved. This is the framing regression guard: a frame split at any chunk
	// boundary — prefix straddled, body fragmented, zero-length chunks interleaved — must
	// reassemble byte-identically.
	// ---------------------------------------------------------------------------------------------
	describe('readFramed reassembly', () => {
		/** Cut points for `bytes`, clamped and ordered: `[0, ...cuts, length]`. */
		function chunkEdges(bytes: Uint8Array, boundaries: number[]): number[] {
			const cuts = boundaries.map((b) => Math.min(b, bytes.byteLength)).sort((a, b) => a - b)
			return [0, ...cuts, bytes.byteLength]
		}

		function chunkedSource(bytes: Uint8Array, edges: number[]): AsyncIterable<Uint8Array> {
			return {
				async *[Symbol.asyncIterator]() {
					for (let i = 1; i < edges.length; i++) yield bytes.subarray(edges[i - 1]!, edges[i]!)
				},
			}
		}

		it('reassembles a frame split at arbitrary chunk boundaries, byte-identically', async () => {
			const region = { multiChunk: 0, emptyChunk: 0, emptyMessage: 0 }

			await fc.assert(
				fc.asyncProperty(
					fc.uint8Array({ maxLength: 2048 }),
					fc.array(fc.nat({ max: 2048 }), { maxLength: 12 }),
					async (bytes, boundaries) => {
						const framed = lp.encode.single(bytes).subarray()
						const edges = chunkEdges(framed, boundaries)
						if (edges.length > 2) region.multiChunk++
						// Duplicate boundaries produce zero-length chunks — the case that must not be
						// read as end-of-stream. A gap between chunks is a slow link, not EOF; a
						// zero-length chunk is the degenerate form.
						if (edges.some((e, i) => i > 0 && e === edges[i - 1])) region.emptyChunk++
						if (bytes.byteLength === 0) region.emptyMessage++

						const out = await readFramed(chunkedSource(framed, edges), 1024 * 1024, 5000)
						expect(out).to.deep.equal(bytes)

						// A zero-length frame (bare 0x00 prefix) is not an error at the framing
						// layer; it is `decodeJson` that refuses the empty body.
						if (bytes.byteLength === 0) {
							let err: unknown
							try { await decodeJson(out) } catch (e) { err = e }
							expect((err as Error)?.message).to.equal('empty response')
						}
					}
				),
				{ numRuns: 100 }
			)

			expect(region.multiChunk, 'no multi-chunk frame was generated').to.be.greaterThan(0)
			expect(region.emptyChunk, 'no zero-length chunk was generated').to.be.greaterThan(0)
			expect(region.emptyMessage, 'no empty message was generated').to.be.greaterThan(0)
		})

		it('round-trips every wire type through frame → arbitrary chunking → decode', async () => {
			const arbWireMessage = fc.oneof(
				arbNeighborSnapshot as fc.Arbitrary<unknown>,
				arbRouteAndMaybeAct as fc.Arbitrary<unknown>,
				arbNearAnchor as fc.Arbitrary<unknown>,
				arbLeaveNotice as fc.Arbitrary<unknown>,
				arbSerializedTable as fc.Arbitrary<unknown>
			)

			await fc.assert(
				fc.asyncProperty(
					arbWireMessage,
					fc.array(fc.nat({ max: 4096 }), { maxLength: 8 }),
					async (message, boundaries) => {
						const framed = lp.encode.single(await encodeJson(message)).subarray()
						const edges = chunkEdges(framed, boundaries)

						const out = await readFramed(chunkedSource(framed, edges), 1024 * 1024, 5000)
						expect(await decodeJson(out)).to.deep.equal(message)
					}
				),
				{ numRuns: 100 }
			)
		})
	})

	// =============================================================================================
	// Phase 2 — byte caps
	// =============================================================================================

	/**
	 * A framed source that counts how many times it was pulled, so "stopped at the cap" is measured
	 * rather than inferred from the absence of a crash. Pull 1 yields the bare length prefix
	 * declaring `totalBytes`; later pulls yield body chunks of `chunkSize`.
	 */
	function countingSource(chunkSize: number, totalBytes: number): {
		source: AsyncIterable<Uint8Array>
		pulls: () => number
	} {
		const framed = lp.encode.single(new Uint8Array(totalBytes)).subarray()
		const prefixLen = framed.byteLength - totalBytes
		let pulls = 0
		let offset = 0
		const source: AsyncIterable<Uint8Array> = {
			[Symbol.asyncIterator]: () => ({
				next: async (): Promise<IteratorResult<Uint8Array>> => {
					pulls++
					if (offset >= framed.byteLength) return { done: true, value: undefined }
					const end = offset === 0 ? prefixLen : Math.min(offset + chunkSize, framed.byteLength)
					const chunk = framed.subarray(offset, end)
					offset = end
					return { done: false, value: chunk }
				},
			}),
		}
		return { source, pulls: () => pulls }
	}

	describe('readFramed refuses an over-cap frame at its prefix rather than draining the source', () => {
		it('rejects a frame declaring 4 MB against a 256 KB cap after a single pull', async () => {
			const total = 4 * 1024 * 1024
			const { source, pulls } = countingSource(64 * 1024, total)

			let thrown: unknown
			try { await readFramed(source, 256 * 1024, 5000) } catch (err) { thrown = err }

			expect((thrown as Error)?.message, 'refused, not truncated').to.include('payload too large')
			// The refusal happens at the declared length: the prefix is the first pull, and no body
			// byte is ever asked for — the source held 64 body chunks and yielded none.
			expect(pulls(), 'the prefix alone was enough to know').to.equal(1)
		})

		it('bounds its consumption at the cap for arbitrary chunk sizes', async () => {
			const region = { overCap: 0, underCap: 0 }

			await fc.assert(
				fc.asyncProperty(
					fc.integer({ min: 64, max: 2048 }),
					fc.integer({ min: 16, max: 512 }),
					fc.integer({ min: 0, max: 4096 }),
					async (maxBytes, chunkSize, total) => {
						const { source, pulls } = countingSource(chunkSize, total)

						let thrown: unknown
						let out: Uint8Array | undefined
						try { out = await readFramed(source, maxBytes, 5000) } catch (err) { thrown = err }

						if (total > maxBytes) {
							region.overCap++
							expect((thrown as Error)?.message).to.include('payload too large')
							expect(pulls(), 'refused at the prefix, before any body byte').to.equal(1)
						} else {
							region.underCap++
							expect(thrown, 'an under-cap frame must not throw').to.equal(undefined)
							expect(out!.byteLength).to.equal(total)
						}
					}
				),
				{ numRuns: 150 }
			)

			expect(region.overCap, 'no over-cap case was generated').to.be.greaterThan(0)
			expect(region.underCap, 'no under-cap case was generated').to.be.greaterThan(0)
		})
	})

	// ---------------------------------------------------------------------------------------------
	// Handler-level byte caps, over a real connection.
	//
	// The maybeAct wire cap and the service's own activity cap are now one derived number rather
	// than two that can disagree: `maxBytesMaybeAct() = MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES`
	// (both exported from `src/rpc/validate.ts`), 144 KiB on both profiles. The neighbors wire cap
	// is `MAX_NEIGHBORS_BYTES`, 64 KiB on both profiles. The assertions below pin those caps. The
	// tests use the Edge profile so payloads stay small enough to send quickly; the arithmetic is
	// the same on Core.
	// ---------------------------------------------------------------------------------------------
	describe('byte caps at the handler', () => {
		interface WireRig {
			receiver: Libp2p
			sender: Libp2p
			svc: CoreFretService
		}

		let rig: WireRig

		beforeEach(async () => {
			const receiver = await createMemNode()
			const sender = await createMemNode()
			await receiver.start()
			await sender.start()
			// Deliberately not started: the inbound handlers are registered directly, so no
			// stabilization loop dials anything and every count below is deterministic — the same
			// arrangement as `test/rpc.handler-fuzz.spec.ts`.
			const svc = new CoreFretService(receiver, { profile: 'edge', networkName: NETWORK })
			await (svc as unknown as { registerRpcHandlers(): Promise<void> }).registerRpcHandlers()
			await sender.dial(receiver.getMultiaddrs()[0]!)
			rig = { receiver, sender, svc }
		})

		afterEach(async () => {
			await stopAll([rig.sender, rig.receiver])
		})

		/** Open inbound streams for `protocol` on the receiver's side of its connection to `sender`. */
		function openStreams(receiver: Libp2p, sender: Libp2p, protocol: string): number {
			return receiver.getConnections(sender.peerId)
				.flatMap((c) => c.streams)
				.filter((s) => s.protocol === protocol && s.status === 'open')
				.length
		}

		/** Wait for the stream's send buffer to drain, or for it to die. Bounded so a test cannot hang. */
		async function drained(stream: Stream): Promise<void> {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(finish, 2000)
				function finish(): void {
					clearTimeout(timer)
					stream.removeEventListener('drain', finish)
					stream.removeEventListener('close', finish)
					resolve()
				}
				stream.addEventListener('drain', finish)
				stream.addEventListener('close', finish)
			})
		}

		/**
		 * Write in muxer-sized pieces, respecting backpressure. `send` may throw once the receiver
		 * has aborted — which is the *expected* outcome for every over-cap row here, since
		 * `readFramed` refuses a frame at its declared length and the registration seam aborts the
		 * stream — so a failed write is a result, not an error.
		 */
		async function writeAll(stream: Stream, bytes: Uint8Array): Promise<void> {
			const CHUNK = 16 * 1024
			for (let o = 0; o < bytes.byteLength; o += CHUNK) {
				if (stream.writeStatus !== 'writable') return
				let ok: boolean
				try { ok = stream.send(bytes.subarray(o, o + CHUNK)) } catch { return }
				if (!ok) await drained(stream)
			}
		}

		/** Returns the reply bytes, or `undefined` when the receiver aborted the stream. */
		async function sendRaw(target: PeerId, protocol: string, payload: string): Promise<Uint8Array | undefined> {
			const stream = await rig.sender.dialProtocol(target, [protocol])
			try {
				await writeAll(stream, lp.encode.single(enc.encode(payload)).subarray())
				await stream.close()
				return await readFramed(stream, 1024 * 1024, 3000)
			} catch {
				try { stream.abort(new Error('sendRaw: receiver aborted')) } catch { /* already gone */ }
				return undefined
			}
		}

		function maybeActBody(activityChars: number): string {
			return JSON.stringify({
				v: 1,
				key: coordToBase64url(new Uint8Array(COORD_BYTES)),
				want_k: 2,
				ttl: 4,
				min_sigs: 1,
				correlation_id: `cap-${activityChars}-${Date.now()}`,
				timestamp: Date.now(),
				signature: '',
				activity: 'a'.repeat(activityChars),
			})
		}

		it('answers an under-cap maybeAct and refuses an over-cap one before the service sees it', async () => {
			const maxBytes = (rig.svc as unknown as { maxBytesMaybeAct(): number }).maxBytesMaybeAct()
			expect(maxBytes, 'edge wire cap').to.equal(144 * 1024)

			// Under the wire cap *and* under the service's own 128 KB activity cap, so this is a
			// genuine answer rather than a payload-too-large rejection.
			const under = await sendRaw(rig.receiver.peerId, P.PROTOCOL_MAYBE_ACT, maybeActBody(100 * 1024))
			expect(under, 'an under-cap message is answered').to.not.equal(undefined)
			expect((await decodeJson<NearAnchorV1>(under!)).v).to.equal(1)

			const before = { ...rig.svc.getDiagnostics().rejected }

			const over = await sendRaw(rig.receiver.peerId, P.PROTOCOL_MAYBE_ACT, maybeActBody(300 * 1024))

			expect(over, 'an over-cap message gets no reply — the stream is aborted').to.equal(undefined)
			// The load-bearing assertion: *nothing* in the service moved. Not `payloadTooLarge` (the
			// 128 KB activity check inside `handleMaybeAct`), not `rateLimited` (the bucket), not
			// `malformed` (the validator). The read was refused at the frame's declared length,
			// before any body byte reached any of them, which is what "refused before a full parse"
			// means at the handler level.
			expect(rig.svc.getDiagnostics().rejected).to.deep.equal(before)

			await waitUntil(
				() => openStreams(rig.receiver, rig.sender, P.PROTOCOL_MAYBE_ACT) === 0,
				2000,
				'the over-cap maybeAct left no inbound stream open'
			)
		})

		it('merges an under-cap announce and refuses an over-cap one', async () => {
			const maxBytes = (rig.svc as unknown as { maxBytesNeighbors(): number }).maxBytesNeighbors()
			// One acceptance number for both profiles — this rig's service is Edge.
			expect(maxBytes, 'neighbors wire cap').to.equal(MAX_NEIGHBORS_BYTES)

			const senderId = rig.sender.peerId.toString()
			const announce = (padChars: number): string => JSON.stringify({
				v: 1,
				from: senderId,
				timestamp: Date.now(),
				successors: [],
				predecessors: [],
				sig: 'x'.repeat(padChars),
			})

			const under = await sendRaw(rig.receiver.peerId, P.PROTOCOL_NEIGHBORS_ANNOUNCE, announce(1024))
			expect(under, 'an under-cap announce is acknowledged').to.not.equal(undefined)
			// The merge is detached, so the store gains the sender a tick later.
			await waitUntil(
				() => rig.svc.getStore().getById(senderId) != null,
				2000,
				'the under-cap announce merged'
			)

			// Arm B of the cross-profile defect: ~11 KiB is over the *old* Edge announce cap of
			// 8 KiB but inside a legal Core emission (worst case 11,575 bytes). This receiver is
			// Edge, and it must accept it — its own fetch path already read 16 KiB replies, so the
			// announce path refusing the identical snapshot was the two paths disagreeing about
			// one question. Fails on the pre-fix code; that is the repro.
			rig.svc.getStore().remove(senderId)
			const coreSized = await sendRaw(rig.receiver.peerId, P.PROTOCOL_NEIGHBORS_ANNOUNCE, announce(11 * 1024))
			expect(coreSized, 'an edge receiver acknowledges a core-sized announce').to.not.equal(undefined)
			await waitUntil(
				() => rig.svc.getStore().getById(senderId) != null,
				2000,
				'the core-sized announce merged on an edge receiver'
			)

			rig.svc.getStore().remove(senderId)
			const before = { ...rig.svc.getDiagnostics().rejected }

			const over = await sendRaw(rig.receiver.peerId, P.PROTOCOL_NEIGHBORS_ANNOUNCE, announce(70 * 1024))

			expect(over, 'an over-cap announce gets no acknowledgement').to.equal(undefined)
			await sleep(100) // give a merge that should not happen every chance to happen
			expect(rig.svc.getStore().getById(senderId), 'never reached the merge').to.equal(undefined)
			expect(rig.svc.getDiagnostics().rejected).to.deep.equal(before)

			await waitUntil(
				() => openStreams(rig.receiver, rig.sender, P.PROTOCOL_NEIGHBORS_ANNOUNCE) === 0,
				2000,
				'the over-cap announce left no inbound stream open'
			)
		})

		it('accepts an under-cap leave and refuses one past the fixed 4096-byte cap', async () => {
			const senderId = rig.sender.peerId.toString()
			const leave = (padChars: number): string => JSON.stringify({
				v: 1,
				from: senderId,
				timestamp: Date.now(),
				// An unknown field is exactly how a real over-cap body would arrive (version skew,
				// a future field); `readFramed` caps the frame regardless of its shape.
				padding: 'x'.repeat(padChars),
			})

			// `handleLeave` removes the departing peer from the store, so seeding it first makes
			// "the notice was processed" observable.
			rig.svc.getStore().upsert(senderId, await hashKey(enc.encode(senderId)))

			const over = await sendRaw(rig.receiver.peerId, P.PROTOCOL_LEAVE, leave(5000))

			expect(over, 'an over-cap leave gets no reply').to.equal(undefined)
			await sleep(100)
			expect(rig.svc.getStore().getById(senderId), 'never reached handleLeave').to.not.equal(undefined)
			await waitUntil(
				() => openStreams(rig.receiver, rig.sender, P.PROTOCOL_LEAVE) === 0,
				2000,
				'the over-cap leave left no inbound stream open'
			)

			const under = await sendRaw(rig.receiver.peerId, P.PROTOCOL_LEAVE, leave(64))
			expect(under, 'an under-cap leave is answered').to.not.equal(undefined)
			expect((await decodeJson<{ ok: boolean }>(under!)).ok).to.equal(true)
			await waitUntil(
				() => rig.svc.getStore().getById(senderId) == null,
				2000,
				'the under-cap leave was processed'
			)
		})

		it('accepts activity at exactly MAX_ACTIVITY_BYTES and refuses one byte over via the service check, not the wire cap', async () => {
			// Both messages stay well under the 144 KiB wire cap (maybeActBody's overhead is a few
			// hundred bytes), so this pins `handleMaybeAct`'s own 128 KiB activity check, distinct
			// from the wire-level refusal the previous test covers.
			const atCap = await sendRaw(rig.receiver.peerId, P.PROTOCOL_MAYBE_ACT, maybeActBody(MAX_ACTIVITY_BYTES))
			expect(atCap, 'activity at exactly the cap is a genuine answer').to.not.equal(undefined)
			expect((await decodeJson<NearAnchorV1>(atCap!)).v).to.equal(1)

			const before = { ...rig.svc.getDiagnostics().rejected }

			const overByOne = await sendRaw(rig.receiver.peerId, P.PROTOCOL_MAYBE_ACT, maybeActBody(MAX_ACTIVITY_BYTES + 1))
			expect(overByOne, 'refused by handleMaybeAct, which still replies (unlike the wire-cap abort)').to.not.equal(undefined)
			expect(
				rig.svc.getDiagnostics().rejected.payloadTooLarge - before.payloadTooLarge,
				'the service-level activity check counted the refusal'
			).to.equal(1)
			expect(
				{ ...rig.svc.getDiagnostics().rejected, payloadTooLarge: before.payloadTooLarge },
				'nothing else moved'
			).to.deep.equal(before)
		})
	})

	describe('the frame prefix alone refuses an over-cap message, per protocol', () => {
		// Mirrors the `readFramed`-only pattern at lines 724-736 above: no live connection needed,
		// since the refusal happens inside `readFramed` itself before any body byte is pulled.
		const cases: Array<{ label: string; cap: number }> = [
			{ label: 'maybeAct (144 KiB, both profiles)', cap: MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES },
			{ label: 'neighbors announce (64 KiB, both profiles)', cap: MAX_NEIGHBORS_BYTES },
			{ label: 'leave (fixed 4096)', cap: 4096 },
		]

		for (const { label, cap } of cases) {
			it(`refuses a ${label} frame declaring cap+1 bytes after exactly one pull`, async () => {
				const { source, pulls } = countingSource(4096, cap + 1)

				let thrown: unknown
				try { await readFramed(source, cap, 5000) } catch (err) { thrown = err }

				expect((thrown as Error)?.message, 'refused, not truncated').to.include('payload too large')
				expect(pulls(), 'the prefix alone was enough to know').to.equal(1)
			})
		}
	})

	describe('the largest legal message of each protocol encodes under its wire cap', () => {
		// Pure encoding checks — no network. A wire cap must never refuse this node's own legal
		// output, so each case builds the largest message the local profile can legitimately emit
		// and asserts it encodes smaller than the corresponding cap.

		/** A placeholder id of realistic length (base58btc peer ids run up to ~53 chars). */
		function fakeId(i: number): string {
			return `Qm${String(i).padStart(4, '0')}${'x'.repeat(47)}`
		}

		/**
		 * `metadata` whose `JSON.stringify` is exactly `allowance` bytes — the quantity
		 * `FretService.snapshot` measures against the profile's metadata budget. A test that
		 * instead sized the whole snapshot would be measuring a different number than the code.
		 * `{"m":"xxx…"}` is 8 characters of punctuation plus the payload. Measured in *encoded
		 * bytes*, not characters, because that is what the service measures — the two coincide for
		 * this ASCII payload, and asserting on the same quantity keeps them from drifting apart if
		 * the payload ever stops being ASCII.
		 */
		function metadataAtAllowance(allowance: number): Record<string, unknown> {
			const value = { m: 'x'.repeat(allowance - 8) }
			const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
			expect(bytes, 'metadata sized to the allowance exactly').to.equal(allowance)
			return value
		}

		/**
		 * A `hints` array packed to `budget` by the rule `FretService.buildAddressHints` applies —
		 * each hint costs `JSON.stringify(hint).length + 1`, and a hint that does not fit is
		 * skipped — with every record at the per-record cap, which is the largest hint the sender
		 * will emit and the receiver will keep. The pack is asserted to sit at the budget, not
		 * merely under it, so a case that silently packed nothing could not pass.
		 */
		function hintsAtBudget(budget: number): Array<{ id: string; record: string }> {
			const hints: Array<{ id: string; record: string }> = []
			let used = 0
			for (let i = 0; ; i++) {
				const hint = { id: fakeId(i + 300), record: 'x'.repeat(MAX_ADDRESS_RECORD_CHARS) }
				const cost = JSON.stringify(hint).length + 1
				if (used + cost > budget) break
				used += cost
				hints.push(hint)
			}
			expect(used, 'the pack reaches the budget to within one hint').to.be.greaterThan(budget - (MAX_ADDRESS_RECORD_CHARS + 128))
			return hints
		}

		// Both snapshot cases below build the id lists at the *merge* caps (Core 16/16/8, Edge
		// 8/8/6) rather than the narrower emission caps the service actually uses today (12/12/8,
		// 6/6/6). That is the conservative direction, and it keeps these cases valid if the
		// emission caps are ever widened to the merge caps.
		//
		// Both assert against `MAX_NEIGHBORS_BYTES`, never a per-profile number: the acceptance cap
		// bounds what a *peer* may send, and a peer may be running either profile. So the
		// requirement is "every profile's largest legal emission fits the one cap every peer
		// applies" — re-splitting the cap per profile fails here rather than on the wire.
		//
		// Each case asserts twice. The concrete build is what the sender emits at its worst; the
		// arithmetic bound (fixed fields + the whole hint budget + the field's framing) is the
		// invariant the constants carry, and holds whatever the hint packing does.
		it('neighbors snapshot at the core merge caps plus full metadata and hint budgets fits under MAX_NEIGHBORS_BYTES', async () => {
			const fixed = {
				v: 1,
				from: fakeId(9999),
				timestamp: Date.now(),
				successors: Array.from({ length: 16 }, (_, i) => fakeId(i)),
				predecessors: Array.from({ length: 16 }, (_, i) => fakeId(i + 100)),
				sample: Array.from({ length: 8 }, (_, i) => ({
					id: fakeId(i + 200),
					coord: coordToBase64url(new Uint8Array(COORD_BYTES)),
					relevance: 0.123456789,
				})),
				size_estimate: 123456,
				confidence: 0.87654321,
				sig: 'x'.repeat(256), // reserved for the unimplemented signature field
				metadata: metadataAtAllowance(MAX_SNAPSHOT_METADATA_BYTES_CORE),
			}
			const fixedBytes = (await encodeJson(fixed)).byteLength
			expect(fixedBytes + MAX_SNAPSHOT_HINT_BYTES_CORE + ',"hints":[]'.length, 'arithmetic bound').to.be.lessThan(MAX_NEIGHBORS_BYTES)
			const snapshot = { ...fixed, hints: hintsAtBudget(MAX_SNAPSHOT_HINT_BYTES_CORE) }
			expect((await encodeJson(snapshot)).byteLength, 'concrete worst build').to.be.lessThan(MAX_NEIGHBORS_BYTES)
		})

		it('neighbors snapshot at the edge merge caps plus full metadata and hint budgets fits under MAX_NEIGHBORS_BYTES', async () => {
			const fixed = {
				v: 1,
				from: fakeId(9999),
				timestamp: Date.now(),
				successors: Array.from({ length: 8 }, (_, i) => fakeId(i)),
				predecessors: Array.from({ length: 8 }, (_, i) => fakeId(i + 100)),
				sample: Array.from({ length: 6 }, (_, i) => ({
					id: fakeId(i + 200),
					coord: coordToBase64url(new Uint8Array(COORD_BYTES)),
					relevance: 0.123456789,
				})),
				size_estimate: 123456,
				confidence: 0.87654321,
				sig: 'x'.repeat(256),
				metadata: metadataAtAllowance(MAX_SNAPSHOT_METADATA_BYTES_EDGE),
			}
			const fixedBytes = (await encodeJson(fixed)).byteLength
			expect(fixedBytes + MAX_SNAPSHOT_HINT_BYTES_EDGE + ',"hints":[]'.length, 'arithmetic bound').to.be.lessThan(MAX_NEIGHBORS_BYTES)
			const snapshot = { ...fixed, hints: hintsAtBudget(MAX_SNAPSHOT_HINT_BYTES_EDGE) }
			expect((await encodeJson(snapshot)).byteLength, 'concrete worst build').to.be.lessThan(MAX_NEIGHBORS_BYTES)
		})

		it('both profiles accept neighbors messages up to the same cap', async () => {
			// The relation the two cases above rest on: there is one acceptance number, so "fits
			// under MAX_NEIGHBORS_BYTES" really does mean "every peer will read it". Re-introducing
			// a profile split fails here rather than silently on the wire.
			const nodes = await Promise.all([createMemNode(), createMemNode()])
			try {
				const caps = (['core', 'edge'] as const).map((profile, i) =>
					(new CoreFretService(nodes[i]!, { profile, networkName: NETWORK }) as unknown as { maxBytesNeighbors(): number }).maxBytesNeighbors()
				)
				expect(caps, 'core and edge apply the same neighbors acceptance cap').to.deep.equal([MAX_NEIGHBORS_BYTES, MAX_NEIGHBORS_BYTES])
			} finally {
				await stopAll(nodes)
			}
		})

		it('leave notice at MAX_REPLACEMENTS (12) fits under the fixed 4096 cap', async () => {
			const notice = {
				v: 1,
				from: fakeId(9999),
				timestamp: Date.now(),
				replacements: Array.from({ length: MAX_REPLACEMENTS }, (_, i) => fakeId(i)),
			}
			expect((await encodeJson(notice)).byteLength).to.be.lessThan(4096)
		})

		it('maybeAct at MAX_ACTIVITY_BYTES plus max-length key/correlation_id/digest/breadcrumbs fits under 144 KiB on both profiles', async () => {
			const msg = {
				v: 1,
				key: coordToBase64url(new Uint8Array(COORD_BYTES)),
				want_k: 15,
				wants: 15,
				ttl: 32,
				min_sigs: 14,
				digest: 'd'.repeat(MAX_DIGEST_CHARS),
				activity: 'a'.repeat(MAX_ACTIVITY_BYTES),
				breadcrumbs: Array.from({ length: MAX_BREADCRUMBS }, (_, i) => fakeId(i)),
				correlation_id: 'c'.repeat(MAX_CORRELATION_ID_CHARS),
				timestamp: Date.now(),
				signature: 'x'.repeat(512), // reserved for the unimplemented signature field
			}
			expect((await encodeJson(msg)).byteLength).to.be.lessThan(MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES)
		})
	})

	// =============================================================================================
	// Phase 3 — token buckets
	// =============================================================================================

	type MaybeActReply = NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }

	/** The private surface these tests drive. Bucket capacities are pinned by `profile.behavior.spec.ts`. */
	interface Drivable {
		handleMaybeAct(msg: unknown): Promise<MaybeActReply>
		handleNeighborsRequest(): Promise<NeighborSnapshotV1 | BusyResponseV1>
		handlePingRequest(): { size_estimate?: number; confidence?: number } | BusyResponseV1
		handleLeave(notice: LeaveNoticeV1): Promise<void>
		handleAnnounce(from: string, snap: NeighborSnapshotV1): void
		bucketMaybeAct: TokenBucket
		bucketNeighbors: TokenBucket
		bucketPing: TokenBucket
		bucketLeave: TokenBucket
		bucketAnnounceInbound: TokenBucket
		dedupCache: { get(key: string): unknown }
	}

	const drivable = (svc: CoreFretService): Drivable => svc as unknown as Drivable

	function drain(bucket: TokenBucket): number {
		let taken = 0
		while (bucket.tryTake()) taken++
		return taken
	}

	function isBusy(res: unknown): res is BusyResponseV1 {
		return typeof res === 'object' && res !== null && (res as BusyResponseV1).busy === true
	}

	let seq = 0
	function maybeActMsg(over: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			v: 1,
			key: coordToBase64url(new Uint8Array(COORD_BYTES)),
			want_k: 2,
			ttl: 4,
			min_sigs: 1,
			correlation_id: `bucket-${++seq}`,
			timestamp: Date.now(),
			signature: '',
			...over,
		}
	}

	function snapshotFrom(from: string): NeighborSnapshotV1 {
		return { v: 1, from, timestamp: Date.now(), successors: [], predecessors: [], sig: '' }
	}

	/**
	 * A parseable peer id. `mergeAnnounceSnapshot` hashes `from` via `peerIdFromString`, so a
	 * made-up id makes the merge fail for a reason that has nothing to do with the bucket — and
	 * would let a "was not merged" assertion pass even with the rate limit removed.
	 */
	async function newPeerIdString(): Promise<string> {
		return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
	}

	describe('inbound token buckets', () => {
		let node: Libp2p

		beforeEach(async () => {
			node = await createMemNode()
			await node.start()
		})

		afterEach(async () => {
			await stopAll([node])
		})

		/** Unstarted: no stabilization tick can spend a token behind the test's back. */
		function service(profile: 'core' | 'edge' = 'edge'): CoreFretService {
			return new CoreFretService(node, { profile, networkName: `${NETWORK}-${++seq}` })
		}

		// -----------------------------------------------------------------------------------------
		// Each protocol makes a rejection observable in its own way, and the *differences* are the
		// contract worth pinning.
		// -----------------------------------------------------------------------------------------

		it('answers maybeAct with busy + a positive retry_after_ms once its bucket is drained', async () => {
			const svc = service()
			const d = drivable(svc)
			drain(d.bucketMaybeAct)
			const before = svc.getDiagnostics().rejected.rateLimited.maybeAct

			const res = await d.handleMaybeAct(maybeActMsg())

			expect(isBusy(res), 'busy reply').to.equal(true)
			expect((res as BusyResponseV1).retry_after_ms).to.be.greaterThan(0)
			expect(svc.getDiagnostics().rejected.rateLimited.maybeAct - before, 'counted exactly once').to.equal(1)
		})

		it('answers a neighbors request with busy + a positive retry_after_ms once its bucket is drained', async () => {
			const svc = service()
			const d = drivable(svc)
			drain(d.bucketNeighbors)
			const before = svc.getDiagnostics().rejected.rateLimited.neighbors

			const res = await d.handleNeighborsRequest()

			expect(isBusy(res), 'busy reply').to.equal(true)
			expect((res as BusyResponseV1).retry_after_ms).to.be.greaterThan(0)
			expect(svc.getDiagnostics().rejected.rateLimited.neighbors - before).to.equal(1)
		})

		it('answers ping with busy + a positive retry_after_ms once its bucket is drained', async () => {
			const svc = service()
			const d = drivable(svc)
			drain(d.bucketPing)
			const before = svc.getDiagnostics().rejected.rateLimited.ping

			const res = d.handlePingRequest()

			expect(isBusy(res), 'busy reply').to.equal(true)
			expect((res as BusyResponseV1).retry_after_ms).to.be.greaterThan(0)
			expect(svc.getDiagnostics().rejected.rateLimited.ping - before).to.equal(1)
		})

		it('silently ignores a rate-limited leave — visible only as a counter', async () => {
			const svc = service()
			const d = drivable(svc)
			const departing = 'peer-departing'
			svc.getStore().upsert(departing, await hashKey(enc.encode(departing)))
			drain(d.bucketLeave)
			const before = svc.getDiagnostics().rejected.rateLimited.leave

			await d.handleLeave({ v: 1, from: departing, timestamp: Date.now() })

			// `handleLeave` returns void either way, so the *only* local evidence is that the peer
			// was not removed and the counter moved. See the wire-level asymmetry test below.
			expect(svc.getStore().getById(departing), 'the notice was not acted on').to.not.equal(undefined)
			expect(svc.getDiagnostics().rejected.rateLimited.leave - before).to.equal(1)
		})

		it('drops a rate-limited inbound announce and counts it', async () => {
			const svc = service()
			const d = drivable(svc)
			const announcer = await newPeerIdString()

			// Control first: with tokens available the same message *does* merge, so the negative
			// assertion below is about the bucket rather than about a message that could never work.
			d.handleAnnounce(announcer, snapshotFrom(announcer))
			await waitUntil(() => svc.getStore().getById(announcer) != null, 2000, 'the control announce merged')
			svc.getStore().remove(announcer)

			drain(d.bucketAnnounceInbound)
			const before = svc.getDiagnostics().rejected.rateLimited.announce

			d.handleAnnounce(announcer, snapshotFrom(announcer))

			await sleep(50) // the merge is detached; give one that should not run every chance to
			expect(svc.getStore().getById(announcer), 'never merged').to.equal(undefined)
			expect(svc.getDiagnostics().rejected.rateLimited.announce - before).to.equal(1)
		})

		// The maybeAct in-flight concurrency cap (Core 16 / Edge 4) also answers busy, with a
		// fixed `retry_after_ms` of 500. It is not a bucket and no longer shares this counter —
		// it increments the sibling `rejected.concurrencyLimited`, pinned by
		// `inflight-concurrency.spec.ts` — so the five sub-fields summed below have exactly the
		// five bucket paths as contributors, and no other.
		it('increments the matching rateLimited field exactly once on every bucket path', async () => {
			const svc = service()
			const d = drivable(svc)
			drain(d.bucketMaybeAct)
			drain(d.bucketNeighbors)
			drain(d.bucketPing)
			drain(d.bucketLeave)
			drain(d.bucketAnnounceInbound)
			// Spread the *counter record*, not `rejected` — `{ ...rejected }` shallow-copies and
			// `before.rateLimited` would alias the live object (same hazard as the wire test below).
			const before = { ...svc.getDiagnostics().rejected.rateLimited }

			await d.handleMaybeAct(maybeActMsg())
			await d.handleNeighborsRequest()
			d.handlePingRequest()
			await d.handleLeave({ v: 1, from: await newPeerIdString(), timestamp: Date.now() })
			const announcer = await newPeerIdString()
			d.handleAnnounce(announcer, snapshotFrom(announcer))

			// Per field, not summed: a sum of 5 also passes when one path double-counts and another
			// counts nothing, which is exactly the mis-keying the split makes possible. Attribution is
			// what the keyed record bought, so assert it.
			const after = svc.getDiagnostics().rejected.rateLimited
			for (const path of ['neighbors', 'ping', 'maybeAct', 'leave', 'announce'] as const) {
				expect(after[path] - before[path], `${path} counted exactly once`).to.equal(1)
			}
		})

		it('keeps the buckets independent — draining maybeAct leaves the other four answering', async () => {
			const svc = service()
			const d = drivable(svc)
			const departing = 'peer-leaving'
			svc.getStore().upsert(departing, await hashKey(enc.encode(departing)))
			drain(d.bucketMaybeAct)
			const before = svc.getDiagnostics().rejected.rateLimited.maybeAct

			expect(isBusy(await d.handleMaybeAct(maybeActMsg())), 'maybeAct is drained').to.equal(true)
			expect(isBusy(await d.handleNeighborsRequest()), 'neighbors still answers').to.equal(false)
			expect(isBusy(d.handlePingRequest()), 'ping still answers').to.equal(false)

			await d.handleLeave({ v: 1, from: departing, timestamp: Date.now() })
			expect(svc.getStore().getById(departing), 'leave still acted on').to.equal(undefined)

			const announcer = await newPeerIdString()
			d.handleAnnounce(announcer, snapshotFrom(announcer))
			await waitUntil(() => svc.getStore().getById(announcer) != null, 2000, 'announce still merged')

			expect(svc.getDiagnostics().rejected.rateLimited.maybeAct - before, 'only the maybeAct rejection').to.equal(1)
		})

		it('refills every one of the five buckets after the wait it reports', async () => {
			const svc = service()
			const d = drivable(svc)
			const buckets: Array<[string, TokenBucket]> = [
				['maybeAct', d.bucketMaybeAct],
				['neighbors', d.bucketNeighbors],
				['ping', d.bucketPing],
				['leave', d.bucketLeave],
				['announceInbound', d.bucketAnnounceInbound],
			]

			for (const [name, bucket] of buckets) {
				drain(bucket)
				// Ask the bucket rather than hard-coding a sleep, so this tracks the profile constants
				// if they ever change. Edge refills are 2–5/s, i.e. 200–500ms each — the whole loop
				// stays far under the 10-minute runner idle timeout.
				const wait = bucket.retryAfterMs()
				expect(wait, `${name}: a drained bucket reports a positive wait`).to.be.greaterThan(0)
				expect(wait, `${name}: the wait is short enough to test with real time`).to.be.lessThan(2000)

				expect(bucket.tryTake(), `${name}: still empty before the wait`).to.equal(false)
				await sleep(wait + 50)
				expect(bucket.tryTake(), `${name}: admitted after the wait`).to.equal(true)
			}
		})

		it('answers ping again once its bucket refills — the refill is observable through the handler', async () => {
			const svc = service()
			const d = drivable(svc)
			drain(d.bucketPing)

			expect(isBusy(d.handlePingRequest()), 'busy before the wait').to.equal(true)
			await sleep(d.bucketPing.retryAfterMs() + 50)
			expect(isBusy(d.handlePingRequest()), 'admitted after the wait').to.equal(false)
		})

		it('rejects on Edge the same burst Core absorbs', async () => {
			// The capacities themselves are pinned by `test/profile.behavior.spec.ts` (Core 32 /
			// Edge 8 for maybeAct); this asserts the behavioral consequence rather than restating
			// the numbers.
			// NOTE: the Edge arm is the one assertion in this file that depends on wall time — 12
			// calls against 8 tokens refilling at 4/s only produce a busy while the loop runs faster
			// than ~83ms per call. It runs in-process against an empty store, so today it is ~3
			// orders of magnitude clear of that. If this ever flakes on a loaded machine, pin the
			// clock rather than widening the burst: a wider burst restores the margin but stops
			// distinguishing "Edge rejects sooner" from "Edge rejects eventually".
			const burst = async (profile: 'core' | 'edge'): Promise<number> => {
				const svc = service(profile)
				let busies = 0
				for (let i = 0; i < 12; i++) {
					if (isBusy(await drivable(svc).handleMaybeAct(maybeActMsg()))) busies++
				}
				return busies
			}

			expect(await burst('core'), 'Core absorbs a 12-message burst').to.equal(0)
			expect(await burst('edge'), 'Edge rejects part of the same burst').to.be.greaterThan(0)
		})

		// -----------------------------------------------------------------------------------------
		// Interactions with the guards around the bucket.
		// -----------------------------------------------------------------------------------------

		it('takes the token before validation, so a malformed message on an empty bucket is busy', async () => {
			const svc = service()
			const d = drivable(svc)
			drain(d.bucketMaybeAct)
			// Shallow spread: `before.rateLimited` is the same object reference as the live
			// counter, so the scalar sub-field must be captured by value separately.
			const before = { ...svc.getDiagnostics().rejected }
			const beforeMaybeActRateLimited = svc.getDiagnostics().rejected.rateLimited.maybeAct

			const res = await d.handleMaybeAct(maybeActMsg({ breadcrumbs: 5 }))

			// The ordering `rpc-handler-fault-isolation` established: bucket, then validator, then
			// routing. A malformed flood is metered like any other, and a message that never got a
			// token was never inspected.
			expect(isBusy(res), 'busy, not the static malformed reject').to.equal(true)
			const after = svc.getDiagnostics().rejected
			expect(after.malformed - before.malformed, 'the validator never ran').to.equal(0)
			expect(after.rateLimited.maybeAct - beforeMaybeActRateLimited).to.equal(1)
		})

		it('never caches a busy reply, so a retry after refill gets real work done', async () => {
			const svc = service()
			const d = drivable(svc)
			const correlationId = 'retry-after-busy'
			drain(d.bucketMaybeAct)

			const busy = await d.handleMaybeAct(maybeActMsg({ correlation_id: correlationId }))
			expect(isBusy(busy)).to.equal(true)

			// A `busy` is not a terminal answer for the phase, so it must not occupy the dedup slot —
			// the phase-collision rule from `docs/fret.md` applied to the rate-limit path.
			expect(d.dedupCache.get(`${correlationId}|digest`), 'busy was not cached').to.equal(undefined)

			await sleep(d.bucketMaybeAct.retryAfterMs() + 50)

			const real = await d.handleMaybeAct(maybeActMsg({ correlation_id: correlationId }))
			expect(isBusy(real), 'answered for real after refill').to.equal(false)
			expect((real as NearAnchorV1).estimated_cluster_size, 'a genuine answer, not a cached refusal')
				.to.be.greaterThan(0)
		})
	})

	// ---------------------------------------------------------------------------------------------
	// The wire-visible half of the bucket contract: every rate-limited path still answers or closes,
	// and leave's asymmetry is only observable here.
	// ---------------------------------------------------------------------------------------------
	describe('rate-limited requests over a real connection', () => {
		let receiver: Libp2p
		let sender: Libp2p
		let svc: CoreFretService

		beforeEach(async () => {
			receiver = await createMemNode()
			sender = await createMemNode()
			await receiver.start()
			await sender.start()
			svc = new CoreFretService(receiver, { profile: 'edge', networkName: NETWORK })
			await (svc as unknown as { registerRpcHandlers(): Promise<void> }).registerRpcHandlers()
			await sender.dial(receiver.getMultiaddrs()[0]!)
		})

		afterEach(async () => {
			await stopAll([sender, receiver])
		})

		function openStreams(protocol: string): number {
			return receiver.getConnections(sender.peerId)
				.flatMap((c) => c.streams)
				.filter((s) => s.protocol === protocol && s.status === 'open')
				.length
		}

		async function request(protocol: string, payload: string): Promise<Uint8Array | undefined> {
			const stream = await sender.dialProtocol(receiver.peerId, [protocol])
			try {
				sendFramed(stream, enc.encode(payload))
				await stream.close()
				return await readFramed(stream, 64 * 1024, 3000)
			} catch {
				try { stream.abort(new Error('request: receiver aborted')) } catch { /* already gone */ }
				return undefined
			}
		}

		it('answers every message of a burst that empties the bucket, leaving no stream open', async () => {
			// Edge maybeAct burst is 8 with 4/s refill, so 14 sequential messages must drive the
			// bucket empty — and every one of them still has to be answered. A drained bucket that
			// swallowed the reply would leave the sender waiting on its read deadline and the
			// receiver holding an inbound stream slot.
			const replies: Array<NearAnchorV1 | BusyResponseV1> = []
			for (let i = 0; i < 14; i++) {
				const bytes = await request(P.PROTOCOL_MAYBE_ACT, JSON.stringify(maybeActMsg()))
				expect(bytes, `message ${i} was answered`).to.not.equal(undefined)
				replies.push(await decodeJson<NearAnchorV1 | BusyResponseV1>(bytes!))
			}

			expect(replies.some(isBusy), 'the burst emptied the bucket').to.equal(true)
			expect(replies.every((r) => r.v === 1), 'every reply is a well-formed v1 message').to.equal(true)
			await waitUntil(() => openStreams(P.PROTOCOL_MAYBE_ACT) === 0, 2000, 'no inbound stream left open')
		})

		it('makes a rate-limited leave indistinguishable from an accepted one on the wire', async () => {
			const senderId = sender.peerId.toString()
			const store = svc.getStore()
			store.upsert(senderId, await hashKey(enc.encode(senderId)))

			drain(drivable(svc).bucketLeave)
			const before = svc.getDiagnostics().rejected.rateLimited.leave

			const reply = await request(P.PROTOCOL_LEAVE, JSON.stringify({
				v: 1, from: senderId, timestamp: Date.now(),
			}))

			// This asymmetry is today's contract, recorded rather than endorsed: `handleLeave`
			// returns early *inside* the service while `registerLeave` has already committed to
			// sending `{ok: true}`, so the sender cannot tell a dropped notice from an accepted one
			// and will not retry. The only signal is local. `plan/15-rpc-shared-helper`'s
			// discriminated result type is what would let leave report a busy.
			expect(reply, 'still answered').to.not.equal(undefined)
			expect((await decodeJson<{ ok: boolean }>(reply!)).ok, 'answered ok despite being dropped').to.equal(true)
			expect(store.getById(senderId), 'but the notice was not acted on').to.not.equal(undefined)
			expect(svc.getDiagnostics().rejected.rateLimited.leave - before, 'visible only as a counter').to.equal(1)

			await waitUntil(() => openStreams(P.PROTOCOL_LEAVE) === 0, 2000, 'no inbound stream left open')
		})

		it('leaves no stream open when a drained neighbors bucket answers busy', async () => {
			drain(drivable(svc).bucketNeighbors)

			const reply = await request(P.PROTOCOL_NEIGHBORS, 'x')

			expect(reply, 'busy is still a reply').to.not.equal(undefined)
			expect(isBusy(await decodeJson(reply!))).to.equal(true)
			await waitUntil(() => openStreams(P.PROTOCOL_NEIGHBORS) === 0, 2000, 'no inbound stream left open')
		})
	})

	// -----------------------------------------------------------------------------------------
	// Wire-shape parsers (`src/rpc/validate.ts`).
	//
	// Two properties and a table, because they catch different failures. The properties cover the
	// two directions a parser drifts: (1) it never rejects what `encodeJson` produced from a
	// *legal* message — the over-strict direction, which no hand-written case finds, since the
	// cases are written by whoever wrote the rule; and (2) it never throws, on anything at all —
	// the under-defensive direction, which is the whole reason the parsers exist (a guard that
	// threw used to leak the inbound stream). The table then pins the *normalized value*, since
	// truncation and drop-entry are invisible to a "did not reject" assertion.
	// -----------------------------------------------------------------------------------------
	describe('wire-shape parsers', () => {
		// The receiver's own merge caps (Core). `makeSnapshotParser` is a factory precisely so
		// these are the service's numbers passed in once rather than a second copy that drifts.
		const CAPS = { successors: 16, predecessors: 16, sample: 8 }
		const parseSnapshot = makeSnapshotParser(CAPS)

		// Peer ids have to be *real* here. This file's other arbitraries draw ids from
		// `arbNastyString` on purpose — they prove the codec is lossless, not that a validator
		// accepts them — so reusing them would make every legal-message property fail on `from`.
		// Each id also gets a genuine signed address record (a real envelope, base64url) so a
		// legal snapshot's `hints` are what a sender actually emits, not merely well-typed.
		const legalPeerIds: string[] = []
		const legalRecords = new Map<string, string>()
		before(async () => {
			for (let i = 0; i < 8; i++) {
				const key = await generateKeyPair('Ed25519')
				const id = peerIdFromPrivateKey(key)
				legalPeerIds.push(id.toString())
				const record = new PeerRecord({ peerId: id, multiaddrs: [multiaddr(`/ip4/127.0.0.1/tcp/${4000 + i}`)], seqNumber: BigInt(i + 1) })
				legalRecords.set(id.toString(), u8ToString((await RecordEnvelope.seal(record, key)).marshal(), 'base64url'))
			}
		})
		const arbPeerId = fc.nat({ max: 7 }).map((i) => legalPeerIds[i]!)

		// ---- the legal side: what our own encoder can produce from a valid message ----

		/** The ids a snapshot names — what the parser ties `hints` to. Post-`withOptionals`, since
		 *  an absent `sample` names nobody. */
		function namedIds(snap: { from: string; successors: string[]; predecessors: string[]; sample?: Array<{ id: string }> }): string[] {
			return [...new Set([snap.from, ...snap.successors, ...snap.predecessors, ...(snap.sample ?? []).map((s) => s.id)])]
		}

		const arbLegalSnapshot: fc.Arbitrary<NeighborSnapshotV1> = withOptionals(fc.record({
			v: fc.constant(1 as const),
			from: arbPeerId,
			timestamp: arbJsonNumber,
			successors: fc.array(arbPeerId, { maxLength: 8 }),
			predecessors: fc.array(arbPeerId, { maxLength: 8 }),
			sample: fc.array(
				fc.record({ id: arbPeerId, coord: arbCoordB64, relevance: arbJsonNumber }),
				{ maxLength: 6 }
			),
			size_estimate: arbNonNegativeJsonNumber,
			confidence: arbUnitInterval,
			sig: arbNastyString,
			metadata: arbMetadata,
		}), ['sample', 'size_estimate', 'confidence', 'metadata'])
			// `hints` are chained off the finished snapshot: the sender only emits a record for an
			// id it names, so the legal set depends on which lists survived `withOptionals`.
			.chain((snap) => fc.tuple(fc.boolean(), fc.subarray(namedIds(snap))).map(([present, ids]) => {
				if (!present) return snap
				return { ...snap, hints: ids.map((id) => ({ id, record: legalRecords.get(id)! })) }
			}))

		const arbLegalRouteAndMaybeAct = withOptionals(fc.record({
			v: fc.constant(1 as const),
			key: arbCoordB64,
			want_k: arbJsonNumber,
			wants: arbJsonNumber,
			ttl: arbJsonNumber,
			min_sigs: arbJsonNumber,
			digest: fc.string({ maxLength: 64 }),
			activity: arbNastyString,
			breadcrumbs: fc.array(arbPeerId, { maxLength: 8 }),
			correlation_id: fc.string({ maxLength: 64 }),
			timestamp: arbJsonNumber,
			signature: arbNastyString,
		}), [...MAYBE_ACT_OPTIONALS])

		// `replacements` is generated non-empty: an empty list sanitizes to *absent*, which is the
		// documented normalization and is pinned in the table below rather than here.
		const arbLegalLeaveNotice = withOptionals(fc.record({
			v: fc.constant(1 as const),
			from: arbPeerId,
			replacements: fc.array(arbPeerId, { minLength: 1, maxLength: 12 }),
			timestamp: arbJsonNumber,
		}), [...LEAVE_OPTIONALS])

		const arbLegalNearAnchor: fc.Arbitrary<NearAnchorV1> = fc.record({
			v: fc.constant(1 as const),
			anchors: fc.array(arbPeerId, { maxLength: 2 }),
			cohort_hint: fc.array(arbPeerId, { maxLength: 8 }),
			estimated_cluster_size: arbJsonNumber,
			confidence: arbUnitInterval,
		})

		const arbLegalPingResponse: fc.Arbitrary<PingResponseV1> = withOptionals(fc.record({
			ok: fc.boolean(),
			ts: arbJsonNumber,
			size_estimate: arbNonNegativeJsonNumber,
			confidence: arbUnitInterval,
		}), ['size_estimate', 'confidence'])

		/** Push a value through the real wire codec, exactly as a handler would receive it. */
		async function overTheWire(value: unknown): Promise<unknown> {
			return decodeJson(await encodeJson(value))
		}

		describe('never reject what our own encoder produced', () => {
			it('NeighborSnapshot', async () => {
				const region = { withHints: 0 }
				await fc.assert(fc.asyncProperty(arbLegalSnapshot, async (snap) => {
					if ((snap.hints?.length ?? 0) > 0) region.withHints++
					const parsed = parseSnapshot(await overTheWire(snap))
					expect(parsed, 'legal snapshot rejected').to.not.equal(undefined)
					// Nothing is normalized away either. The two differences: an absent `sample`
					// becomes `[]` so the merge loop never has to re-check the field, and an *empty*
					// `hints` is dropped, since "no records" is what absence means.
					const expected: NeighborSnapshotV1 = { ...snap, sample: snap.sample ?? [] }
					if (expected.hints?.length === 0) delete expected.hints
					expect(parsed).to.deep.equal(expected)
				}), opts)
				expect(region.withHints, 'no snapshot carrying real hints was generated').to.be.greaterThan(0)
			})

			it('RouteAndMaybeAct', async () => {
				await fc.assert(fc.asyncProperty(arbLegalRouteAndMaybeAct, async (msg) => {
					const parsed = parseRouteAndMaybeAct(await overTheWire(msg))
					expect(parsed, 'legal maybeAct rejected').to.not.equal(undefined)
					// This one normalizes nothing, so the decoded message comes back untouched.
					expect(parsed).to.deep.equal(msg)
				}), opts)
			})

			it('LeaveNotice', async () => {
				await fc.assert(fc.asyncProperty(arbLegalLeaveNotice, async (notice) => {
					const parsed = parseLeaveNotice(await overTheWire(notice))
					expect(parsed, 'legal leave notice rejected').to.not.equal(undefined)
					expect(parsed).to.deep.equal(notice)
				}), opts)
			})

			it('NearAnchor, as itself and as a maybeAct reply', async () => {
				await fc.assert(fc.asyncProperty(arbLegalNearAnchor, async (reply) => {
					const wire = await overTheWire(reply)
					expect(parseNearAnchor(wire), 'legal NearAnchor rejected').to.deep.equal(reply)
					expect(parseMaybeActReply(wire), 'same reply through the maybeAct arm').to.deep.equal(reply)
				}), opts)
			})

			it('a commit certificate reply', async () => {
				await fc.assert(fc.asyncProperty(arbNastyString, async (cert) => {
					const parsed = parseMaybeActReply(await overTheWire({ commitCertificate: cert }))
					expect(parsed).to.deep.equal({ commitCertificate: cert })
				}), opts)
			})

			it('PingResponse, projected to what sendPing returns', async () => {
				await fc.assert(fc.asyncProperty(arbLegalPingResponse, async (reply) => {
					const parsed = parsePingResponse(await overTheWire(reply))
					// `ts` is carried by the wire type and read by nobody, so it is projected away
					// — but it must never make the reply *reject*.
					const expected: Record<string, unknown> = { ok: reply.ok }
					if (reply.size_estimate !== undefined) expected.size_estimate = reply.size_estimate
					if (reply.confidence !== undefined) expected.confidence = reply.confidence
					expect(parsed).to.deep.equal(expected)
				}), opts)
			})
		})

		describe('never throw, whatever arrives', () => {
			// The deliberately-illegal arbitraries from the top of this file are exactly right
			// here: their ids and coords are `arbNastyString`, i.e. the shapes a hostile or
			// version-skewed peer sends.
			const arbAnything: fc.Arbitrary<unknown> = fc.oneof(
				arbJsonValue,
				arbNeighborSnapshot,
				arbRouteAndMaybeAct,
				arbNearAnchor,
				arbLeaveNotice,
				arbSerializedTable,
				fc.record({ ok: arbJsonValue, ts: arbJsonValue }),
				fc.record({ commitCertificate: arbJsonValue })
			)

			const PARSERS: Array<[string, Parser<unknown>]> = [
				['parseRouteAndMaybeAct', parseRouteAndMaybeAct],
				['parseLeaveNotice', parseLeaveNotice],
				['makeSnapshotParser', parseSnapshot],
				['parsePingResponse', parsePingResponse],
				['parseNearAnchor', parseNearAnchor],
				['parseMaybeActReply', parseMaybeActReply],
			]

			it('returns undefined or a normalized value — never an exception', () => {
				fc.assert(fc.property(arbAnything, (value) => {
					for (const [name, parse] of PARSERS) {
						expect(() => parse(value), name).to.not.throw()
					}
				}), opts)
			})

			// The shapes that used to throw rather than reject, kept as explicit cases so a
			// regression names itself instead of surfacing as a shrunk counterexample.
			const hostile: unknown[] = [
				null, undefined, [], 'a string', 7, true,
				{ successors: 5 }, { successors: [null, 1, {}] },
				{ sample: 'not an array' }, { sample: [null, 7, { id: 1 }] },
				{ replacements: 5 }, { anchors: {} }, { cohort_hint: 7 },
				Object.create(null) as unknown,
			]
			for (const [i, value] of hostile.entries()) {
				it(`survives hostile shape #${i}`, () => {
					for (const [name, parse] of PARSERS) {
						expect(() => parse(value), name).to.not.throw()
					}
				})
			}
		})

		describe('NeighborSnapshot normalization', () => {
			const snap = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
				v: 1, from: legalPeerIds[0], timestamp: 1,
				successors: [], predecessors: [], sig: '', ...over,
			})
			const ids = (n: number, prefix = 's'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

			it('rejects a message whose `from` is not a peer id', () => {
				expect(parseSnapshot(snap({ from: 'not-a-peer-id' })), 'unparseable').to.equal(undefined)
				expect(parseSnapshot(snap({ from: 7 })), 'numeric').to.equal(undefined)
				const noFrom = snap(); delete noFrom.from
				expect(parseSnapshot(noFrom), 'absent').to.equal(undefined)
			})

			it('rejects a message whose `timestamp` is not finite', () => {
				expect(parseSnapshot(snap({ timestamp: 'now' })), 'string').to.equal(undefined)
				// A legal non-finite arrives as `null` (the codec's documented loss), so the
				// finite check has to reject `null` rather than throw on it.
				expect(parseSnapshot(snap({ timestamp: null })), 'null').to.equal(undefined)
				const noTs = snap(); delete noTs.timestamp
				expect(parseSnapshot(noTs), 'absent').to.equal(undefined)
			})

			it('normalizes absent id lists to empty ones', () => {
				const bare = snap(); delete bare.successors; delete bare.predecessors
				const parsed = parseSnapshot(bare)
				expect(parsed?.successors).to.deep.equal([])
				expect(parsed?.predecessors).to.deep.equal([])
				expect(parsed?.sample, 'absent sample too').to.deep.equal([])
			})

			it('keeps an id list that sits exactly on the cap', () => {
				const exact = ids(CAPS.successors)
				expect(parseSnapshot(snap({ successors: exact }))?.successors).to.deep.equal(exact)
			})

			it('truncates one over the cap rather than rejecting the message', () => {
				const over = ids(CAPS.successors + 1)
				const parsed = parseSnapshot(snap({ successors: over, predecessors: ids(40, 'p') }))
				expect(parsed, 'over-cap is not a rejection').to.not.equal(undefined)
				expect(parsed?.successors).to.deep.equal(over.slice(0, CAPS.successors))
				expect(parsed?.predecessors).to.have.lengthOf(CAPS.predecessors)
			})

			it('truncates *before* filtering, so a huge junk list costs cap-many comparisons', () => {
				// 16 non-strings then 4 strings: if the filter ran first the strings would survive.
				const crafted = [...Array.from({ length: CAPS.successors }, () => null), 'a', 'b', 'c', 'd']
				expect(parseSnapshot(snap({ successors: crafted }))?.successors).to.deep.equal([])
			})

			it('drops non-string id entries without rejecting the message', () => {
				const parsed = parseSnapshot(snap({ successors: ['a', null, 7, {}, 'b'] }))
				expect(parsed?.successors).to.deep.equal(['a', 'b'])
			})

			it('drops a sample entry that fails any of its three checks, keeping the rest', () => {
				const good = { id: 'ok', coord: coordToBase64url(new Uint8Array(COORD_BYTES)), relevance: 0.5 }
				const parsed = parseSnapshot(snap({
					sample: [
						good,
						{ id: 7, coord: good.coord, relevance: 1 },          // id not a string
						{ id: 'x', coord: 'AAAA', relevance: 1 },            // coord decodes short
						{ id: 'y', coord: good.coord, relevance: null },     // relevance not finite
						{ id: 'z', coord: 'not base64url!!', relevance: 1 }, // coord undecodable
						null,
					],
				}))
				expect(parsed, 'a bad entry drops the entry, not the message').to.not.equal(undefined)
				expect(parsed?.sample).to.deep.equal([good])
			})

			it('truncates the sample to the cap', () => {
				const coord = coordToBase64url(new Uint8Array(COORD_BYTES))
				const many = Array.from({ length: CAPS.sample + 4 }, (_, i) => ({ id: `s${i}`, coord, relevance: i }))
				expect(parseSnapshot(snap({ sample: many }))?.sample).to.have.lengthOf(CAPS.sample)
			})

			it('drops advisory numerics of the wrong type, keeping the message', () => {
				const parsed = parseSnapshot(snap({ size_estimate: 'lots', confidence: null }))
				expect(parsed, 'advisory fields never reject').to.not.equal(undefined)
				expect(parsed).to.not.have.property('size_estimate')
				expect(parsed).to.not.have.property('confidence')
				const kept = parseSnapshot(snap({ size_estimate: 42, confidence: 0.25 }))
				expect(kept?.size_estimate).to.equal(42)
				expect(kept?.confidence).to.equal(0.25)
			})

			it('drops out-of-range confidence/size_estimate independently, keeps in-range boundaries', () => {
				// confidence must land in [0, 1]; out of range drops the field, not the message
				const tooHigh = parseSnapshot(snap({ confidence: 1_000_000_000 }))
				expect(tooHigh, 'huge confidence never rejects the message').to.not.equal(undefined)
				expect(tooHigh).to.not.have.property('confidence')
				expect(parseSnapshot(snap({ confidence: -1 }))).to.not.have.property('confidence')

				// inclusive boundaries kept - 0 is a legitimate "no information" value (see
				// handlePingRequest's NearAnchor-empty reply), 1 is full confidence
				expect(parseSnapshot(snap({ confidence: 0 }))?.confidence).to.equal(0)
				expect(parseSnapshot(snap({ confidence: 1 }))?.confidence).to.equal(1)

				// size_estimate has no upper bound (cluster size), only a floor of 0
				expect(parseSnapshot(snap({ size_estimate: -1 }))).to.not.have.property('size_estimate')
				expect(parseSnapshot(snap({ size_estimate: 0 }))?.size_estimate).to.equal(0)
				expect(parseSnapshot(snap({ size_estimate: 1_000_000_000 }))?.size_estimate).to.equal(1_000_000_000)

				// each field drops independently: an in-range field survives an out-of-range sibling
				// without affecting it or rejecting the whole message
				const mixed = parseSnapshot(snap({ confidence: 0.5, size_estimate: -5 }))
				expect(mixed, 'mixed in/out-of-range never rejects').to.not.equal(undefined)
				expect(mixed?.confidence).to.equal(0.5)
				expect(mixed).to.not.have.property('size_estimate')

				const mixed2 = parseSnapshot(snap({ confidence: -5, size_estimate: 500 }))
				expect(mixed2).to.not.have.property('confidence')
				expect(mixed2?.size_estimate).to.equal(500)
			})

			// The hand-written test above pins the boundaries and a handful of sampled points; this
			// generalizes the *rule* over the whole finite-double domain — an in-range value is
			// preserved bit-for-bit, an out-of-range one drops that field alone, and neither ever
			// rejects the message. It is what would fail on a `>` / `>=` slip anywhere but at the
			// two sampled boundaries, and on a range check that rejected instead of dropping.
			it('range rule holds over arbitrary finite numbers, for both fields', () => {
				fc.assert(fc.property(
					fc.double({ noNaN: true, noDefaultInfinity: true }),
					fc.double({ noNaN: true, noDefaultInfinity: true }),
					(confidence, size_estimate) => {
						const out = parseSnapshot(snap({ confidence, size_estimate }))
						expect(out, 'a numeric field is advisory — it never rejects').to.not.equal(undefined)

						// `-0` is in range for both, and `Object.is` would distinguish it from the
						// `0` the codec delivers; `equal` is the right comparison for a magnitude.
						if (confidence >= 0 && confidence <= 1) expect(out?.confidence).to.equal(confidence)
						else expect(out).to.not.have.property('confidence')

						if (size_estimate >= 0) expect(out?.size_estimate).to.equal(size_estimate)
						else expect(out).to.not.have.property('size_estimate')
					}
				), { numRuns: 500 })
			})

			it('drops `metadata` unless it is a non-null non-array object', () => {
				for (const bad of [null, [], 'str', 7, true]) {
					expect(parseSnapshot(snap({ metadata: bad })), JSON.stringify(bad)).to.not.have.property('metadata')
				}
				expect(parseSnapshot(snap({ metadata: { a: 1 } }))?.metadata).to.deep.equal({ a: 1 })
			})

			// Hints are structural here — a record only has to *be* base64url. Whether it decodes
			// to an envelope, who signed it, and whether the signature holds are ingestion's job
			// (`test/address-hints.ingest.spec.ts`), where the store entry and the peerStore are.
			it('keeps a hint only for a named id, once, with a decodable record no longer than the cap', () => {
				const [from, s0, p0, sample0, stranger] = legalPeerIds as [string, string, string, string, string]
				const rec = (n: number): string => u8ToString(new Uint8Array(n).fill(7), 'base64url')
				const coord = coordToBase64url(new Uint8Array(COORD_BYTES))
				const parsed = parseSnapshot(snap({
					from,
					successors: [s0],
					predecessors: [p0],
					sample: [{ id: sample0, coord, relevance: 0.5 }],
					hints: [
						{ id: from, record: rec(64) },                            // `from` is named
						{ id: s0, record: rec(64) },
						{ id: s0, record: rec(65) },                              // duplicate id: first wins
						{ id: stranger, record: rec(64) },                        // not named
						{ id: p0, record: 'not base64url!!' },                    // undecodable
						{ id: sample0, record: 'x'.repeat(MAX_ADDRESS_RECORD_CHARS + 1) }, // over the cap
						{ id: 7, record: rec(64) },                               // id not a string
						{ id: p0 },                                               // record absent
						null,
						'string',
					],
				}))
				expect(parsed, 'bad hints drop the hint, never the message').to.not.equal(undefined)
				expect(parsed?.hints).to.deep.equal([{ id: from, record: rec(64) }, { id: s0, record: rec(64) }])
			})

			it('keeps a record sitting exactly on the cap and deletes `hints` when nothing survives', () => {
				const from = legalPeerIds[0]!
				const atCap = 'A'.repeat(MAX_ADDRESS_RECORD_CHARS)
				expect(parseSnapshot(snap({ from, hints: [{ id: from, record: atCap }] }))?.hints).to.deep.equal([{ id: from, record: atCap }])
				for (const empty of [[], [{ id: 'unnamed', record: 'AAAA' }], 'hints', 7, null]) {
					expect(parseSnapshot(snap({ from, hints: empty })), JSON.stringify(empty)).to.not.have.property('hints')
				}
			})

			it('ties the hint count to the named set: truncated ids cannot carry hints', () => {
				// 17 successors, cap 16: a hint for the 17th is a hint for an id the receiver never
				// merges, so it is dropped with the id rather than surviving on its own.
				const distinct = Array.from({ length: CAPS.successors + 1 }, (_, i) => `id${i}`)
				const parsed = parseSnapshot(snap({
					successors: distinct,
					hints: distinct.map((id) => ({ id, record: 'AAAA' })),
				}))
				expect(parsed?.successors).to.have.lengthOf(CAPS.successors)
				expect(parsed?.hints?.map((h) => h.id)).to.deep.equal(distinct.slice(0, CAPS.successors))
			})
		})

		describe('LeaveNotice normalization', () => {
			const notice = (over: Record<string, unknown> = {}): Record<string, unknown> =>
				({ v: 1, from: legalPeerIds[0], timestamp: 1, ...over })

			it('rejects a bad `from` or `timestamp`', () => {
				expect(parseLeaveNotice(notice({ from: 'nope' }))).to.equal(undefined)
				expect(parseLeaveNotice(notice({ timestamp: 'soon' }))).to.equal(undefined)
			})

			it('caps replacements at 12 and drops unparseable ids', () => {
				const twenty = Array.from({ length: 20 }, (_, i) => legalPeerIds[i % 8]!)
				expect(parseLeaveNotice(notice({ replacements: twenty }))?.replacements)
					.to.deep.equal(twenty.slice(0, 12))
				expect(parseLeaveNotice(notice({ replacements: [legalPeerIds[0], 'junk', 7] }))?.replacements)
					.to.deep.equal([legalPeerIds[0]])
			})

			it('reports an emptied replacement list as absent, not as []', () => {
				// The distinction is load-bearing: the receiver's `if (!replacements)` guard is
				// what keeps a leave notice from entering the record-replacements loop at all.
				for (const bad of [[], ['junk'], 5, null, undefined]) {
					const parsed = parseLeaveNotice(notice({ replacements: bad }))
					expect(parsed, JSON.stringify(bad ?? null)).to.not.equal(undefined)
					expect(parsed).to.not.have.property('replacements')
				}
			})
		})

		describe('reply normalization', () => {
			it('parsePingResponse demands a real boolean rather than coercing', () => {
				// `Boolean(r.ok)` is what this replaces: it turned every one of these into a
				// confident answer about a peer that had not actually said `ok`.
				for (const bad of [1, 0, 'true', null, undefined, {}]) {
					expect(parsePingResponse({ ok: bad, ts: 1 }), JSON.stringify(bad ?? null)).to.equal(undefined)
				}
				expect(parsePingResponse({ ok: false, ts: 1 })).to.deep.equal({ ok: false })
			})

			it('parsePingResponse drops advisory numerics individually', () => {
				expect(parsePingResponse({ ok: true, ts: 1, size_estimate: 'x', confidence: 0.5 }))
					.to.deep.equal({ ok: true, confidence: 0.5 })
			})

			it('parsePingResponse drops out-of-range confidence/size_estimate, keeps in-range boundaries', () => {
				expect(parsePingResponse({ ok: true, confidence: 1_000_000_000 })).to.not.have.property('confidence')
				expect(parsePingResponse({ ok: true, confidence: -1 })).to.not.have.property('confidence')
				expect(parsePingResponse({ ok: true, confidence: 0 })?.confidence).to.equal(0)
				expect(parsePingResponse({ ok: true, confidence: 1 })?.confidence).to.equal(1)

				expect(parsePingResponse({ ok: true, size_estimate: -1 })).to.not.have.property('size_estimate')
				expect(parsePingResponse({ ok: true, size_estimate: 0 })?.size_estimate).to.equal(0)
				expect(parsePingResponse({ ok: true, size_estimate: 1_000_000_000 })?.size_estimate)
					.to.equal(1_000_000_000)

				const mixed = parsePingResponse({ ok: true, confidence: 0.5, size_estimate: -5 })
				expect(mixed?.confidence).to.equal(0.5)
				expect(mixed).to.not.have.property('size_estimate')
			})

			it('parseNearAnchor rejects a reply that cannot state its numerics', () => {
				const base = { v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 3, confidence: 0.5 }
				expect(parseNearAnchor({ ...base, estimated_cluster_size: null })).to.equal(undefined)
				expect(parseNearAnchor({ ...base, confidence: 'high' })).to.equal(undefined)
				expect(parseNearAnchor(base)).to.deep.equal(base)
			})

			it('parseNearAnchor caps the hint lists and normalizes missing ones', () => {
				const parsed = parseNearAnchor({
					v: 1,
					anchors: Array.from({ length: 12 }, (_, i) => `a${i}`),
					cohort_hint: [...Array.from({ length: 20 }, (_, i) => `c${i}`), null],
					estimated_cluster_size: 3,
					confidence: 0.5,
				})
				expect(parsed?.anchors, 'anchors cap').to.have.lengthOf(8)
				expect(parsed?.cohort_hint, 'cohort hint cap').to.have.lengthOf(16)
				const bare = parseNearAnchor({ v: 1, estimated_cluster_size: 0, confidence: 0 })
				expect(bare?.anchors).to.deep.equal([])
				expect(bare?.cohort_hint).to.deep.equal([])
			})

			it('parseMaybeActReply discriminates on a string commitCertificate', () => {
				expect(parseMaybeActReply({ commitCertificate: 'cert' })).to.deep.equal({ commitCertificate: 'cert' })
				// A non-string `commitCertificate` is not the certificate arm, so it falls through
				// to the NearAnchor arm — which this shape fails.
				expect(parseMaybeActReply({ commitCertificate: 5 })).to.equal(undefined)
				expect(parseMaybeActReply({ v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 1, confidence: 1 }))
					.to.deep.equal({ v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 1, confidence: 1 })
			})
		})
	})
})

// =================================================================================================
// Phase 5 — the parsers as *wired*, not merely as functions
//
// The parsers above are pure and were already covered as functions. What this phase covers is the
// seam that consumes them: `rpcRequest`'s decode phase has no `undefined` check, so a `Parser`
// handed in raw returns `{ kind: 'ok', value: undefined }` on a rejection — an `ok` carrying
// `undefined` dressed as the reply, and it type-checks silently. `parseOrThrow` is the adapter
// that turns a rejection into a throw, which `rpcRequest` classifies as `decode-error`.
//
// So the properties below assert on the **value**, not merely on `kind`: written against a raw
// parser the malformed property fails (kind is `ok`), and asserting only `kind !== 'ok'` would
// pass vacuously against any throwing validator including a broken one.
// =================================================================================================

/** One whole framed message: varint length prefix + body. */
function frameOf(value: unknown): Uint8Array {
	return lp.encode.single(enc.encode(JSON.stringify(value))).subarray()
}

/** A stream that serves exactly one framed reply and then ends. */
function replyStream(reply: unknown): Stream {
	const chunks: Uint8Array[] = [frameOf(reply)]
	let i = 0
	const stream = {
		id: 'reply-stub',
		send: (): boolean => true,
		close: async (): Promise<void> => { /* released */ },
		abort: (): void => { /* released */ },
		[Symbol.asyncIterator]: () => ({
			next: async (): Promise<IteratorResult<Uint8Array>> => {
				const c = chunks[i++]
				return c === undefined ? { done: true, value: undefined } : { done: false, value: c }
			},
		}),
	}
	return stream as unknown as Stream
}

/** A node whose every RPC — dialed or over an existing connection — lands on `stream`. */
function nodeReplying(stream: Stream): Libp2p {
	const conn = { status: 'open', newStream: async () => stream }
	return {
		getConnections: () => [conn] as unknown as Connection[],
		dialProtocol: async () => stream,
	} as unknown as Libp2p
}

/**
 * The three senders that read a reply, each reduced to "serve this body, give me the outcome".
 * Keeping them in one table is what makes the properties below cover all three by construction
 * rather than by three near-copies that drift apart.
 */
interface WiredSender {
	name: string
	send: (node: Libp2p, peer: string) => Promise<RpcOutcome<unknown>>
	/** A legal reply this node's own encoders can produce. */
	legal: (selfId: string) => Record<string, unknown>
	/** What `ok.value` must be for that legal reply, after the parser's normalization. */
	expected: (selfId: string) => unknown
}

const MAYBE_ACT_MSG: RouteAndMaybeActV1 = {
	v: 1, key: coordToBase64url(new Uint8Array(COORD_BYTES)), want_k: 3, ttl: 4, min_sigs: 2,
	correlation_id: 'cid', timestamp: 1, signature: '',
}

const WIRED_SENDERS: WiredSender[] = [
	{
		name: 'sendPing',
		send: (node, peer) => sendPing(node, peer, P.PROTOCOL_PING, { timeoutMs: 500 }),
		legal: () => ({ ok: true, ts: 7, size_estimate: 42, confidence: 0.5 }),
		// `ts` is carried by the wire type and read by nobody, so the parser projects it away —
		// but it must not make the reply *reject*, which is what this pins.
		expected: () => ({ ok: true, size_estimate: 42, confidence: 0.5 }),
	},
	{
		name: 'fetchNeighbors',
		send: (node, peer) => fetchNeighbors(node, peer, P.PROTOCOL_NEIGHBORS, { timeoutMs: 500 }),
		legal: (selfId) => ({
			v: 1, from: selfId, timestamp: 1, successors: [], predecessors: [], sample: [], sig: '',
		}),
		expected: (selfId) => ({
			v: 1, from: selfId, timestamp: 1, successors: [], predecessors: [], sample: [], sig: '',
		}),
	},
	{
		name: 'sendMaybeAct',
		send: (node, peer) => sendMaybeAct(node, peer, MAYBE_ACT_MSG, P.PROTOCOL_MAYBE_ACT, { timeoutMs: 500 }),
		legal: () => ({ v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 3, confidence: 0.5 }),
		expected: () => ({ v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 3, confidence: 0.5 }),
	},
]

describe('reply parsers as wired into the senders', function () {
	this.timeout(30_000)

	let selfId: string

	before(async () => {
		selfId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
	})

	for (const sender of WIRED_SENDERS) {
		it(`${sender.name}: a legal reply from our own encoder survives the wired parser`, async () => {
			const out = await sender.send(nodeReplying(replyStream(sender.legal(selfId))), selfId)
			expect(out.kind, `${sender.name} must accept a legal reply`).to.equal('ok')
			expect(out.kind === 'ok' ? out.value : undefined).to.deep.equal(sender.expected(selfId))
		})
	}

	/**
	 * Field-type fuzzing over each sender's own legal reply: replace one field's value with a
	 * value of a different type. Every mutant either parses (the parser normalizes advisory
	 * fields rather than rejecting) or is refused — but it must never surface as an `ok` whose
	 * value is `undefined` or half-parsed, and the sender must never throw.
	 */
	const arbWrongTyped = fc.constantFrom<unknown>(null, 1, 'x', true, [], {})

	for (const sender of WIRED_SENDERS) {
		it(`${sender.name}: a malformed reply is decode-error, never a throw or an ok carrying undefined`, async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.nat(),
					arbWrongTyped,
					async (fieldIdx, value) => {
						const legal = sender.legal(selfId)
						const keys = Object.keys(legal)
						const mutant = { ...legal, [keys[fieldIdx % keys.length]]: value }
						// A throw out of a sender is itself the failure — `rpcRequest` never
						// throws for a network outcome, and a validator must not change that.
						const out = await sender.send(nodeReplying(replyStream(mutant)), selfId)
						if (out.kind === 'ok') {
							// A surviving mutant is one the parser normalized rather than
							// refused. It must still be a real value, never `undefined`.
							expect(out.value, 'ok must never carry undefined').to.not.equal(undefined)
							expect(out.value).to.be.an('object')
							return
						}
						expect(out.kind, 'a refused reply is decode-error').to.equal('decode-error')
						expect(out).to.not.have.property('value')
					}
				),
				{ numRuns: 120 }
			)
		})
	}

	it('a reply that is not an object at all is decode-error for every sender', async () => {
		for (const sender of WIRED_SENDERS) {
			for (const body of [null, 5, 'nope', [1, 2], true]) {
				const out = await sender.send(nodeReplying(replyStream(body)), selfId)
				expect(out.kind, `${sender.name} on ${JSON.stringify(body)}`).to.equal('decode-error')
				expect(out).to.not.have.property('value')
			}
		}
	})

	it('a busy reply is still busy, not a parser rejection', async () => {
		// The busy shape is tested on the parsed body *before* `decode` runs, so a validator never
		// sees one. Wiring a parser must not turn a peer saying "overloaded" into `decode-error` —
		// the service scores those differently (busy records backoff; decode-error decays relevance).
		for (const sender of WIRED_SENDERS) {
			const busy: BusyResponseV1 = { v: 1, busy: true, retry_after_ms: 250 }
			const out = await sender.send(nodeReplying(replyStream(busy)), selfId)
			expect(out.kind, sender.name).to.equal('busy')
		}
	})

	it('sendPing no longer coerces a non-boolean ok into a confident answer', async () => {
		// The `Boolean(r.ok)` coercion this replaced turned `ok: 1` into a confident `ok: true`
		// about a peer that never said so. Now it is a refused reply.
		const out = await sendPing(nodeReplying(replyStream({ ok: 1, ts: 1 })), selfId, P.PROTOCOL_PING, { timeoutMs: 500 })
		expect(out.kind).to.equal('decode-error')
	})

	it('fetchNeighbors truncates with the caps its caller supplies', async () => {
		// The parser comes from the caller because only the caller knows the profile's merge caps.
		// Supplying tight ones must truncate exactly as the merge loop would.
		const reply: NeighborSnapshotV1 = {
			v: 1, from: selfId, timestamp: 1,
			successors: ['a', 'b', 'c', 'd'], predecessors: ['e', 'f', 'g'], sample: [], sig: '',
		}
		const out = await fetchNeighbors(nodeReplying(replyStream(reply)), selfId, P.PROTOCOL_NEIGHBORS, {
			timeoutMs: 500,
			parse: makeSnapshotParser({ successors: 2, predecessors: 1, sample: 0 }),
		})
		expect(out.kind).to.equal('ok')
		const snap = out.kind === 'ok' ? out.value : undefined
		expect(snap?.successors).to.deep.equal(['a', 'b'])
		expect(snap?.predecessors).to.deep.equal(['e'])
	})

	it("the reply caps cannot refuse this node's own largest legal output", async () => {
		// `pickAnchors` yields at most 2 anchors and the widest cohort-hint producer
		// (`buildNearAnchor`) emits at most 8 ids, against caps of 8 and 16 — 4x and 2x headroom.
		const widest: NearAnchorV1 = {
			v: 1,
			anchors: ['a0', 'a1'],
			cohort_hint: Array.from({ length: 8 }, (_, i) => `c${i}`),
			estimated_cluster_size: 15,
			confidence: 0.5,
		}
		const out = await sendMaybeAct(nodeReplying(replyStream(widest)), selfId, MAYBE_ACT_MSG, P.PROTOCOL_MAYBE_ACT, { timeoutMs: 500 })
		expect(out.kind).to.equal('ok')
		expect(out.kind === 'ok' ? out.value : undefined).to.deep.equal(widest)
	})

	// The certificate arm is the one carrying the actual work result, and it is the arm whose
	// shape the wiring changed (it projects where the bare cast passed the whole body through).
	// `WIRED_SENDERS` serves a NearAnchor for `sendMaybeAct`, so without these the arm is covered
	// as a parser but never as *wired*.
	it('sendMaybeAct accepts a commit certificate and projects it to the declared shape', async () => {
		const reply = { v: 1, commitCertificate: 'cert-bytes', extra: 'ignored' }
		const out = await sendMaybeAct(nodeReplying(replyStream(reply)), selfId, MAYBE_ACT_MSG, P.PROTOCOL_MAYBE_ACT, { timeoutMs: 500 })
		expect(out.kind).to.equal('ok')
		// Exactly the declared shape: `RouteProgress.result` is `{commitCertificate: string}`, and
		// both read sites test `'commitCertificate' in ...` and read nothing else.
		expect(out.kind === 'ok' ? out.value : undefined).to.deep.equal({ commitCertificate: 'cert-bytes' })
	})

	it('sendMaybeAct refuses a certificate reply whose certificate is not a string', async () => {
		// A non-string `commitCertificate` falls through to the NearAnchor arm, which the body
		// does not satisfy — so it is refused rather than surfacing a certificate of the wrong type
		// to `routeAct`'s callers.
		for (const bad of [1, null, true, [], {}]) {
			const out = await sendMaybeAct(
				nodeReplying(replyStream({ v: 1, commitCertificate: bad })),
				selfId, MAYBE_ACT_MSG, P.PROTOCOL_MAYBE_ACT, { timeoutMs: 500 }
			)
			expect(out.kind, `commitCertificate: ${JSON.stringify(bad)}`).to.equal('decode-error')
			expect(out).to.not.have.property('value')
		}
	})
})
