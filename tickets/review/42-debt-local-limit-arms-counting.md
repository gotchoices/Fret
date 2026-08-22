description: When our own node runs out of network stream slots, several places in the service must react the same way — count it, blame nobody. A new test covers all of them; that test still needs its review pass finished.
files: packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.stream-caps-local-limit-scoring.spec.ts
difficulty: medium

<!-- resume-note -->
## Review run 1 — stopped early on BUDGET_WARNING

A prior review agent was cut off by the runner's soft token budget after reading the
implement diff and starting the source cross-check. **No lint/test run happened, and no
findings were dispositioned.** Nothing was edited — the working tree is exactly what the
implement stage committed (`ed7b95a`). Resume from *Still to do* below; do not redo *Done*.

### Done

- **Read the implement diff.** `ed7b95a` adds exactly one file,
  `packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts` (292 lines), and no source
  changes. `6f5c9d7` is a ticket-body-only commit. Nothing else in the diff.
- **Verified the arms table is complete against the source.** Ran
  `grep -n "countStreamLimit\|local-limit\|noteWriteOnlyOutcome\|noteRpcFailure" src/service/fret-service.ts`
  and mapped every hit to a row:

  | fret-service.ts | site | covered by |
  |---|---|---|
  | 882 | `noteRpcFailure` `case 'local-limit'` | rows 1, 2, 3 |
  | 1616 | `noteWriteOnlyOutcome`, announce | row 6 |
  | 1699/1703 | `countStreamLimit`, warm-up fan-out | row 4 |
  | 1863 | `noteWriteOnlyOutcome`, leave notice | row 7 |
  | 1881 | `noteWriteOnlyOutcome`, leave fan-out | row 8 |
  | 2472, 2695, 2754, 3067, 3436 | route into `noteRpcFailure` | row 3 (the shared seam) |
  | 3347/3357 | `countStreamLimit`, iterative lookup | row 5 |

  No site observes a `local-limit` outcome without a row pointing at it. The handoff's claim
  of full coverage holds at HEAD. This is the one check that is **finished**; treat it as
  settled unless `fret-service.ts` changed since `ed7b95a`.

### Still to do — the whole disposition pass

Run lint + tests first; they gate everything else.

- `cd packages/fret && npx tsc --noEmit`
- `cd packages/fret && yarn test` (~9 min; run in the **foreground**, no redirection, or
  `| tee tickets/.logs/42-debt-local-limit-arms-counting.test.log` if you need to grep it).
  There is no lint step in this repo — `yarn check` (typecheck + build + test) is the gate,
  and `yarn format` / `format:check` must **not** be run (see AGENTS.md).

Open questions the cut-off run had raised but not answered. Each is a *suspicion to confirm
or dismiss*, not a finding — none was verified, so none may be reported as observed.

- **Announce token-bucket headroom (row 6).** The announce row spends one token in the
  control block and four more in the capped block. If the profile's announce bucket cannot
  cover five takes in that window, the later drives become skips and `streamLimit` rises by
  fewer than `REFUSALS` — the row fails rather than passing vacuously, so this is a
  fragility question, not a correctness hole. Confirm the Core announce bucket's capacity
  and refill against five takes; if it is tight, say so at the row.
- **Is any row vacuous?** The handoff's own suggested check: comment out one
  `registerRpcHandler` cap in the capped block's `before` and confirm the matching row
  fails. Worth doing for at least the announce row (it caps
  `PROTOCOL_NEIGHBORS_ANNOUNCE`, not `PROTOCOL_NEIGHBORS`) and the lookup row.
- **Does `store.update` disturb the snapshot?** `rewindSpacing()` calls
  `store.update(peerId, { lastContactFailureAt: 0 })` between every refusal. Check it does
  not refresh `lastAccess` or re-score, which would make the `relevance` / `successCount`
  equality assertions weaker (or stronger) than they read.
- **Does the lookup row (row 5) really produce exactly one refusal** with `maxAttempts: 1`
  against an **unstarted** local service — i.e. does `iterativeLookup` have the self ring
  coordinate it needs, and does it reach 3347 rather than bailing earlier? A row that never
  dials would fail the `=== REFUSALS` assertion, so again this is a robustness question.
- **The two leave rows (7, 8) do not drive `sendLeaveToNeighbors`** — they call `sendLeave`
  directly and hand the real outcome to the helper. The handoff states this and invites an
  attempt at the real loop. Judge whether that is acceptable coverage or a gap worth a
  follow-up ticket; the handoff's stated reason for skipping is that the loop runs inside
  `stop()` and needs a cached self ring coordinate.
- **Does row 3 (the shared seam) earn its place**, or is it row 1's assertion in different
  clothing? The handoff asks this directly.
- **Remaining gaps the handoff itself declares** — no concurrency row (a pooled multi-peer
  warm-up would pin "exactly once per refusal" under a shared-increment bug), the lookup
  row pinning one refusal rather than the walk's reaction to it, and private methods reached
  by cast so a rename fails at runtime rather than at compile time. Decide each: fix inline
  (minor), file a ticket (major, after climbing the *Architecture first* ladder), or record
  as a tripwire `NOTE:` (conditional).
- **Docs.** `docs/fret.md`'s *Stream management* section already names
  `test/rpc.stream-caps-local-limit-scoring.spec.ts` as what pins the scoring arms. Confirm
  whether it should now also name this new arms spec, and whether the sentence describing
  what is pinned is still accurate. Treat the doc as out of date until read.
- **Companion ticket.** `debt-local-limit-arms-noncounting` (sequence 42.5) extends this
  same file with the `cancelled` / `skipped` rows plus the source `NOTE:` and a
  `docs/fret.md` paragraph. Nothing in that scope belongs to this ticket — do not absorb it.

The output `complete/` ticket still needs its `## Review findings` section: what was
checked, what was found, what was done, with empty categories stated explicitly and with a
reason.
