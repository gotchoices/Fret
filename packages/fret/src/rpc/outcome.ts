/**
 * Why an outbound RPC ended — exactly one variant per FRET failure mode, so the service
 * branches on `kind` rather than sniffing an error's identity. Error sniffing is what let
 * identical evidence (a peer that opened a stream and merely replied badly) be booked as a
 * contact strike on one sender path and a soft failure on another.
 *
 * Each variant's doc comment states what the outcome *proves about the peer*, because that is
 * what the service branches on: contact strikes belong only to variants proving the peer
 * unreachable, never to variants proving it alive.
 */
export type RpcOutcome<T> =
	/**
	 * A whole framed reply arrived, decoded and (where a validator was supplied) validated.
	 * `rttMs` is measured from *after* the stream open, never including the dial (matching
	 * `sendPing` — a dial is not round-trip time).
	 *
	 * For a **write-only** RPC (no `decode` supplied) `value` is `undefined` and `ok` means
	 * only that *the body reached the transport* — explicitly NOT proof the peer received or
	 * accepted it. That gap is the whole reason a rate-limited leave is invisible today: the
	 * sender never reads a reply, so acceptance and a silent drop look identical.
	 */
	| { kind: 'ok'; value: T; rttMs: number }
	/**
	 * Nothing was attempted: the dial mode forbade dialing and no connection existed. Distinct
	 * from `ok` with an empty payload — that separation is what ends the `snapshotsFetched`
	 * overcount `NOTE:`d at `fetchAndMergeSnapshot`, where a fetch that never happened was
	 * counted like one that returned empty.
	 */
	| { kind: 'skipped' }
	/**
	 * The **caller's** signal aborted. Not evidence about the peer — no strike, no backoff, no
	 * relevance decay. The helper owns this call: it holds both signals (its deadline is a
	 * child of the caller's), so on any failure it checks the caller's signal first. Callers
	 * must NOT re-derive cancellation from a helper result — this variant wins.
	 */
	| { kind: 'cancelled' }
	/** Our own budget expired and the caller's signal did *not*. Contact strike. */
	| { kind: 'timeout' }
	/** Dial, stream-open, reset or transport failure. Contact strike. */
	| { kind: 'unreachable'; error: Error }
	/**
	 * `isUnsupportedProtocolError(err)` — the remote answered but does not serve this
	 * network's protocol. Membership evidence, never a contact strike: the peer is alive.
	 */
	| { kind: 'foreign-protocol'; error: Error }
	/**
	 * The peer opened a stream and answered, but the answer was truncated, empty, non-JSON, a
	 * non-object top level, over the byte cap, or rejected by the supplied validator. **Proof
	 * of life; never a contact strike.** Retires the `sendMaybeAct` misclassification, where a
	 * bad reply's plain `Error` propagated into the strike-booking path.
	 */
	| { kind: 'decode-error'; error: Error }
	/**
	 * The reply was a `BusyResponseV1`. `retryAfterMs` carries the message's `retry_after_ms`
	 * when present. Proof of life — the peer answered, it just refused the work.
	 */
	| { kind: 'busy'; retryAfterMs?: number }
	/**
	 * Our own per-connection stream cap refused to open the stream —
	 * `TooMany{In,Out}boundProtocolStreamsError`, raised locally before anything reached the wire.
	 * **Not evidence about the peer**: no contact strike, no relevance decay, no backoff — the same
	 * class as a tick-budget expiry. Distinct from `skipped`, which means the dial *mode* forbade
	 * dialing; this one means we were willing and our own ceiling refused, and that distinction is
	 * the diagnostic.
	 */
	| { kind: 'local-limit'; error: Error };
