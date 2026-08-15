----
description: RPC handlers now trust the cryptographically verified identity of whoever actually sent a message instead of the self-reported sender field, so a connected peer can no longer impersonate another to spoof leaves or poison the routing table.
files: packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/service/fret-service.ts, docs/fret.md, packages/fret/test/identity-verification.spec.ts, packages/fret/test/churn.leave.spec.ts
----

## What shipped

libp2p's transport authenticates the remote peer at the connection level — every
inbound stream handler receives `(stream, connection)` and `connection.remotePeer`
is the cryptographically verified id of whoever opened the stream. Previously every
FRET RPC handler took only `stream` and discarded the connection, so the self-reported
`from` on the wire was trusted at face value.

Now:
- **Every registered handler takes `(stream, connection)`** — even those with no `from`
  field, so future handlers copy the correct shape.
- **Any message carrying `from` is verified**: `from === connection.remotePeer.toString()`
  or it is dropped (log + count via a mismatch callback), *before* any state mutation.

Handler-by-handler:
- `registerLeave` (leave.ts) — decodes notice, verifies `from` before `onLeave`. New
  optional `onIdentityMismatch(claimed, actual)` param. **Highest severity**: a leave
  removes the peer it names, so pre-fix one unauthenticated inbound message let any
  connected peer evict any other.
- `registerNeighbors` (neighbors.ts) — request handler adopts the 2-arg shape (no inbound
  `from`); announce handler verifies the snapshot's `from` before `onAnnounce`. New optional
  `onIdentityMismatch` param (6th arg, after `maxBytes`).
- `registerMaybeAct` (maybe-act.ts) — no `from` field; the `handle` callback type widened to
  `(msg, from)`, threading the authenticated sender id through (unused for now, reserved for
  per-peer rate limiting / diagnostics).
- `registerPing` (ping.ts) — adopts 2-arg shape, connection unused (`_connection`).

Service wiring (fret-service.ts):
- Added `diag.rejected.identityMismatch` counter (exposed via `getDiagnostics()`).
- `registerNeighbors` / `registerLeave` registrations pass mismatch callbacks that increment
  the counter; maybe-act registration accepts the extra `_from` arg.

Docs: `docs/fret.md` — moved the `from`-verification bullet out of "Not yet implemented" into
"Current state" with a description of what landed.

## Verification / use cases

New spec `test/identity-verification.spec.ts` (real connected mem-transport nodes — sender
opens a transport-authenticated stream; the wire `from` is crafted independently, exactly how
impersonation looks). 6 tests, all passing:
- Spoofed leave (`from` = third-party id, actually sent by `sender`) → dropped, `onLeave` not
  called, mismatch fired with correct claimed/actual ids.
- Valid leave (`from` = real sender) → `onLeave` called, no mismatch.
- Spoofed announce → dropped; valid announce → processed. Same assertions.
- Maybe-act `handle` receives authenticated sender id as 2nd arg, equal to real sender.
- FretService integration: `rejected.identityMismatch` increments by 1 after a spoofed leave
  from a connected peer.

Also fixed `test/churn.leave.spec.ts` "oversized replacements array is truncated": it sent a
leave from `nodes[1]` while claiming `from: nodes[2]` — a spoof the new gate correctly drops.
That test targets replacement-array truncation, not identity, so `from` was aligned to the
real sender (`nodes[1]`). It now exercises sanitization as intended.

Commands run (all green):
- `npx tsc --noEmit` — exit 0
- `yarn build` — exit 0
- `yarn test` — 278 passing, 0 failing

## Known gaps / honest limitations (reviewer: treat tests as a floor)

- **Identity check is string equality on `.toString()`.** Sender writes `from` as
  `peerId.toString()`; receiver compares `connection.remotePeer.toString()`. Both canonical
  base58btc, so consistent — but there is no re-parse/normalization. If a peer-id encoding
  variant ever reaches the wire, equality could false-negative. Not exercised by a test.
- **Mismatch counter is a single global tally**, not per-peer. No test asserts the
  authenticated sender id is *used* for anything beyond being passed to maybe-act's `handle`
  (it is currently `_from`, unused). Per-peer rate limiting / diagnostics is explicitly future
  work.
- **No test covers the neighbors *request* or *ping* handlers' 2-arg signature** beyond the
  fact that the full suite still passes (they have no `from` to verify). The shape change is
  compile-checked, not behavior-tested.
- **Announce `onIdentityMismatch` is only wired when `onAnnounce` is provided** (the announce
  handler only registers if `onAnnounce` is set). FretService always provides both, so fine in
  practice; a caller passing only `onIdentityMismatch` without `onAnnounce` gets no announce
  handler at all.
- **This ticket is `from`-verification only.** It does NOT implement message signing, coord
  re-hashing of sample entries, leave signatures/liveness-ping, or dedup for leave notices —
  those remain in `docs/fret.md` "Not yet implemented" and their own tickets.

## Review findings (tripwire index)

- Mismatch logging (`log.error` in leave.ts / neighbors.ts) is debug-gated by `@libp2p/logger`
  (silent unless `DEBUG` matches), so a hostile peer spamming mismatches produces no output
  today. Parked as a `NOTE:` comment at the leave-handler log site: if that logging is ever
  routed to an always-on sink, rate-limit it. Genuinely conditional — not a queued task.
