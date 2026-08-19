import { peerIdFromString } from '@libp2p/peer-id';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import { base64urlToCoord } from '../ring/hash.js';
import { createLogger } from '../logger.js';
import type { NearAnchorV1, NeighborSnapshotV1, RouteAndMaybeActV1 } from '../index.js';
// Type-only, so the `leave.ts` ⇄ `validate.ts` pair is a compile-time cycle and not a runtime one:
// `leave.ts` imports `sanitizeReplacements` as a value, this imports its message type as a type.
import type { LeaveNoticeV1 } from './leave.js';

const log = createLogger('rpc:validate');

/**
 * Every wire-shape rule FRET applies to an inbound message, in one module.
 *
 * A validator here is a **parser**, not a type guard: `undefined` means "reject this message",
 * and anything else is the message *as normalized*. Two of the shapes must normalize as they
 * check — truncate an over-long id list, drop a malformed sample entry, drop an advisory field of
 * the wrong type — and a `msg is T` guard cannot express that without mutating its argument.
 * Returning the normalized value makes narrowing and normalization one step, so no caller can
 * consume an un-normalized message. The whole module keeps that one signature rather than mixing
 * the two forms, which is the drift this module exists to end.
 *
 * All parsers are pure and O(message size): no hashing, no ring walks, no libp2p dialing.
 * `isPeerIdString` calls `peerIdFromString`, which is parse-only.
 *
 * **No parser throws.** A fuzzed field of any type yields `undefined` or a normalized value.
 *
 * `v` is deliberately unchecked on every message. Nothing negotiates versions today, and a hard
 * reject on an unexpected `v` would make a future v2 rollout fail closed at exactly the peers
 * that have not upgraded yet. Stated, not overlooked.
 */
export type Parser<T> = (msg: unknown) => T | undefined;

// ---------------------------------------------------------------------------------------------
// Shared primitives. Module-scoped on purpose: they are how the rules below are spelled, not
// surface a consumer should depend on.
// ---------------------------------------------------------------------------------------------

/** A non-null, non-array object — the only top-level shape any FRET message admits. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Finite `number` — never a coercion, so `null` / `'5'` / `undefined` are all rejected. */
function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** The value when it is a finite number, else `fallback` — the "drop this advisory field" rule. */
function finiteNumberOr(value: unknown, fallback: number | undefined): number | undefined {
	return isFiniteNumber(value) ? value : fallback;
}

/** A string that parses as a peer id. Parse-only — no network, no store. */
function isPeerIdString(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	try { peerIdFromString(value); return true; } catch { return false; }
}

/**
 * An id list normalized to at most `cap` strings: absent (or any non-array) is `[]`, and the
 * **truncation happens before the per-entry check** so a crafted list of 100k non-strings costs
 * `cap` comparisons rather than 100k.
 */
function boundedStringArray(value: unknown, cap: number): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value.slice(0, cap)) {
		if (typeof entry === 'string') out.push(entry);
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// RouteAndMaybeAct
// ---------------------------------------------------------------------------------------------

/** Encoded `key` cap — generous against real content keys (≤ 64 raw bytes today). */
const MAX_KEY_CHARS = 1024;
/** Minted ids are `selfId|timestamp|uuid` ≈ 100 chars; the cap bounds the dedup-cache key. */
const MAX_CORRELATION_ID_CHARS = 256;
/** Breadcrumbs grow one per hop and TTL bounds hops; 64 is far past any real route. */
const MAX_BREADCRUMBS = 64;
/** `digest` is a lightweight summary, not a payload — `activity` is where bulk belongs. */
const MAX_DIGEST_CHARS = 4096;

/**
 * Structural validity of an inbound `RouteAndMaybeAct` — everything downstream code touches
 * without checking, and nothing more. The caller runs it immediately after taking the rate-limit
 * token (so malformed floods are metered) and before every other guard (which read fields this
 * vouches for — `breadcrumbs?.includes` on a number was a throw the old handler never survived).
 *
 * `key` is checked by actually decoding it, so a caller that passes may decode it once and hand
 * the bytes down — the double-throw where `routeAct` and its `nearAnchorOnly` fallback both
 * choked on the same undecodable key is what made the fallback useless.
 *
 * Normalizes nothing: on success the argument is returned unchanged.
 */
export const parseRouteAndMaybeAct: Parser<RouteAndMaybeActV1> = (msg) => {
	if (!isPlainObject(msg)) return undefined;
	if (typeof msg.key !== 'string' || msg.key.length > MAX_KEY_CHARS) return undefined;
	try { u8FromString(msg.key, 'base64url'); } catch { return undefined; }
	if (!isFiniteNumber(msg.ttl)) return undefined;
	if (!isFiniteNumber(msg.want_k)) return undefined;
	if (!isFiniteNumber(msg.min_sigs)) return undefined;
	if (!isFiniteNumber(msg.timestamp)) return undefined;
	if (msg.wants !== undefined && !isFiniteNumber(msg.wants)) return undefined;
	if (msg.breadcrumbs !== undefined) {
		if (!Array.isArray(msg.breadcrumbs) || msg.breadcrumbs.length > MAX_BREADCRUMBS) return undefined;
		if (!msg.breadcrumbs.every((b) => typeof b === 'string')) return undefined;
	}
	if (typeof msg.correlation_id !== 'string' || msg.correlation_id.length > MAX_CORRELATION_ID_CHARS) return undefined;
	if (msg.activity !== undefined && typeof msg.activity !== 'string') return undefined;
	if (msg.digest !== undefined && (typeof msg.digest !== 'string' || msg.digest.length > MAX_DIGEST_CHARS)) return undefined;
	return msg as unknown as RouteAndMaybeActV1;
};

// ---------------------------------------------------------------------------------------------
// LeaveNotice
// ---------------------------------------------------------------------------------------------

const MAX_REPLACEMENTS = 12;

/**
 * The suggested-replacement list of a leave notice, bounded and parse-checked.
 *
 * Returns `undefined` — not `[]` — for an empty result, so the field is *absent* rather than
 * present-and-empty on the notice the receiver goes on to act on.
 */
export function sanitizeReplacements(ids: unknown): string[] | undefined {
	// Wire JSON is untrusted: a non-array here (a number, a string) used to reach `.slice` and
	// throw out of the handler, which leaked the inbound stream before the registration seam
	// caught it. Treat any non-array as absent.
	if (!Array.isArray(ids) || ids.length === 0) return undefined;
	const valid: string[] = [];
	for (const id of ids.slice(0, MAX_REPLACEMENTS)) {
		if (isPeerIdString(id)) valid.push(id);
	}
	return valid.length > 0 ? valid : undefined;
}

/**
 * A leave notice. `from` must be a parseable peer id and `timestamp` finite — either wrong and
 * the message is rejected, since both are load-bearing (the receiver removes the peer `from`
 * names, and the freshness check reads `timestamp`). `replacements` are hints, so they are
 * sanitized rather than rejected on.
 */
export const parseLeaveNotice: Parser<LeaveNoticeV1> = (msg) => {
	if (!isPlainObject(msg)) return undefined;
	if (!isPeerIdString(msg.from)) return undefined;
	if (!isFiniteNumber(msg.timestamp)) return undefined;
	const out = { ...msg } as unknown as LeaveNoticeV1;
	const replacements = sanitizeReplacements(msg.replacements);
	if (replacements === undefined) delete out.replacements;
	else out.replacements = replacements;
	return out;
};

// ---------------------------------------------------------------------------------------------
// NeighborSnapshot
// ---------------------------------------------------------------------------------------------

/** Per-list truncation bounds for {@link makeSnapshotParser} — the receiver's merge caps. */
export interface SnapshotCaps {
	successors: number;
	predecessors: number;
	sample: number;
}

/**
 * A snapshot parser bound to the receiver's own merge caps, so the parser's truncation and the
 * merge loop's `slice` cannot drift apart — they are the same numbers, supplied once.
 *
 * Over-long id lists are **truncated, not rejected**: the merge loops already sliced to exactly
 * these caps, so truncating here changes no behavior — it only moves the cost ahead of the
 * parse-and-hash loop instead of after it. Rejecting the whole message would be new behavior that
 * punishes an honest peer running a larger profile.
 *
 * `sample` keeps today's **skip-and-log per entry** rule: one unusable entry drops that entry, not
 * the message. (`importTable`'s all-or-nothing rule is the other case, and is deliberately not
 * touched — a corrupt persisted table is better refused whole.)
 */
export function makeSnapshotParser(caps: SnapshotCaps): Parser<NeighborSnapshotV1> {
	return (msg) => {
		if (!isPlainObject(msg)) return undefined;
		// `from` is the identity the receiver checks against the transport-authenticated sender
		// and then keys its merge on, so a non-peer-id here is not salvageable.
		if (!isPeerIdString(msg.from)) return undefined;
		if (!isFiniteNumber(msg.timestamp)) return undefined;

		const out = { ...msg } as unknown as NeighborSnapshotV1;
		out.successors = boundedStringArray(msg.successors, caps.successors);
		out.predecessors = boundedStringArray(msg.predecessors, caps.predecessors);
		out.sample = parseSample(msg.sample, caps.sample, msg.from);

		// Advisory numerics: dropped individually rather than rejected. Both are already gated
		// downstream ("both positive" before they reach the size estimator), so a missing one
		// costs the receiver a calibration sample and nothing else.
		const sizeEstimate = finiteNumberOr(msg.size_estimate, undefined);
		if (sizeEstimate === undefined) delete out.size_estimate; else out.size_estimate = sizeEstimate;
		const confidence = finiteNumberOr(msg.confidence, undefined);
		if (confidence === undefined) delete out.confidence; else out.confidence = confidence;

		// Matches the receiver's own `isPlainObject` gate before it writes the sender's metadata.
		if (!isPlainObject(msg.metadata)) delete out.metadata; else out.metadata = msg.metadata;

		// `sig` is deliberately unchecked: message signing is unimplemented, so nothing reads it.
		return out;
	};
}

type SampleEntry = NonNullable<NeighborSnapshotV1['sample']>[number];

/**
 * The sparsity sample, truncated then vetted per entry. A `coord` is checked by *decoding* it
 * through {@link base64urlToCoord}, which already rejects anything that is not exactly 32 bytes —
 * so a wrong-width coordinate is dropped here rather than reaching the store's write seam, where
 * it throws (and a throw inside the merge loop is exactly the leak this module exists to stop).
 */
function parseSample(value: unknown, cap: number, from: string): SampleEntry[] {
	if (!Array.isArray(value)) return [];
	const out: SampleEntry[] = [];
	for (const entry of value.slice(0, cap)) {
		if (!isPlainObject(entry)) continue;
		if (typeof entry.id !== 'string' || typeof entry.coord !== 'string') continue;
		if (!isFiniteNumber(entry.relevance)) continue;
		try {
			base64urlToCoord(entry.coord);
		} catch (err) {
			// NOTE: one line per dropped entry, so a hostile peer sending a full sample of bad
			// coords costs `cap` lines per message. Harmless today — @libp2p/logger emits only
			// under DEBUG, and the neighbors token bucket meters the messages. If snapshot
			// logging is ever routed to an always-on sink, collapse this to one line per message.
			log.error('snapshot from %s: dropping sample entry %s with unusable coord - %e', from, entry.id, err);
			continue;
		}
		out.push({ id: entry.id, coord: entry.coord, relevance: entry.relevance });
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------------------------

/**
 * The error a wired-in reply parser throws on rejection. Named (a stable `name`, matched by
 * {@link isReplyRejectedError}) rather than a bare `Error` so a classifier — and a test — can
 * recognise it by identity instead of by message text, the house rule the
 * `isFrameTruncationError` / `isPayloadTooLargeError` pair already follows.
 */
export class ReplyRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ReplyRejectedError';
	}
}

/** True for the error {@link parseOrThrow} raises. Identity, not message text. */
export function isReplyRejectedError(err: unknown): boolean {
	return (err as { name?: unknown } | null)?.name === 'ReplyRejectedError';
}

/**
 * Adapt a {@link Parser} into the `decode` callback `rpcRequest` wants.
 *
 * `rpcRequest`'s decode phase has **no `undefined` check**: a throw becomes `decode-error`, but a
 * *returned* `undefined` becomes `{ kind: 'ok', value: undefined }` — the "an `ok` carrying
 * `undefined` dressed as the reply" failure the helper's two overloads exist to prevent, and it
 * type-checks silently (`T` infers as `Reply | undefined`). So a parser is never passed in raw;
 * it goes through here, which turns a rejection into a throw.
 *
 * Chosen over teaching `rpcRequest` to treat a returned `undefined` as `decode-error`: that is
 * simpler at these three call sites but makes `undefined` unreturnable as a legitimate reply for
 * every consumer of a publicly exported helper. `rpcRequest` stays untouched.
 */
export function parseOrThrow<T>(parse: Parser<T>, msg: unknown): T {
	const parsed = parse(msg);
	if (parsed === undefined) throw new ReplyRejectedError('reply rejected by wire-shape parser');
	return parsed;
}

/**
 * A ping reply, projected to what `sendPing` actually returns.
 *
 * `ok` must be a **boolean**: a legal value always encodes as one, so the `Boolean(r.ok)` coercion
 * this replaces could only ever have hidden a malformed peer. `ts` is carried by the wire type and
 * read by nobody, so it is neither checked nor returned — but it must not make a reply *reject*.
 */
export const parsePingResponse: Parser<{ ok: boolean; size_estimate?: number; confidence?: number }> = (msg) => {
	if (!isPlainObject(msg)) return undefined;
	if (typeof msg.ok !== 'boolean') return undefined;
	const out: { ok: boolean; size_estimate?: number; confidence?: number } = { ok: msg.ok };
	const sizeEstimate = finiteNumberOr(msg.size_estimate, undefined);
	if (sizeEstimate !== undefined) out.size_estimate = sizeEstimate;
	const confidence = finiteNumberOr(msg.confidence, undefined);
	if (confidence !== undefined) out.confidence = confidence;
	return out;
};

/**
 * Anchors cap. Twice the largest list the producers can emit (`pickAnchors` yields ≤ 2), so the
 * cap can never refuse this node's own legal output.
 */
const MAX_ANCHORS = 8;
/** Cohort-hint cap. The producers emit ≤ 8, so 16 is 2× — same "cannot refuse our own" rule. */
const MAX_COHORT_HINT = 16;

/**
 * A NearAnchor reply. The two id lists are hints, so they truncate and drop bad entries; missing
 * arrays normalize to `[]`, which the caller already handles by falling back to its local cohort.
 * The two required numerics reject, matching how every other required scalar on this wire behaves
 * — a reply that cannot state a cluster size is malformed, not merely uninformative.
 */
export const parseNearAnchor: Parser<NearAnchorV1> = (msg) => {
	if (!isPlainObject(msg)) return undefined;
	if (!isFiniteNumber(msg.estimated_cluster_size)) return undefined;
	if (!isFiniteNumber(msg.confidence)) return undefined;
	const out = { ...msg } as unknown as NearAnchorV1;
	out.anchors = boundedStringArray(msg.anchors, MAX_ANCHORS);
	out.cohort_hint = boundedStringArray(msg.cohort_hint, MAX_COHORT_HINT);
	return out;
};

/**
 * A maybeAct reply: either a commit certificate or a NearAnchor. Discriminated on
 * `commitCertificate` being a string *first*, since that shape carries none of NearAnchor's
 * fields and would otherwise fail the numeric checks.
 */
export const parseMaybeActReply: Parser<NearAnchorV1 | { commitCertificate: string }> = (msg) => {
	if (!isPlainObject(msg)) return undefined;
	if (typeof msg.commitCertificate === 'string') return { commitCertificate: msg.commitCertificate };
	return parseNearAnchor(msg);
};
