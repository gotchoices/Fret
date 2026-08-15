description: RPC handlers now trust the cryptographically verified identity of whoever actually sent a message instead of the self-reported sender field, so a connected peer can no longer impersonate another to spoof leaves or poison the routing table.
files: packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/service/fret-service.ts, docs/fret.md, packages/fret/test/identity-verification.spec.ts, packages/fret/test/churn.leave.spec.ts
----

## What shipped

Every FRET RPC stream handler now receives `(stream, connection)`. `connection.remotePeer`
is the transport-authenticated id of whoever opened the stream. Any message carrying a
self-reported `from` (leave notice, announce snapshot) is dropped — before any state
mutation — unless `from === connection.remotePeer.toString()`, and mismatches are counted
via `diag.rejected.identityMismatch`. Handlers with no `from` (neighbors request, maybeAct,
ping) still adopt the two-argument shape so the authenticated sender is available; maybeAct
threads it to `handle(msg, from)` (reserved for future per-peer rate limiting).

See the implement commit `e24fad0` for the full handler-by-handler breakdown.

## Review findings

Adversarial pass over implement commit `e24fad0`. Read the diff first, then the handoff.

**Scope coverage — all `from`-bearing ingress verified.** Grepped every `node.handle`
registration: the 5 handlers are leave, announce, neighbors-request, maybeAct, ping — all
adopt `(stream, connection)`. Only leave + announce carry an inbound `from`; both now gate
on `connection.remotePeer`. Confirmed complete.

**Fetched-neighbor path (potential blind spot) — SAFE.** The ticket only discusses inbound
handlers, but `mergeNeighborSnapshots` (fret-service.ts:1028) also ingests a snapshot with a
`from` field via `fetchNeighbors`. Checked: the fetched snapshot's `from` is never trusted —
`calibrateSizeFromSnapshot(snap, id)` uses the dialed (transport-authenticated) `id`, not
`snap.from`, and succ/pred/sample lists are upserted as untrusted `unknown` hints per existing
design. No impersonation surface. No change needed.

**Correctness / error paths — clean.** Mismatch path closes the stream and returns without a
response; senders (`sendLeave` / `announceNeighbors`) fire-and-forget, so no hang. Diag counter
increments exactly once per spoof (test asserts delta == 1).

**Tests — verified as a floor, extended for greppability only.** Ran the new
`identity-verification.spec.ts` (6) + `churn.leave.spec.ts` (5) → 11 passing; full suite
`yarn test` → **278 passing, 0 failing**; `npx tsc --noEmit` → exit 0 (from `packages/fret/`).
The spoof tests use real connected mem-transport nodes, which is exactly the impersonation
shape. The honest-gaps list (request/ping 2-arg signature is compile-checked not
behavior-tested; per-peer counter unused; string-equality not normalization) is accurate and
all genuinely future/conditional — no new tickets warranted.

**Minor fixed inline — tripwire consistency.** The implementer parked one tripwire (mismatch
`log.error` is debug-gated by `@libp2p/logger`, so a hostile peer spamming mismatches produces
no output today; if that logging is ever routed to an always-on sink, rate-limit it) as a
`NOTE:` at the leave-handler log site (leave.ts:43). The **announce** handler (neighbors.ts)
has the identical exposure but had no NOTE, so the tripwire set was not greppable-complete.
Added the same `NOTE:` at neighbors.ts announce log site. Re-ran `tsc --noEmit` → exit 0
(comment-only).

**Stray artifact `docs/review.html` — deliberately left in place.** The implement commit added
a 475-line HTML code-review report (dated 2026-07-03) that looks unrelated to identity work.
Investigated: it is cited by line number (e.g. `review.html:454-456`) from 8 `tickets/plan/`
cleanup tickets committed in the same commit, so it is a live reference for in-flight work, not
cruft. Not this ticket's to remove.

**Docs — verified accurate.** `docs/fret.md` correctly moved the `from`-verification bullet out
of "Not yet implemented" into "Current state" (diff `e24fad0~1..e24fad0`). Reflects reality.

### Findings by disposition
- **Major (new tickets):** none. Scope is `from`-verification only; message signing, coord
  re-hashing, leave signatures/liveness-ping, leave dedup, and per-peer rate limiting remain
  their own tickets under `docs/fret.md` "Not yet implemented".
- **Minor (fixed inline):** 1 — added missing `NOTE:` tripwire comment at neighbors.ts announce
  log site for greppable-complete tripwire set.
- **Tripwire (recorded, not ticketed):** debug-gated mismatch logging, now noted at **both**
  the leave and announce log sites (leave.ts, neighbors.ts). Conditional — only work if that
  logging is ever routed to an always-on sink.

## Commands run
- `npx tsc --noEmit` (from `packages/fret/`) — exit 0
- `node --import ./register.mjs mocha test/identity-verification.spec.ts test/churn.leave.spec.ts` — 11 passing
- `yarn test` — 278 passing, 0 failing
