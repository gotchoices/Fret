----
description: A peer that genuinely belongs to this network could be wrongly labelled an outsider by one failed connection handshake or one out-of-date notification, and was then shut out of routing until a slow retry rescued it. Weak or stale evidence can no longer override strong, recent evidence.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/membership-identify.spec.ts, packages/fret/test/relevance.properties.spec.ts, docs/fret.md
----

Membership labelling now follows an evidence-strength ordering: a weaker or staler signal never
overrides a stronger, more recent one. In one line — **`member` is only ever set by positive proof,
and only ever cleared by repeated, time-separated direct proof of absence.**

## What shipped

**One guard owns the ordering.** `FretService.applyMembershipSignal(id, signal)` is the single site
that writes `membership`. `markMember` / `markForeign` are gone; `applySuccess`,
`classifyByProtocols`, and all three `isUnsupportedProtocolError` call sites route through it.

| Signal | Strength | May set |
|---|---|---|
| `rpc-success` (completed outbound namespaced RPC) | strong | `member` |
| `rpc-inbound` (authenticated inbound namespaced RPC) | strong | `member` |
| `identify-member` (protocol list contains one of ours) | strong | `member` |
| `identify-foreign` (list non-empty, none of ours) | weak | `foreign`, **only from `unknown`** |
| `negotiate-failure` (could not negotiate) | weak | `foreign` **only at 3 time-separated failures** |

Promotions always apply and reset the consecutive-failure run to 0.

**Store.** `PeerEntry.negotiateFailures` (consecutive failed negotiations, clamped at the threshold)
and `PeerEntry.lastNegotiateFailureAt` (the spacing timestamp). Both default to 0 on insert, are
preserved by `upsert` like the other counters, and are reset to 0 by `importEntries` for the same
reason `state` is forced to `'disconnected'`. `negotiateFailures` is exported in
`SerializedPeerEntry` for diagnostics; the timestamp is not serialized. The store still never
branches on either.

**Inbound promotion.** `registerPing` and `registerNeighbors` gained an `onInbound?: (from: string)`
parameter fed from `connection.remotePeer`; `registerMaybeAct` already threaded `from`;
`mergeAnnounceSnapshot` uses its already-verified `from`. All four call `noteInboundRpc`, which
upserts if needed and applies `rpc-inbound`. `handleLeave` deliberately does not promote — promoting
a peer announcing its own departure is pointless.

**Recovery ordering.** `reprobeForeignPeers` sorts candidates within each reachability group by
ascending backoff factor, so a freshly-demoted peer is probed before a long-confirmed foreign one.

**Docs.** The *Ring membership* section of `docs/fret.md` carries the strength table, the
"only set by positive proof, only cleared by repeated proof of absence" rule, the failure-spacing
rationale, the re-probe ordering + saturation arithmetic, and the new `SerializedPeerEntry` field.

## Review findings

Implement-stage diff (`9d61816`) read first, before the handoff summary. Checked: the guard and all
five signal arms; every call site that writes membership; the store field's full lifecycle (default,
upsert-preserve, export, import-reset); inbound promotion wiring across all five RPC handlers; the
backoff-map lifecycle against the new re-probe sort; capacity/eviction interaction with the new
remote-driven insert path; docs accuracy against every touched file. `npx tsc --noEmit` clean;
`yarn test` from `packages/fret`: **311 passing, 0 failing** (~4 min). No pre-existing failures
surfaced, so `tickets/.pre-existing-error.md` was not written.

### Fixed in this pass

- **A burst of simultaneous failures could still demote a confirmed member.** The counter counted
  *events*, not time-separated observations. Several concurrent inbound `maybeAct` requests
  forwarding to the same restarting hop all fail against the same blip in the same instant; three of
  them reached the threshold immediately and demoted the peer — the exact failure the threshold
  exists to prevent. Root cause and fix are both at the guard's `negotiate-failure` arm: a failure
  landing within 500 ms of the last counted one is now ignored rather than counted
  (`NEGOTIATE_FAILURE_MIN_SPACING_MS`, backed by `PeerEntry.lastNegotiateFailureAt`). The spacing
  sits well under the 1 s first backoff window, so genuine sequential failures are never swallowed
  and the ~7 s time-to-label for a genuinely foreign peer is unchanged. Covered by a new test that
  drives the guard directly: five failures in a burst count as one and do not demote, then two
  spaced failures still complete the run and still demote. Found by reading the call sites, not by
  observing it — `handleMaybeAct` runs once per inbound request with no serialization.
- **`probeMembership`'s docstring still said "unsupported-protocol → foreign"** — the behaviour it
  documented was replaced by the threshold. Rewritten.
- **Redundant double-condition in the guard's positive arm** — the same `membership !== 'member'`
  test was evaluated twice to build a partial patch. Collapsed to one early-return plus one write.
- **`docs/fret.md` bullet list was broken mid-list** — the `negotiateFailures` storage paragraph was
  inserted between the identify bullet and the two probe-pass bullets, orphaning them from the list.
  Moved below the list, and the spacing rule documented alongside it.
- **Test `waitFor` default timeout lowered 20 s → 12 s.** Three tests chain three waits inside a
  40 s per-test budget; on failure the waits would consume the budget and report an opaque mocha
  timeout instead of the precise assertion that follows each one.

### Checked and found sound (no change)

- **The re-probe ordering is not dead code.** It looked like it might be: `reprobeForeignPeers`
  filters to peers whose backoff has expired, then sorts by backoff factor. `pruneBackoffMap` only
  deletes entries for peers evicted from the store, and `getBackoffPenalty` returns 0 for an expired
  entry while deliberately *retaining* it, so the factor survives expiry and the sort discriminates
  as intended (freshly demoted 0–4, long-confirmed 32).
- **`noteInboundRpc` inserts without calling `enforceCapacity`** — matches the existing convention
  for event-driven inserts (`peer:connect`, `peer:identify`, `peer:update` all do the same);
  enforcement runs on every merge and every stabilization tick, so the overshoot is bounded by one
  tick's inbound connections. Not a regression introduced here.
- **No path double-counts one failure.** The three `negotiate-failure` sites are disjoint
  (neighbor-latency probe, membership probe, maybeAct forward) and each fires at most once per
  failed operation.
- **`maybeAct`'s `from` is transport-authenticated** (`connection.remotePeer`), and promotion
  happens only after the message decodes, so a malformed inbound message cannot promote.

### Tripwire recorded (not a ticket)

- **`noteInboundRpc` is the one admission path driven by the remote rather than by proof we gathered
  ourselves.** Anyone who knows the network name can dial our ping protocol and self-admit as
  `member` — only as themselves, since the id is transport-authenticated. Harmless under the current
  trust model, where speaking the namespaced protocol *is* membership, and self-limiting (such a
  peer answers nothing, so outbound probes demote it again). Parked as a `NOTE:` at the site,
  pointing at the admission-control work already listed in the security section of `docs/fret.md`.

### Appended to existing tickets (site already claimed)

- **`tickets/plan/5-waitfor-helper`** — `ring-membership.spec.ts` now carries a third private copy of
  the predicate-wait helper. The fixed sleeps that spec used to have are already gone, so the
  remaining work there is purely de-duplication; noted also that neither copy throws on timeout.
- **`tickets/plan/23-fret-service-decomposition`** — re-measured
  `wc -l packages/fret/src/service/fret-service.ts` → **1878** lines (ticket was written against
  ~1600). Added membership classification as a third extraction candidate: the guard, the inbound
  promotion, the identify classifier and the two probe passes form a self-contained policy with a
  narrow store dependency, currently reachable in tests only via real libp2p nodes or private casts.

### New tickets filed

None. The one behavioural defect found resolved at the same single site the ticket had just created,
so fixing it here was cheaper and safer than shipping a guarantee the guard did not actually provide.

### Known gaps left standing (deliberate)

- **The re-probe ordering has no test.** It is a sort inside a bounded pass with no observable public
  surface; testing it means reaching into the private backoff map. Verified instead by reading the
  backoff lifecycle end to end (above).
- **The maybeAct forward-path `negotiate-failure` and the maybeAct inbound promotion have no direct
  test.** Both are one-line routes into the guard, and the guard itself is now driven directly by
  the new burst test in addition to the end-to-end coverage.
- **"Never excluded from the ring during the transient window" is sampled, not continuous.** The
  test asserts `getNeighbors` includes the peer at the instant the first failure is observed, not at
  every instant. A continuous sampler would be stronger but timing-fragile.
- **`NEGOTIATE_FAILURE_THRESHOLD = 3` and the 500 ms spacing are private constants, not config.**
  If a deployment ever wants them tunable that is a follow-up, not a defect.
- **`yarn format:check` fails on all 21 source files.** Pre-existing and repo-wide — the codebase
  indents with tabs and no prettier config reconciles that — not introduced by this ticket. There is
  no lint script in either package; typecheck plus the test suite is the available gate.
