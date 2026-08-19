import { afterEach, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import type { Libp2p } from 'libp2p'
import type { PeerId, Stream } from '@libp2p/interface'
import { fromString as u8FromString } from 'uint8arrays/from-string'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
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
import type { BusyResponseV1, NearAnchorV1, NeighborSnapshotV1 } from '../src/index.js'

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

const SNAPSHOT_OPTIONALS = ['sample', 'size_estimate', 'confidence', 'metadata'] as const
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
			await assertRoundTrips(arbNeighborSnapshot, ['sample', 'size_estimate', 'confidence', 'metadata'])
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
	// NOTE: the wire cap for maybeAct (Core 512 KB / Edge 256 KB, `maxBytesMaybeAct`) and the
	// service's own activity cap (a fixed 128 KB, checked in `handleMaybeAct` *after* the whole body
	// is buffered) disagree by 4× on Core. That gap is deliberately pinned here, not closed: it is
	// an open arm of `plan/15-rpc-shared-helper` ("tighten each RPC's max-bytes to the real
	// ceiling"). The tests below use the Edge profile so the wire cap is 256 KB and the payloads
	// stay small enough to send quickly; the arithmetic is the same on Core.
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
			expect(maxBytes, 'edge wire cap').to.equal(256 * 1024)

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
			expect(maxBytes, 'edge wire cap').to.equal(64 * 1024)

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
			const before = svc.getDiagnostics().rejected.rateLimited

			const res = await d.handleMaybeAct(maybeActMsg())

			expect(isBusy(res), 'busy reply').to.equal(true)
			expect((res as BusyResponseV1).retry_after_ms).to.be.greaterThan(0)
			expect(svc.getDiagnostics().rejected.rateLimited - before, 'counted exactly once').to.equal(1)
		})

		it('answers a neighbors request with busy + a positive retry_after_ms once its bucket is drained', async () => {
			const svc = service()
			const d = drivable(svc)
			drain(d.bucketNeighbors)
			const before = svc.getDiagnostics().rejected.rateLimited

			const res = await d.handleNeighborsRequest()

			expect(isBusy(res), 'busy reply').to.equal(true)
			expect((res as BusyResponseV1).retry_after_ms).to.be.greaterThan(0)
			expect(svc.getDiagnostics().rejected.rateLimited - before).to.equal(1)
		})

		it('answers ping with busy + a positive retry_after_ms once its bucket is drained', async () => {
			const svc = service()
			const d = drivable(svc)
			drain(d.bucketPing)
			const before = svc.getDiagnostics().rejected.rateLimited

			const res = d.handlePingRequest()

			expect(isBusy(res), 'busy reply').to.equal(true)
			expect((res as BusyResponseV1).retry_after_ms).to.be.greaterThan(0)
			expect(svc.getDiagnostics().rejected.rateLimited - before).to.equal(1)
		})

		it('silently ignores a rate-limited leave — visible only as a counter', async () => {
			const svc = service()
			const d = drivable(svc)
			const departing = 'peer-departing'
			svc.getStore().upsert(departing, await hashKey(enc.encode(departing)))
			drain(d.bucketLeave)
			const before = svc.getDiagnostics().rejected.rateLimited

			await d.handleLeave({ v: 1, from: departing, timestamp: Date.now() })

			// `handleLeave` returns void either way, so the *only* local evidence is that the peer
			// was not removed and the counter moved. See the wire-level asymmetry test below.
			expect(svc.getStore().getById(departing), 'the notice was not acted on').to.not.equal(undefined)
			expect(svc.getDiagnostics().rejected.rateLimited - before).to.equal(1)
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
			const before = svc.getDiagnostics().rejected.rateLimited

			d.handleAnnounce(announcer, snapshotFrom(announcer))

			await sleep(50) // the merge is detached; give one that should not run every chance to
			expect(svc.getStore().getById(announcer), 'never merged').to.equal(undefined)
			expect(svc.getDiagnostics().rejected.rateLimited - before).to.equal(1)
		})

		// `rejected.rateLimited` has one more contributor than the five buckets: the maybeAct
		// in-flight concurrency cap (Core 16 / Edge 4), which returns busy with a fixed
		// `retry_after_ms` of 500. It is not a bucket and is pinned by `profile.behavior.spec.ts`,
		// so it is out of scope here — but the counter is shared, which is why this test says
		// "bucket path" rather than "every path".
		it('increments rateLimited exactly once per rejection on every bucket path', async () => {
			const svc = service()
			const d = drivable(svc)
			drain(d.bucketMaybeAct)
			drain(d.bucketNeighbors)
			drain(d.bucketPing)
			drain(d.bucketLeave)
			drain(d.bucketAnnounceInbound)
			const before = svc.getDiagnostics().rejected.rateLimited

			await d.handleMaybeAct(maybeActMsg())
			await d.handleNeighborsRequest()
			d.handlePingRequest()
			await d.handleLeave({ v: 1, from: await newPeerIdString(), timestamp: Date.now() })
			const announcer = await newPeerIdString()
			d.handleAnnounce(announcer, snapshotFrom(announcer))

			expect(svc.getDiagnostics().rejected.rateLimited - before, 'five paths, five increments').to.equal(5)
		})

		it('keeps the buckets independent — draining maybeAct leaves the other four answering', async () => {
			const svc = service()
			const d = drivable(svc)
			const departing = 'peer-leaving'
			svc.getStore().upsert(departing, await hashKey(enc.encode(departing)))
			drain(d.bucketMaybeAct)
			const before = svc.getDiagnostics().rejected.rateLimited

			expect(isBusy(await d.handleMaybeAct(maybeActMsg())), 'maybeAct is drained').to.equal(true)
			expect(isBusy(await d.handleNeighborsRequest()), 'neighbors still answers').to.equal(false)
			expect(isBusy(d.handlePingRequest()), 'ping still answers').to.equal(false)

			await d.handleLeave({ v: 1, from: departing, timestamp: Date.now() })
			expect(svc.getStore().getById(departing), 'leave still acted on').to.equal(undefined)

			const announcer = await newPeerIdString()
			d.handleAnnounce(announcer, snapshotFrom(announcer))
			await waitUntil(() => svc.getStore().getById(announcer) != null, 2000, 'announce still merged')

			expect(svc.getDiagnostics().rejected.rateLimited - before, 'only the maybeAct rejection').to.equal(1)
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
			const before = { ...svc.getDiagnostics().rejected }

			const res = await d.handleMaybeAct(maybeActMsg({ breadcrumbs: 5 }))

			// The ordering `rpc-handler-fault-isolation` established: bucket, then validator, then
			// routing. A malformed flood is metered like any other, and a message that never got a
			// token was never inspected.
			expect(isBusy(res), 'busy, not the static malformed reject').to.equal(true)
			const after = svc.getDiagnostics().rejected
			expect(after.malformed - before.malformed, 'the validator never ran').to.equal(0)
			expect(after.rateLimited - before.rateLimited).to.equal(1)
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
			const before = svc.getDiagnostics().rejected.rateLimited

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
			expect(svc.getDiagnostics().rejected.rateLimited - before, 'visible only as a counter').to.equal(1)

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
})
