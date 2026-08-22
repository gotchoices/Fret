description: When our own node runs out of network stream slots, several places in the service must react the same way — count it, blame nobody. A new test covers all of them; that test still needs its review pass finished.
files: packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.stream-caps-local-limit-scoring.spec.ts
difficulty: medium

<!-- resume-note -->
## Two review runs so far; both stopped early on BUDGET_WARNING

**Run 1** read the implement diff and verified the arms table against the source.
**Run 2** re-verified the tree, read the new spec end to end, and ran the typecheck.

**The test suite has still never been run, and no finding has been dispositioned.** Nothing has
been edited in either run — the working tree is exactly what the implement stage committed
(`ed7b95a`). Resume from *Still to do*; do not redo *Done*.

### Done (settled — do not repeat)

- **The implement diff is exactly one new file.** `ed7b95a` adds
  `packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts` (292 lines) and changes no source.
  `6f5c9d7` is ticket-body-only. Confirmed again in run 2 against `git status` (clean apart from
  the runner's own untracked `tickets/.in-progress`).
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

  The handoff's claim of full coverage holds at HEAD. Treat as settled unless `fret-service.ts`
  changed since `ed7b95a`.
- **Typecheck passes.** `cd packages/fret && npx tsc --noEmit` — exit 0 (run 2).
- **The spec has been read.** Its shape, so run 3 need not re-read all 292 lines to orient:
  - An `Arm` interface (`name`, `protocol`, `drive()`, optional `proveControl`) and a table of
    **8 arms**, driven through a `priv()` cast at the private passes.
  - Two `describe` blocks over the same table. The **control** block runs first, before any cap is
    installed, and asserts `streamLimit` delta 0 / no strike / not dead, plus each row's own
    `proveControl`. The **capped** block registers every distinct protocol in the table at
    `maxOutboundStreams: 0`, then drives each row `REFUSALS` (4) times and asserts no strike, no
    relevance change, no success/failure count, no `negotiateFailures`, no backoff, and
    `streamLimit` delta **exactly** `REFUSALS`.
  - A guard case asserts `REFUSALS > cfg.deadAfterFailures`, so the "no strike" assertions would
    provably have reached `dead` on a broken implementation.
  - `rewindSpacing()` — `store.update(peerId, { lastContactFailureAt: 0 })` — is called between
    every refusal to defeat the 500 ms contact-failure spacing guard, without which four
    back-to-back refusals would book at most one strike even when broken.
  - The local service is deliberately never `start()`ed; the remote one is, so control calls are
    answered.

### Still to do — the whole disposition pass

**Run the test suite first; it gates everything else.**

- `cd packages/fret && yarn test` (~9 min). Run in the **foreground with no redirection**, or
  `| tee tickets/.logs/42-debt-local-limit-arms-counting.test.log` if you need to grep it.
  There is no lint step in this repo — `yarn check` (typecheck + build + test) is the gate, and
  `yarn format` / `format:check` must **not** be run (see AGENTS.md). The typecheck half is
  already green (above), so `yarn test` alone is what remains.

Then disposition the open questions below. Each is a *suspicion raised by reading*, not a verified
finding — **none may be reported as observed.** Each ends as: fixed inline (minor), a new ticket
(major, after climbing the *Architecture first* ladder), or a tripwire `NOTE:` (conditional).

- **Announce token-bucket headroom (row 6).** The announce row spends one take in the control block
  and four more in the capped block — five in one before-to-after window. Reading the spec settles
  the *failure mode* but not the *risk*: a dry bucket makes the announce choke point skip before it
  sends, so `streamLimit` would rise by fewer than `REFUSALS` and the row **fails loudly rather
  than passing vacuously**. What is still unchecked is whether the Core announce bucket's capacity
  and refill actually cover five takes in that window. If it is tight, say so at the row.
- **Is any row vacuous?** The control block asserts `streamLimit` delta 0 *before* caps exist, which
  catches a row whose protocol was never capped only in one direction. The handoff's own suggested
  check is the other direction: comment out one `registerRpcHandler` cap in the capped block's
  `before` and confirm the matching row fails. Worth doing for at least the announce row (it caps
  `PROTOCOL_NEIGHBORS_ANNOUNCE`, not `PROTOCOL_NEIGHBORS` — confirm that is the protocol
  `announceNeighbors` actually dials) and the lookup row.
- **Does `store.update` disturb the snapshot?** `rewindSpacing()` calls
  `store.update(peerId, { lastContactFailureAt: 0 })` between every refusal. Check
  `DigitreeStore.update` does not refresh `lastAccess` or re-score, which would make the
  `relevance` / `successCount` equality assertions weaker (or stronger) than they read.
- **Does the lookup row (row 5) really produce exactly one refusal** with `maxAttempts: 1` against
  an **unstarted** local service — i.e. does `iterativeLookup` have the self ring coordinate it
  needs, and does it reach 3347 rather than bailing earlier? A row that never dials would fail the
  `=== REFUSALS` assertion, so this is a robustness question, not a correctness hole.
- **The two leave rows (7, 8) do not drive `sendLeaveToNeighbors`** — they call `sendLeave`
  directly and hand the real outcome to `noteWriteOnlyOutcome` under two different labels. The
  handoff states this and invites an attempt at the real loop. Judge whether that is acceptable
  coverage or a gap worth a follow-up ticket; the handoff's stated reason for skipping is that the
  loop runs inside `stop()` and needs a cached self ring coordinate.
- **Does row 3 (the shared seam) earn its place**, or is it row 1's assertion in different clothes?
  Row 1 drives `probeNeighborLatency`, which routes into `noteRpcFailure`; row 3 calls
  `noteRpcFailure` directly with a real refused outcome. The handoff asks this directly.
- **Remaining gaps the handoff itself declares** — no concurrency row (a pooled multi-peer warm-up
  would pin "exactly once per refusal" under a shared-increment bug), the lookup row pinning one
  refusal rather than the walk's reaction to it, and private methods reached by cast so a rename
  fails at runtime rather than at compile time.
- **Docs.** `docs/fret.md`'s *Stream management* section already names
  `test/rpc.stream-caps-local-limit-scoring.spec.ts` as what pins the scoring arms. Confirm whether
  it should now also name this new arms spec, and whether the sentence describing what is pinned is
  still accurate. Treat the doc as out of date until read.
- **Companion ticket.** `debt-local-limit-arms-noncounting` (sequence 42.5) extends this same file
  with the `cancelled` / `skipped` rows plus the source `NOTE:` and a `docs/fret.md` paragraph.
  Nothing in that scope belongs to this ticket — do not absorb it.

The output `complete/` ticket still needs its `## Review findings` section: what was checked, what
was found, what was done, with empty categories stated **explicitly and with a reason**.
