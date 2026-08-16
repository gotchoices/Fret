description: Peers that repeatedly fail to answer are now marked dead after three spread-out failed contact attempts, and are brought back to life the moment they prove they are reachable. Reviewed, with two defects fixed and the design document corrected.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/test/dead-state.spec.ts, docs/fret.md
----

Phases 1–3 of the split `dead-state-transition` work, implemented and then reviewed. Sibling
ticket `dead-state-exclusion-recovery` (Phases 4–6, in `tickets/implement/`) still owns ring
exclusion of dead peers, the dead re-probe pass, and the remaining design-doc prose.

## What shipped

**Store (`digitree-store.ts`).** `PeerEntry` gains `contactFailures` (consecutive failed contact
attempts since the last proof of life) and `lastContactFailureAt` (the spacing timestamp), both
defaulted to 0 for a new entry and preserved by `upsert`'s hit branch — mirroring the existing
`negotiateFailures` / `lastNegotiateFailureAt` pair. `contactFailures` is exported in
`SerializedPeerEntry` (optional, diagnostics only) and reset to 0 on import; `lastContactFailureAt`
is never serialized. Since `importEntries` already forces `state: 'disconnected'`, an imported
table can carry neither a dead peer nor the counter that would immediately re-kill it. The store
stays network-agnostic: it stores and exposes both fields and never branches on them.

**Service (`fret-service.ts`).**

- `FretConfig.deadAfterFailures` (default 3). `this.cfg` is now `Required<FretConfig>` so no read
  site re-derives a default.
- `CONTACT_FAILURE_MIN_SPACING_MS = 500`, deliberately a separate constant from
  `NEGOTIATE_FAILURE_MIN_SPACING_MS` even though the value matches.
- `applyContactStrike(id)` — synchronous, no awaits: skip self, apply the spacing guard, clamp the
  count at the threshold, set `state: 'dead'` on reaching it.
- `applyContactFailure(id, coord)` = `applyFailure` then the strike. The single seam for "we could
  not reach this peer".
- `noteProofOfLife(id)` — synchronous: clear the run and, if the entry was `'dead'`, restore
  `'connected'` when a connection exists else `'disconnected'`. Called from `applySuccess`,
  `noteInboundRpc`, and the `peer:connect` handler.
- `noteDisconnected(id)` — the `peer:disconnect` counterpart; records the disconnect but never
  overwrites a `dead` verdict (added by this review, below).
- `noteRpcFailure(id, err)` — the routing seam: unsupported-protocol → membership strike only (the
  dial succeeded, so the peer is alive); anything else → `applyContactFailure`. Records no backoff,
  so each call site keeps its existing backoff behavior. Never throws.
- `coordOf(id)` extracted for the repeated
  `store.getById(id)?.coord ?? await hashPeerId(peerIdFromString(id))` pattern, applied at the
  sites this ticket touched; the rest of that sweep is `cleanup-core-service`'s.

Call sites routed through `noteRpcFailure`: `probeNeighborsLatency` catch, `probeMembership`
catch, `routeAct` forward catch, `iterativeLookup` activity-send catch, `iterativeLookup` hop
catch.

**Behavior deltas from funnelling five hand-rolled catch blocks through one seam** (all reviewed
and accepted): an `UnsupportedProtocolError` in `probeNeighborsLatency` no longer *also* decays
relevance; `probeMembership`, the `routeAct` forward catch, and both `iterativeLookup` catches now
decay relevance on a transient failure where they previously only recorded backoff; and the two
`iterativeLookup` catches gained membership handling they never had, so an `UnsupportedProtocolError`
on a lookup hop is no longer silently ignored.

## Review findings

Reviewed the implement commit `a67e927` diff first, then the surrounding call sites, the store
write seam, `rpc/ping.ts`, `rpc/maybe-act.ts`, `rpc/protocols.ts`, and every doc section the change
touches or should have touched.

### Fixed in this pass

**1. A disconnect silently resurrected a dead peer (correctness).** The `peer:disconnect` handler
called `store.setState(id, 'disconnected')` unconditionally, and `setState` is a plain patch — so
it cleared `dead`. That is not an edge case but the *normal* sequence: a peer whose RPCs fail
repeatedly is usually a peer whose connection is about to drop, so the disconnect that follows the
run would undo almost every transition the new seam makes. Worse, it re-admitted the peer with its
counter still clamped at the threshold, so the next failure re-killed it — a peer flapping in and
out of the ring. Today the only consumer of `dead` is `FretPeerDiscovery`, so the visible effect is
small; once the sibling ticket excludes dead peers from every ring view it becomes a routing
correctness bug. Fixed with a `noteDisconnected(id)` seam that returns early on a `dead` entry, so
`dead` is cleared only by `noteProofOfLife` (and by `peer:connect`, where a connection genuinely
formed and is itself the proof). Two tests added.

**2. The spacing stamp survived a recovery, costing one free miss per run (correctness, minor).**
`noteProofOfLife` cleared `contactFailures` but left `lastContactFailureAt` at its old value, so
the first failure of the *next* run could land inside the spacing window of a failure from the run
that just ended and be discarded. Fixed by clearing both together; test added asserting a strike
immediately after a recovery still counts.

**3. A non-finite `deadAfterFailures` silently disabled the feature (robustness, minor).**
`Math.max(1, cfg?.deadAfterFailures ?? 3)` returns `NaN` for `NaN`, and `failures >= NaN` is false
forever — so a bad config value turned the whole transition off with nothing in the logs. It also
accepted fractions. Replaced with a `normalizeThreshold` helper (finite check, floor, minimum 1)
carrying the reasoning; the helper is generic so the next threshold config inherits it.

**4. The design document described behavior this implementation deliberately rejected.**
`docs/fret.md` "Failure detection and recovery" still said hard failure was "3+ consecutive
timeouts **or explicit error**" (an explicit protocol refusal is now membership evidence and never
a strike) and that recovery "reset relevance score to baseline" (deliberately not done — success
scoring already up-ranks, and wiping health counters erases the record of a peer that flaps). Both
bullets rewritten to match the shipped code, including the spacing rule, the self guard, the
clamp, and the disconnect rule from finding 1. The "remove from S/P" claim was dropped rather than
restated, because ring exclusion has not shipped yet — the sibling ticket adds it back with the
exclusion. The sibling's Phase 6 should expect to edit around this section rather than write it
from scratch.

**5. `tickets/plan/10-failure-recovery-tests.md` named a prereq slug that no longer exists**
(`dead-state-transition`, split into these two siblings) and specified two assertions taken from
the old doc prose that the shipped code contradicts. Prereq repointed at
`dead-state-exclusion-recovery`; the two stale assertions corrected in place with a note on why.

### Filed as an arm on an existing ticket

**The liveness seam has to guess whether a peer was reached, and the guess is wrong for a peer
that answered badly.** `noteRpcFailure` distinguishes "refuses our protocol" from "could not be
reached" by name/string-matching the thrown error for unsupported-protocol; *every other* throw is
treated as unreachability. But `decodeJson` throws a plain `Error('empty response')` /
`Error('whitespace response')` / a `SyntaxError`, and `sendMaybeAct` lets those propagate — so a
peer that accepted the stream and merely replied badly takes a liveness strike, and three such
replies mark it dead. The ping path classifies identical evidence the other way (`sendPing`
collapses empty and undecodable replies into `ok: false`, no strike), so the two RPCs now disagree.

Climbing the ladder rather than filing the instance: the root cause is that the RPC layer throws
one undifferentiated error for transport failure and response failure alike, so no caller can tell
them apart. `tickets/plan/8-rpc-shared-helper.md` already owns exactly that site and already
promises "a single discriminated result type reports success, unreachable, busy, decode-error, and
foreign-protocol distinctly" — so this was appended as an arm to that ticket, not filed fresh.
Verified by reading, not by running.

### Recorded as a tripwire (not a ticket)

`applyContactStrike` and `applyMembershipSignal`'s `negotiate-failure` arm are the same shape — a
spacing guard, a clamped increment, a state transition at the threshold — written twice with
different constants, counters, and transitions. Two instances are cheaper apart than behind a
parameterized helper. Parked as a `NOTE:` at `applyContactStrike` saying to factor all three out
if a third spaced-run counter ever appears.

### Checked and found clean

- **Lost-increment concurrency.** The synchronous-strike claim holds: `applyContactStrike` and
  `noteProofOfLife` both read, patch, and return with no await between, so two concurrent chains
  cannot lose a strike. Two concurrent `applyContactFailure` calls resolve correctly — the first
  writes the stamp, the second reads it back and is swallowed by the spacing guard, which is the
  intended "one observation" behavior.
- **Store pollution from remote-supplied ids.** The two `iterativeLookup` sites now route ids from
  a remote anchor list through `applyContactFailure`, which upserts an entry for an unknown id.
  Not a new vector: the adjacent `cohort_hint` loop already upserts remote-supplied ids
  unconditionally, and `enforceCapacity` bounds the table either way. A malformed id throws inside
  `peerIdFromString` and is caught by `noteRpcFailure`'s own guard.
- **Relevance decay feeding capacity eviction.** Deltas 2–4 mean more decay on failing peers, which
  the implementer flagged as worth an adversarial look. `enforceCapacity` only runs at the 2048
  capacity, the lookup walk excludes contacted peers via its own `visited` set, and the stochastic
  churn/coverage simulations are green. Nothing to file.
- **Store write seam.** Both new fields go through the existing single private write seam; no new
  path re-derives the id-index/tree-key bookkeeping, and the model-based invariant property test
  still passes.
- **Import/export.** `contactFailures` exported for diagnostics and reset on import;
  `lastContactFailureAt` correctly not serialized. Consistent with the `negotiateFailures`
  precedent and covered by a test.
- **Config plumbing.** `deadAfterFailures` reaches the service through
  `libp2p-fret-service.ts`'s `Partial<FretConfig>` with no extra wiring; `Required<FretConfig>` is
  type-only since every optional field was already assigned.
- **Resource cleanup / error handling.** Nothing new is allocated; `noteRpcFailure` cannot throw
  into the background loops that call it from `catch` blocks, and it logs rather than swallowing.
- **Source hygiene.** The new helpers are short and single-purpose with names that carry the
  distinction (`applyContactStrike` / `noteProofOfLife` / `noteDisconnected` / `noteRpcFailure`).
  `fret-service.ts` is now 2371 lines (`wc -l`), which is over the ~1400 AGENTS.md quotes — already
  claimed by `tickets/plan/23-fret-service-decomposition.md`, so no new ticket. The `coordOf`
  sweep of the remaining ~3 call sites is `tickets/plan/17-cleanup-core-service.md`'s.

### Empty categories

- **No blocked-decision findings.** Every question this review raised had a defensible answer in
  the code or an owning ticket; none needed a human to choose.
- **No accepted-tradeoff `NOTE:`s were tripped.** Read around each finding's site; the `NOTE:`s
  present there (the `applySuccess` lost-increment note, the `enforceCapacity` full-sort note, the
  `farWeights` backoff-dominance note) all state conditions that have not occurred, and none
  covers a finding above.

## Test coverage

`packages/fret/test/dead-state.spec.ts` — 19 tests, all passing (14 from implement, 5 added by this
review).

The implement pass left the five outbound-RPC call sites verified only by type-checking and
reading, which it called its biggest gap: a call site that forgot to route its catch through
`noteRpcFailure` would have passed every test. A new `describe` block closes that by driving a real
`sendPing` — a peer id with no address in the peerStore fails every dial, so three spaced probes
through `probeNeighborsLatency` mark it dead deterministically and with no sleeping, and a live
two-node pair asserts the resurrection wiring end to end (dead → ping succeeds → `connected`, run
cleared). Also added: the two `noteDisconnected` tests and the spacing-stamp-after-recovery test
from findings 1 and 2.

Remaining gaps, unchanged and deliberately not closed here: no test pins the `peer:connect`
proof-of-life handler (the helper it calls is tested directly), and nothing pins the
synchronous-strike property against a future refactor that adds an await inside
`applyContactStrike`. `tickets/plan/10-failure-recovery-tests.md` owns the broader live-service and
two-node failure-path coverage.

## Validation

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — **511 passing, 0 failing** (~4m). No pre-existing failures
  surfaced, so `tickets/.pre-existing-error.md` was not written.
- No lint step exists in this repo (`yarn format`/`format:check` are known-broken against the house
  tab style per AGENTS.md and were correctly not run); `yarn check` is typecheck + build + test.
