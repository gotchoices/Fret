----
description: When a peer tells us it is leaving, we currently answer that one small message with up to twenty outbound network requests. Cut that to at most one small, throttled batch of announcements, and treat the departing peer's list of suggested replacements as a hint to remember rather than a list of peers to immediately go contact.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/leave.ts, packages/fret/test/churn.leave.spec.ts, docs/fret.md
difficulty: medium
----

`FretService.handleLeave` (`packages/fret/src/service/fret-service.ts:1229`) answers one inbound
leave notice with, at worst:

| Work | Count | Site |
|---|---|---|
| `sendPing` to suggested/derived replacements | ≤ 6 | warm loop, line 1277 |
| `announceNeighbors` to a replacement the ping did not connect | ≤ 6 | line 1282 |
| `snapshot()` rebuild (ring walks + size estimate + diverse sample) | ≤ 6 | line 1282, inside the loop |
| `fetchNeighbors` | ≤ 4 | `mergeNeighborSnapshots`, line 1288 |
| `announceNeighbors` to neighbors around the departed coord | ≤ 4 | `announceReplacementsToNeighbors`, line 1290 |

That is **up to 20 outbound RPCs and 7 snapshot rebuilds per accepted leave**, on top of two ring
walks and a cohort assembly (`base` / `expandCohort` / `localNew`, lines 1251-1259) whose only
purpose is to feed the warm loop.

This ticket removes the whole warm/fetch chain. This covers review finding M-core-5 (leave handler
is an amplification lever) and closes the design doc's outstanding *"Treat suggested replacements
as untrusted hints"* item under *Not yet implemented → Leave authentication*.

Both tickets this one used to wait on have landed: `transport-identity-verification` (so
`notice.from` is guaranteed to equal `connection.remotePeer` — see `src/rpc/leave.ts:40-48`) and
`dialability-guard-on-outbound-rpc` (which added the `isDialable` filter at line 1274 that this
redesign carries forward, in the form described below).

## Target design

### 1. Replacements become a local hint, not an outbound command

Delete the warm loop, the `mergeNeighborSnapshots` call, and the `base` / `expandCohort` /
`localNew` computation that fed them. In their place, iterate the sanitized replacement ids and do
nothing but a bare `store.upsert(id, coord)`:

```
for each id in notice.replacements (already ≤ 12, already parse-checked by sanitizeReplacements):
    skip if id === self, id === notice.from, or already handled this message   // dedupe
    skip if !this.isDialable(id)
    coord = await hashPeerId(peerIdFromString(id))
    this.store.upsert(id, coord)        // new entries land membership 'unknown', relevance 0
    this.diag.leaveReplacementsInserted++
await this.enforceCapacity()            // once, after the loop
```

Four things about that loop are load-bearing and each needs a comment at the site:

- **Bare `upsert`, deliberately no `applyTouch`.** This differs from the two snapshot-merge paths
  (`mergeNeighborSnapshots`, `mergeAnnounceSnapshot`), which do call `applyTouch` on merged ids.
  `applyTouch` writes a sparsity-weighted relevance score; giving an attacker-named id a non-zero
  relevance lets it outrank a genuine but not-yet-contacted peer when `enforceCapacity` evicts by
  relevance. A leave replacement is a name we were handed, not a peer we contacted, so it starts at
  relevance 0 and earns a score only when the classification pass actually reaches it.
- **`isDialable`, not `isDoomedDial`.** We are not dialing, so `foreign` and `dead` are not reasons
  to drop the id — `upsert` preserves their existing state and the appropriate `reprobeOffRing` arm
  keeps its own backoff. But an id with no peerStore address can never be probed at all (see the
  eligibility argument in §3), so inserting it only pollutes the table.
- **Skipping self is a correctness guard, not tidiness.** If self were ever absent from the store,
  upserting it here would create it with `membership: 'unknown'`, dropping self out of every
  member-only ring view (see *Network-scoped admission* in `docs/fret.md`).
- **Skipping `notice.from`** stops us re-adding the peer we removed three lines earlier.

### 2. One debounced announce, replacing two undebounced ones

Delete `announceReplacementsToNeighbors` (lines 1296-1303; `handleLeave` is its only caller) and
have `handleLeave` call the existing `announceOnDeparture(peerId, coord)` instead. The two methods
already do nearly the same thing — walk the store around the departed coordinate, pick announce
targets, send one snapshot — but `announceOnDeparture` additionally:

- **debounces per departed coordinate** (`departureDebounce`, `DEPARTURE_DEBOUNCE_MS = 2000`), and
- **excludes the departed peer** from its own target list, which the replacement announce did not.

The debounce is the whole point. A graceful departure fires *both* paths today — the leave notice,
then the `peer:disconnect` that follows it — for 4 + 8 = 12 announces on Core. Routing both through
one debounced method collapses that to a single burst of at most `announceFanout`.

### 3. Who heals the ring, then?

`stabilizeOnce` already does, every tick (1500 ms passive / 300 ms active):

- `classifyUnknownPeers` selects store entries that are `membership === 'unknown'`, not `dead`, off
  backoff, and **`isConnected(e.id) || this.hasAddresses(e.id)`** — which is exactly `isDialable`,
  and exactly the set §1 inserts. Budget 8 per tick Core / 4 Edge. A successful ping runs
  `applySuccess` → `applyMembershipSignal(id, 'rpc-success')` → `member`, at which point the peer
  enters the ring views and the S/P window is healed.
- A replacement that is locally `foreign` or locally `dead` is picked up by the matching
  `reprobeOffRing` arm instead, **with its exponential backoff intact** — which is precisely the
  arm the `dead-state-exclusion-recovery` review added to this ticket.

So the redesign does not merely bound the handler; it moves replacement probing onto the one pass
that is already budgeted, backed off, and ordered. The cost is latency: a leave used to try to heal
within one RPC round-trip and now heals within ≤ 1 stabilization tick. That is the right trade —
the departing peer told us it is going, so there is no urgency measured in milliseconds, and the
old "fast" path was mostly fictional anyway (`fetchNeighbors` is connection-only, so for a
freshly-warmed non-connected peer it returned an empty snapshot while still counting a fetch).

### 4. Resulting ceiling

Per accepted leave notice: **0 pings, 0 neighbor fetches, ≤ 12 local SHA-256 hashes + upserts, and
at most `announceFanout` announces** (Core 8 / Edge 4) — themselves debounced to one burst per
departing-peer coordinate per 2 s and metered by `bucketAnnounce` (Core 16 burst + 8/s, Edge 6 + 2/s),
which caps the node's *total* outbound announce rate across every source.

**No new profile-tuned constant is introduced.** The ceiling is profile-tuned already, by
`announceFanout` and `bucketAnnounce`; adding a third knob for this one path would be a constant to
keep in sync with no behavior of its own. The one number the implementer must not raise is the
`MAX_REPLACEMENTS = 12` cap in `src/rpc/leave.ts:16`, which is what bounds the local hash+upsert work.

Amplification arithmetic after the change, for an attacker holding one authenticated connection:
the leave bucket admits 20 notices burst + 10/s (Core), but the coordinate debounce means all
notices from that peer share one `regionKey`, so they produce **one** announce burst per 2 s
regardless of notice rate. Scaling the attack needs N distinct authenticated connections, not N
crafted messages — which is the property transport identity verification bought and this ticket
makes use of.

### 5. What must not be added

`registerLeave` is deliberately the one inbound handler that does **not** call `noteInboundRpc`
(compare the ping / neighbors / maybeAct / announce registrations at
`fret-service.ts:787-820`). Wiring it up would apply the `rpc-inbound` membership signal to the
departing peer, re-inserting it as a confirmed `member` immediately after `handleLeave` removed it.
Leave that asymmetry in place and add a short `NOTE:` at `registerLeave`'s call site saying why, so
the next person tidying the handler signatures does not "fix" it.

## Edge cases & interactions

- **Guard ordering is fixed.** `bucketLeave.tryTake()` stays the very first statement, before
  `validateTimestamp` — the same cheap-guard rule the maybeAct path documents in `docs/fret.md`.
  A rejection must mutate no store state.
- **Unparseable `from`.** With identity verification landed, `from` always parses (it is
  `connection.remotePeer.toString()`), but keep the existing `hashPeerId` try/catch and the
  `if (!coord) return` bail — it must not throw into the RPC handler.
- **Leave naming a peer we do not track.** `store.remove` is a no-op; replacements are still
  inserted and the announce still fires. Must not throw.
- **Replacement id equal to self** → skipped (see §1; would otherwise be able to drop self out of
  every ring view).
- **Replacement id equal to `notice.from`** → skipped; otherwise the peer we just removed is
  immediately re-added.
- **Replacement already `member`** → `upsert` preserves membership, state, relevance and health
  counters (`DigitreeStore.upsert`, `src/store/digitree-store.ts:183-206`). A leave notice must
  never demote or re-zero an established peer.
- **Replacement locally `foreign` or `dead`** → inserted/refreshed but never dialed from here; its
  backoff and its `reprobeOffRing` arm are untouched.
- **Replacement not dialable** → dropped, not inserted. This is the table-pollution bound: an
  attacker cannot add peerStore addresses for ids it invents, so it cannot force entries in.
- **Duplicate ids inside one replacements list** → deduped, so 12 copies of one id cost one hash
  and one upsert.
- **Absent / empty replacements list** → no inserts; the announce still fires.
- **Capacity overflow** → `enforceCapacity()` runs once after the insert loop, not per insert
  (it lists and fully sorts the store).
- **`stop()` racing an inbound leave** → the announce is `detach`ed and
  `sendAnnouncementsRateLimited` breaks on `this.stopped`; nothing may re-arm a timer. The mocha
  exit watchdog fails the run if a handle leaks.
- **Two leaves concurrently in flight** → all store operations are synchronous, so no torn state
  across the `await hashPeerId` points; `enforceCapacity` simply runs twice.
- **Leave, then the `peer:disconnect` that follows it** → one announce burst total, thanks to the
  debounce. Conversely a disconnect with *no* preceding leave must still announce exactly as it
  does today — do not regress that path.
- **Pre-existing wart, deliberately out of scope**: `peer:disconnect` → `applyFailure` →
  `store.getById(id) ?? store.upsert(...)` re-adds the peer `handleLeave` just removed, as a fresh
  `unknown`. Filed separately as `backlog/debt-scoring-resurrects-removed-peers`. Do not fix it
  here, and do not write a test that assumes the departing peer stays absent from the store.

## Tests (`packages/fret/test/churn.leave.spec.ts`)

The existing file uses `>=` assertions on diagnostics that are trivially satisfiable; the new
contract needs equality assertions. Drive these by calling `sendLeave` directly from a real second
node (so the identity check passes) rather than by stopping a service, which makes the deltas
noisy.

- **An accepted leave sends no ping and no neighbor fetch.** Snapshot `diag.pingsSent` and
  `diag.snapshotsFetched`, send one leave carrying dialable replacements, assert both are
  *unchanged*. This is the core regression guard and should fail loudly against today's code.
- **Announce fan-out per accepted leave is bounded and debounced.** Snapshot
  `diag.announcementsSent`, send two leaves from the same peer inside the 2 s debounce window,
  assert the delta is ≤ `announceFanout` for the profile (i.e. one burst, not two).
- **Replacements are inserted as `unknown`.** Name a peer the receiver can dial but has not
  classified; assert `getStore().getById(id)?.membership === 'unknown'` and `relevance === 0`.
- **An undialable replacement is not inserted.** Name a freshly generated peer id with no peerStore
  address; assert `getStore().getById(id)` is `undefined`.
- **An existing member replacement is not demoted.** Pre-set an entry to `member` with a non-zero
  relevance, name it in a leave, assert membership and relevance are unchanged afterwards.
- **Self and the departing peer are never inserted from the replacement list.** Craft a notice
  naming both; assert self's entry keeps `membership: 'member'` and that the count of
  `leaveReplacementsInserted` excludes them.
- **Duplicate replacement ids collapse.** Twelve copies of one dialable id → one entry, and
  `leaveReplacementsInserted` increments by 1.
- **The classification pass picks up an inserted replacement.** Insert via leave, run one
  stabilization tick, assert the replacement is probed and promoted to `member` — this is the
  hand-off §3 depends on, and pins that inserting-as-unknown is not a dead end.
- Rewrite the existing `'recipients probe suggested replacements from leave notice'` case — its
  name now asserts the opposite of the intended behavior. Replace with
  `'recipients record suggested replacements without probing them'`.
- Keep `'oversized replacements array is truncated'` as-is; it exercises `src/rpc/leave.ts` and is
  unaffected.

## Docs

- `docs/fret.md`, `## Leave` step 3: *"Recipients of leave notification immediately remove departing
  peer and probe suggested replacements"* → recipients remove the departing peer, record the
  suggested replacements as untrusted `unknown` entries, and leave probing to the classification
  pass. State the per-leave outbound ceiling from §4.
- `docs/fret.md`, *Security → Not yet implemented → Leave authentication*: strike *"Treat suggested
  replacements as untrusted hints"*; it is done. Leave the signature and liveness-ping items.
- `docs/fret.md`, *Ring membership → Re-probe passes*: note that leave replacements are one of the
  sources of `unknown` entries the classification pass vets.
- `fret-service.ts:1167-1181`, the `computeReplacements` doc comment, currently justifies
  live-member scoping with *"The recipient acts on these directly — it dials and pings up to six of
  them (`handleLeave`)"*. That sentence stops being true. The scoping is still right (don't
  advertise peers we gave up on, don't propagate a foreign peer into a same-network view) — rewrite
  the justification, don't drop the filter.

## TODO

Phase 1 — handler rewrite
- Add `leaveReplacementsInserted: 0` to the `diag` object (`fret-service.ts:228`)
- In `handleLeave`: delete the `base` / `expanded` / `baseSet` / `localNew` / `newIds` block, the
  `warm` loop, and the `mergeNeighborSnapshots(warm.slice(0, 4))` call
- Add the bounded, dedup'd, `isDialable`-filtered, self/`from`-excluding upsert loop from §1, with
  the four site comments it calls for
- Call `await this.enforceCapacity()` once after that loop
- Swap `announceReplacementsToNeighbors(coord)` for `announceOnDeparture(peerId, coord)`, keeping
  the `detach(...)` wrapper
- Delete `announceReplacementsToNeighbors` (now unreferenced)
- Add the `NOTE:` at the `registerLeave` call site explaining why leave alone skips `noteInboundRpc`

Phase 2 — tests
- Rewrite `'recipients probe suggested replacements from leave notice'` per the list above
- Add the no-ping/no-fetch, debounced-fan-out, inserted-as-unknown, undialable-dropped,
  member-not-demoted, self-and-from-excluded, duplicates-collapse, and classification-hand-off cases
- `cd packages/fret && npx tsc --noEmit`
- `cd packages/fret && yarn test` (foreground, unredirected; add `| tee tickets/.logs/4-leave-amplification-cap.test.log` only if you need to grep it)

Phase 3 — docs
- Apply all four `docs/fret.md` / code-comment edits listed under *Docs*
