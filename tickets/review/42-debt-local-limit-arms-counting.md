description: When our own node runs out of network stream slots, several places in the service must react the same way — count it, blame nobody. A new test covers all of them; that test still needs the last part of its review pass finished.
files: packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/store/digitree-store.ts, docs/fret.md
difficulty: medium

<!-- resume-note -->
## Three review runs so far; all stopped on BUDGET_WARNING

**Run 1** read the implement diff and verified the arms table against the source.
**Run 2** re-verified the tree, read the new spec end to end, ran the typecheck.
**Run 3** ran the full test suite — **green** — and settled the questions the green run answers.

Nothing has been edited in any run — the working tree is still exactly what the implement stage
committed (`ed7b95a`), clean apart from the runner's own untracked `tickets/.in-progress`. Resume
from *Still to do*; do not redo *Settled*.

### Settled — do not repeat

- **The implement diff is exactly one new file.** `ed7b95a` adds
  `packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts` (292 lines), changes no source.
  `6f5c9d7` is ticket-body-only.
- **The arms table is complete against the source.** Every site in `fret-service.ts` that observes
  a `local-limit` outcome has a row pointing at it:

  | fret-service.ts | site | covered by |
  |---|---|---|
  | 882 | `noteRpcFailure` `case 'local-limit'` | rows 1, 2, 3 |
  | 1616 | `noteWriteOnlyOutcome`, announce | row 6 |
  | 1699/1703 | `countStreamLimit`, warm-up fan-out | row 4 |
  | 1863 | `noteWriteOnlyOutcome`, leave notice | row 7 |
  | 1881 | `noteWriteOnlyOutcome`, leave fan-out | row 8 |
  | 2472, 2695, 2754, 3067, 3436 | route into `noteRpcFailure` | row 3 (the shared seam) |
  | 3347/3357 | `countStreamLimit`, iterative lookup | row 5 |

- **Typecheck passes.** `cd packages/fret && npx tsc --noEmit` — exit 0 (run 2).
- **The full suite passes.** `cd packages/fret && yarn test` — **1281 passing (7m)**, zero failures,
  zero pre-existing failures to report (run 3). All 17 cases of the new spec ran and passed: 8
  control rows, the `REFUSALS > deadAfterFailures` guard, 8 capped rows. There is no lint step in
  this repo and `yarn format` must not be run (AGENTS.md), so with typecheck green the gate is met.
  **Re-running the suite is not required** unless run 4 edits source or spec.
- **No row is vacuous, and the mutation experiment run 2 proposed is unnecessary.** Its reasoning
  was that a row capping the wrong protocol would pass silently. It would not: the capped block
  asserts `streamLimit` delta **exactly** `REFUSALS`, so a row whose protocol was never capped
  yields delta 0 and **fails**. The green run therefore proves every row's cap really bit,
  including the announce row (so `announceNeighbors` does dial `PROTOCOL_NEIGHBORS_ANNOUNCE`, not
  `PROTOCOL_NEIGHBORS`) and the lookup row.
- **The lookup row (row 5) produces exactly one refusal per drive.** Same assertion, same argument:
  `=== REFUSALS` passed, so `iterativeLookup` with `maxAttempts: 1` reaches 3347 against the
  unstarted local service and dials exactly once.
- **The announce row's token bucket had headroom for all five takes** — one in the control block,
  four in the capped block. The control asserts `announcementsSkipped` delta 0 (the bucket had a
  token) and the capped block got its four counts. What is **not** measured is the *margin*: the
  bucket's capacity and refill were never read (`bucketAnnounce`, `fret-service.ts:465`). See
  *Still to do*.
- **The spec's shape**, so run 4 need not re-read all 292 lines to orient: an `Arm` interface
  (`name`, `protocol`, `drive()`, optional `proveControl`) and a table of 8 arms driven through a
  `priv()` cast; two `describe` blocks over that table, control first (before any cap exists) then
  capped (every distinct protocol registered at `maxOutboundStreams: 0`); `rewindSpacing()` —
  `store.update(peerId, { lastContactFailureAt: 0 })` — between every refusal, defeating the 500 ms
  contact-failure spacing guard; the local service deliberately never `start()`ed, the remote one
  started so control calls are answered.

### Still to do — the remainder of the disposition pass

No source or test file has been edited, and **no finding has been dispositioned**. Each item below
is a *suspicion raised by reading*, not a verified finding — **none may be reported as observed.**
Each must end as: fixed inline (minor), a new ticket (major, after climbing the *Architecture
first* ladder), or a tripwire `NOTE:` (conditional).

- **Docs — the one stage requirement still unmet.** `docs/fret.md`'s *Stream management* section
  names `test/rpc.stream-caps-local-limit-scoring.spec.ts` as what pins the scoring arms. Confirm
  whether it should now also name this new arms spec, and whether the surrounding sentence
  describing what is pinned is still accurate. Neither file has been read in any run — treat the
  doc as out of date until read.
- **Does `store.update` disturb the snapshot the assertions compare against?** `rewindSpacing()`
  calls `store.update(peerId, { lastContactFailureAt: 0 })` between every refusal. Check
  `DigitreeStore.update` (`src/store/digitree-store.ts`) does not refresh `lastAccess` or re-score;
  if it does, the `relevance` / `successCount` / `failureCount` equality assertions are weaker (or
  stronger) than they read, and the spec should say so.
- **Announce bucket margin (row 6).** Read `bucketAnnounce`'s capacity and refill
  (`fret-service.ts:465`) and judge whether five takes in one before-to-after window sits
  comfortably inside them. The failure mode is benign — a dry bucket makes the announce choke point
  skip before it sends, so the row fails loudly rather than passing vacuously — so this is a
  flakiness question, not a correctness one. If tight, a `NOTE:` at the row is the disposition.
- **The two leave rows (7, 8) do not drive `sendLeaveToNeighbors`.** They call `sendLeave` directly
  and hand the real outcome to `noteWriteOnlyOutcome` under two different labels. The implement
  handoff states this and gives its reason for skipping the real loop: that loop runs inside
  `stop()` and needs a cached self ring coordinate. Judge whether that is acceptable coverage or a
  gap worth a follow-up ticket.
- **Does row 3 (the shared seam) earn its place**, or is it row 1's assertion in different clothes?
  Row 1 drives `probeNeighborLatency`, which routes into `noteRpcFailure`; row 3 calls
  `noteRpcFailure` directly with a real refused outcome. The implement handoff asks this directly.
- **Remaining gaps the implement handoff itself declares** — no concurrency row (a pooled
  multi-peer warm-up would pin "exactly once per refusal" under a shared-increment bug), the lookup
  row pinning one refusal rather than the walk's reaction to it, and private methods reached by
  cast so a rename fails at runtime rather than at compile time.
- **Companion ticket — out of scope.** `debt-local-limit-arms-noncounting` (sequence 42.5) extends
  this same file with the `cancelled` / `skipped` rows plus the source `NOTE:` and a `docs/fret.md`
  paragraph. Nothing in that scope belongs to this ticket — do not absorb it.

### Output

The `complete/` ticket needs its `## Review findings` section: what was checked, what was found,
what was done, with empty categories stated **explicitly and with a reason**. Findings already
established and safe to carry into it: the suite and typecheck both pass; the arms table is
complete against every `local-limit` site in the source; no row is vacuous, proven by the exact
`=== REFUSALS` delta rather than by a mutation experiment.
