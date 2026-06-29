----
description: Each node now tags every peer it knows about as belonging to its own network, a different network, or not-yet-determined. This adds the label and the logic that fills it in; nothing reads the label for routing yet — that is the follow-on gating change.
prereq:
files:
  - packages/fret/src/store/digitree-store.ts (MembershipState type, PeerEntry.membership, setMembership, upsert preserves it, serialize/import)
  - packages/fret/src/index.ts (exports MembershipState)
  - packages/fret/src/rpc/protocols.ts (isUnsupportedProtocolError helper)
  - packages/fret/src/service/fret-service.ts (member/foreign transitions, probe pass, identify listeners, self seed)
  - packages/fret/test/ring-membership.spec.ts (unit + in-memory reproduction)
  - docs/fret.md ("Ring membership" section; SerializedPeerEntry + persistence notes)
----

# Ring membership classification — same-network / foreign / unknown

## Summary

Each `DigitreeStore` entry now carries a tri-state `membership` label
(`unknown` | `member` | `foreign`) so a follow-on gating change can scope the ring to
same-network peers. The store only stores/exposes the label — no read path consumes it
for exclusion yet, so **behaviour is unchanged** by this ticket.

Labels are resolved by: self → `member`; successful namespaced RPC → `member`
(`applySuccess`); `UnsupportedProtocolError` → `foreign` (probe/maybeAct catch paths,
via the new `isUnsupportedProtocolError` helper); a bounded per-tick probe pass over
`unknown` peers (`classifyUnknownPeers`); and the libp2p identify path
(`peer:identify` / `peer:update` + `classifyFromPeerStore`). `upsert` preserves an
existing entry's membership across the network-agnostic per-tick re-seeds, and the
label round-trips through `exportTable` / `importTable` (missing field → `unknown`).

Implementation matched the handoff; the design is sound and the tri-state /
timeout-vs-unsupported distinction is the right core. Details in the implement commit
`2c9d527` and the `## Ring membership` section of `docs/fret.md`.

## Review findings

**Validation run (post-review):** `npx tsc --noEmit` → 0 errors; new spec
`test/ring-membership.spec.ts` → 11/11; full suite `yarn test` → **243 passing**, 0
failing. Re-run clean after the review's comment-only edit. No pre-existing failures
surfaced, so no `.pre-existing-error.md` was written.

**Checked:** store field + serialization round-trip; `upsert` membership preservation;
the member/foreign transition sites (`applySuccess`, `probeNeighborsLatency`,
`probeMembership`, `routeAct` forward catch); `isUnsupportedProtocolError` against
real-ish error shapes; the probe-pass budget/backoff/reachability logic; the identify
listeners and `classifyFromPeerStore`; self-seeding; docs accuracy against the code;
eviction (confirmed the store still never branches on `membership`); and type safety
(the `any` in event handlers and the `as unknown as` peerStore cast match existing
libp2p-event style in the file — not flagged).

### Minor — fixed in this pass
- None requiring code changes. Two tripwire NOTE comments added to
  `classifyUnknownPeers` (see below); no behavioural edits.

### Major — filed as new tickets
- **`backlog/bug-upsert-resets-peer-stats-each-tick`** — pre-existing defect the
  implementer flagged and I confirmed: `seedFromPeerStore` runs every stabilization
  tick and unconditionally `upsert`s every peerStore peer; `upsert` rebuilds the entry
  from defaults, so relevance / success / failure / latency counters (and `state`) are
  reset ~1×/tick. Only `membership` survives. This undermines relevance-based eviction
  and health-aware routing. Orthogonal to membership; out of scope here. (`state` reset
  is cosmetic — `isConnected` reads libp2p directly.)
- **`backlog/debt-membership-identify-integration-test`** — the identify path
  (`peer:identify` / `peer:update` listeners, `classifyFromPeerStore`, `foreign →
  member` re-admission) has **no test coverage**: the in-memory test nodes run no
  identify service. Implementer called this the highest-value addition; it needs a
  TCP+identify test harness, so it's its own ticket rather than an inline fix.

### Tripwires — recorded, not ticketed
- **Per-tick full-table scan.** `classifyUnknownPeers` calls `store.list()` and filters
  every tick, even once steady state has zero unknowns — O(table size) per tick. Fine
  at C=2048; matters only if capacity or tick rate grows a lot. Recorded as a `NOTE:`
  comment at the call site.
- **Foreign peers are never re-probed by the pass** (only `unknown` are). A same-network
  peer mislabeled `foreign` (e.g. identify completed before it registered our handlers)
  is re-admitted only via `peer:update` re-identify or a successful namespaced RPC. It
  self-heals today (`probeNeighborsLatency` still pings near peers regardless of label),
  but once the gating follow-on excludes `foreign` from the ring that RPC path closes —
  gating must add an occasional foreign re-probe or guarantee the `peer:update` path.
  Recorded as a `NOTE:` comment at `classifyUnknownPeers`; the gating ticket
  (`network-scoped-ring-admission`) is the place it bites.
- **Busy ping reply leaves a member `unknown`.** `sendPing` collapses a busy response to
  `{ok:false}`, so `probeMembership` treats it as ambiguous (backoff, stay unknown) even
  though a busy reply proves the peer served our protocol. Conservative and self-healing
  (re-probed when not busy); already documented inline and in the implement handoff. No
  change.

### Deferred design choices — confirmed acceptable
- **`fetchNeighbors` success not used as a member signal.** It swallows errors and
  returns an empty snapshot on both success-with-no-neighbors and failure, so it can't
  distinguish member from foreign without changing its contract; the same `near` set is
  already pinged via `probeNeighborsLatency` immediately before. Relying on ping +
  maybeAct + the probe pass is the right call. Acceptable.
- **Inbound-RPC promotion out of scope.** `from` is self-asserted and handlers don't
  receive the authenticated `connection.remotePeer`; correctly deferred to the planned
  message-auth work. Outbound probe + success paths are authoritative. Acceptable.

## Follow-on

`network-scoped-ring-admission` (planned) will read `membership` via a caller-supplied
predicate to scope ring/cohort/estimate to members, keeping the store and the simulator
unaffected. When it lands it should also address the foreign-re-probe tripwire above and
extend `test/ring-membership.spec.ts` with exclusion assertions.
