import { PeerRecord, RecordEnvelope } from '@libp2p/peer-record';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { CODE_P2P, CODE_P2P_CIRCUIT } from '@multiformats/multiaddr';
import type { Multiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from 'libp2p';
import type { PrivateKey } from '@libp2p/interface';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import { toString as u8ToString } from 'uint8arrays/to-string';
import { MAX_ADDRESS_RECORD_CHARS } from '../rpc/validate.js';
import { createLogger } from '../logger.js';

const log = createLogger('service:address-records');

/**
 * Signed address records — what FRET carries in a snapshot's `hints` so a peer known only
 * through gossip can still be dialed.
 *
 * The record is libp2p's own: a `RecordEnvelope` (signed, domain-separated) over a `PeerRecord`
 * (`peerId`, `multiaddrs`, `seqNumber`). Verification is `peerStore.consumePeerRecord`, which
 * checks the signature and the signer, refuses a sequence number not newer than the one it holds,
 * and replaces the peer's addresses with the record's — the same code path identify feeds. What
 * this module adds is the part libp2p leaves to the caller: a cheap structural peek so the common
 * path (a neighbour re-sending records we already hold) never reaches the signature check, and a
 * sealer for *this* node's record, since libp2p keeps no self record in the peerStore (identify
 * seals one per request and discards it).
 */

/** How many of this node's own addresses a self record carries — bounds the record's size. */
export const MAX_SELF_RECORD_ADDRS = 8;

/**
 * How long a record for a peer we are **not** connected to keeps being forwarded after we last
 * accepted it. Measured on our own clock (`PeerEntry.addressRecord.confirmedAt`) — never on a
 * timestamp a remote supplied — so clock skew between peers cannot extend it. A stale record
 * cannot be refreshed by re-hearing it either (an equal sequence number is refused), so a record
 * keeps circulating only while some node is connected to its subject or the subject re-seals.
 */
export const ADDRESS_HINT_FORWARD_MAX_AGE_MS = 60 * 60 * 1000;

/** The base64url string a record travels as on the wire. */
export function encodeAddressRecord(envelope: Uint8Array): string {
	return u8ToString(envelope, 'base64url');
}

/** Inverse of {@link encodeAddressRecord}. Throws on a string that is not base64url. */
export function decodeAddressRecord(record: string): Uint8Array {
	return u8FromString(record, 'base64url');
}

/** What {@link peekPeerRecord} reads off an envelope without verifying it. */
export interface PeekedPeerRecord {
	/** Peer id derived from the envelope's public key — who signed it. */
	signer: string;
	/** Peer id the payload names — whose addresses it claims to be. */
	peerId: string;
	seq: bigint;
}

/**
 * Decode an envelope and its peer record **structurally** — no signature check, no domain check,
 * never throws. `undefined` means the bytes do not parse as an envelope over a peer record.
 *
 * Two uses. The identity pre-check: a receiver must refuse a record whose `signer` or `peerId`
 * is not the id it was labelled with *before* it reaches `consumePeerRecord`, because that call
 * checks only the signer against `expectedPeer` and then patches the *payload's* peer id blindly —
 * so a peer could sign a record that rewrites another peer's addresses. And the sequence pre-check:
 * comparing `seq` against the record already held is what keeps a re-sent record free of crypto.
 */
export function peekPeerRecord(bytes: Uint8Array): PeekedPeerRecord | undefined {
	try {
		const envelope = RecordEnvelope.createFromProtobuf(bytes);
		const record = PeerRecord.createFromProtobuf(envelope.payload);
		return {
			signer: peerIdFromPublicKey(envelope.publicKey).toString(),
			peerId: record.peerId.toString(),
			seq: record.seqNumber,
		};
	} catch (err) {
		// The caller counts and reports the rejection with the id it was labelled with; this
		// line only carries the decoder's reason.
		log.trace('unparseable address record - %e', err);
		return undefined;
	}
}

/**
 * This node's addresses as its self record should state them.
 *
 * Projected the way identify does — `decapsulateCode(CODE_P2P)` strips the trailing `/p2p/<self>`
 * the address manager appends, since a `PeerRecord` names its peer once, in `peerId` — deduped,
 * and then two rules of our own:
 *
 * - A circuit address with **no relay hop** (the bare `/p2p-circuit` listen placeholder, reported
 *   from start-up until a reservation lands) is dropped: nobody can dial it.
 * - **Reserved** circuit addresses (`…/p2p/<relay>/p2p-circuit`) come first. For a NAT-only peer
 *   they are the only addresses a third party can use, so they must survive the cap.
 *
 * Nothing else is filtered — no public/private test. The address manager already applied the
 * host's announce / noAnnounce configuration, and a private address is harmless in a record
 * (a dial to it fails fast) where a missing circuit address is the whole bug this exists to fix.
 * Capped at {@link MAX_SELF_RECORD_ADDRS}.
 */
export function selfRecordAddrs(node: Libp2p): Multiaddr[] {
	const reserved: Multiaddr[] = [];
	const direct: Multiaddr[] = [];
	const seen = new Set<string>();
	for (const listed of node.getMultiaddrs()) {
		const ma = listed.decapsulateCode(CODE_P2P);
		const key = ma.toString();
		if (seen.has(key)) continue;
		seen.add(key);
		const kind = circuitKind(ma);
		if (kind === 'placeholder') continue;
		(kind === 'reserved' ? reserved : direct).push(ma);
	}
	return [...reserved, ...direct].slice(0, MAX_SELF_RECORD_ADDRS);
}

/** Is this a plain address, a circuit address through a named relay, or the relay-less placeholder? */
function circuitKind(ma: Multiaddr): 'direct' | 'reserved' | 'placeholder' {
	const components = ma.getComponents();
	const circuitAt = components.findIndex((c) => c.code === CODE_P2P_CIRCUIT);
	if (circuitAt < 0) return 'direct';
	return components.slice(0, circuitAt).some((c) => c.code === CODE_P2P) ? 'reserved' : 'placeholder';
}

/**
 * This node's own signed address record, sealed lazily and cached until its address list changes.
 *
 * Lazy rather than event-driven on purpose: a snapshot build asks {@link current}, which compares
 * the projected address list against the one last sealed and re-seals only on a difference. That
 * catches a reservation landing after `start()` (the next snapshot carries a fresher record with a
 * higher sequence number, which receivers accept over the earlier one) without a listener that
 * `stop()` would have to detach.
 */
export class SelfAddressRecord {
	/** The address list the cached record describes, as one string. `''` = nothing sealed yet
	 *  — which is also the key of an empty address list, and both mean "no record". */
	private sealedFor = '';
	private cached: string | undefined;
	private lastSeq = 0n;
	/** A seal in progress, so two concurrent snapshot builds share one signature. */
	private inflight: { key: string; promise: Promise<string | undefined> } | null = null;

	/**
	 * The base64url record for `node`'s current addresses, or `undefined` when there is nothing
	 * to advertise: no dialable address yet (a relay-only node before its reservation lands), or a
	 * record that would not fit {@link MAX_ADDRESS_RECORD_CHARS}.
	 */
	async current(node: Libp2p, privateKey: PrivateKey): Promise<string | undefined> {
		const addrs = selfRecordAddrs(node);
		const key = addrs.map((a) => a.toString()).join('\n');
		if (key === this.sealedFor) return this.cached;
		if (this.inflight?.key === key) return this.inflight.promise;
		const promise = this.seal(node, privateKey, addrs, key);
		this.inflight = { key, promise };
		try {
			return await promise;
		} finally {
			if (this.inflight?.promise === promise) this.inflight = null;
		}
	}

	private async seal(node: Libp2p, privateKey: PrivateKey, addrs: Multiaddr[], key: string): Promise<string | undefined> {
		if (addrs.length === 0) {
			// Nothing dialable to state — no record, rather than a signed empty list that would
			// only make receivers discard the addresses they hold for us.
			this.sealedFor = key;
			this.cached = undefined;
			return undefined;
		}
		// libp2p's convention is `BigInt(Date.now())`; the `lastSeq + 1n` floor keeps two seals in
		// one millisecond ordered. Taken before the await so a seal for a *changed* list that starts
		// while this one is in flight still gets the higher number.
		// NOTE: the floor is per process. A node whose clock went backwards across a restart seals
		// a lower sequence number than the records other peers hold for it, and its new addresses
		// are refused until its clock passes the old number — the same limitation libp2p identify
		// has, and not worth a persisted counter until a deployment actually meets it.
		const seq = bigintMax(BigInt(Date.now()), this.lastSeq + 1n);
		this.lastSeq = seq;
		const record = new PeerRecord({ peerId: node.peerId, multiaddrs: addrs, seqNumber: seq });
		const envelope = await RecordEnvelope.seal(record, privateKey);
		const encoded = encodeAddressRecord(envelope.marshal());
		this.sealedFor = key;
		if (encoded.length > MAX_ADDRESS_RECORD_CHARS) {
			log.error('self address record (%d chars over %d addresses) exceeds %d chars - omitting it from snapshots', encoded.length, addrs.length, MAX_ADDRESS_RECORD_CHARS);
			this.cached = undefined;
		} else {
			this.cached = encoded;
		}
		return this.cached;
	}
}

function bigintMax(a: bigint, b: bigint): bigint {
	return a > b ? a : b;
}
