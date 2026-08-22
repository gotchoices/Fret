description: Second pass over the finished work that stops our own node blaming a healthy peer when it runs out of network streams. Two prior reviewer runs read the change but both ran out of budget before running the tests.
files: packages/fret/src/rpc/outcome.ts, packages/fret/src/rpc/request.ts, packages/fret/src/rpc/protocols.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.request.spec.ts, packages/fret/test/dead-state.spec.ts, docs/fret.md
difficulty: medium
---

<!-- resume-note -->
Two prior review runs were cut short by the token budget. **No code has been changed and the
test gate has never been run.** Run 2 read the whole implement diff
(`git show e2b6181 -- docs/fret.md packages/fret/src packages/fret/test`) plus `classify` in
`src/rpc/request.ts`, and resolved two of the four carried-forward observations. What is
settled is recorded below so a third run does not re-read the same material; what is left is
the outstanding list.

**Start with the gate.** Both prior runs spent their budget reading and neither ran
`npx tsc --noEmit` or `yarn test` from `packages/fret/`. Run those first this time — a green
or red gate is the single most valuable missing fact, and everything below is reading that can
be resumed after.

## Settled (verified this run — do not re-derive)

- **All seven `local-limit` sites located**, so the arm inventory no longer needs discovery:
  `fret-service.ts` lines 898 (`noteRpcFailure`), 1681 (`pingWarmupTargets`), 2425
  (`probeNeighborLatency`), 2648 (`probeMembership`), 2707 (`fetchAndMergeSnapshot`), 3020
  (`routeAct` forward path), 3334 (`iterativeLookup`). Six of the seven delegate to
  `noteRpcFailure`; `iterativeLookup`'s is an `if` rather than a `switch` case.
- **Ordering inside `classify` is correct and the reasoning stands.** The order is: caller's
  signal → `foreign-protocol` → frame truncation → payload-too-large → `local-limit` → deadline
  → `unreachable`. The caller's-cancellation check still wins ahead of everything, and placing
  the stream-cap identity ahead of the deadline check is right: the error identity is a more
  specific fact than "a deadline had fired by the time we looked". A stream-cap refusal raised
  while the deadline signal has already fired therefore reports `local-limit`, not `timeout` —
  which is the safer of the two, since both score nothing. **The reasoning is unstated at the
  site**; the existing `NOTE:` there covers only the remote-inbound-cap residual. Minor —
  extend that comment inline in this pass rather than filing anything.

## Outstanding review work

- **Run the gate first**: `cd packages/fret && npx tsc --noEmit` then `yarn test`. Both must
  pass. There is no lint step (`yarn check` is the gate; do **not** run `yarn format`).
- **`diag.streamLimit` single-sourcing.** Unresolved. `openRpcStream` raises the stream-cap
  error at the *open*, before any write, so the two write-only senders (`announceNeighbors`,
  `sendLeave`) can observe `local-limit` too — and per the handoff they only log `out.kind`
  (`fret-service.ts` ~1597, ~1839, ~1857). If so, a ceiling firing on an announce or a leave
  notice is invisible in the counter while the `docs/fret.md` bullet claims a firing ceiling is
  "visible rather than silent". Read those three sites, then either add the arm (minor, fix
  inline) or state the limit at the site *and* correct the doc sentence.
- **`pingWarmupTargets` asymmetry** (~1681). Its `foreign-protocol` / `unreachable` / `timeout`
  arm logs and returns without calling `noteRpcFailure`, while the new `local-limit` arm does
  call it. Intentional (the counter must be incremented somewhere) but reads as inconsistent at
  the site — check the comment explains it; if not, that is a one-line inline fix.
- **`iterativeLookup` (~3334) is the riskiest arm** by the implementer's own note: it does
  `hop++; continue;` rather than breaking the walk. Verify the walk still terminates (hop bound
  / attempt budget) when *every* candidate meets the ceiling, and that `target` really is
  already in `visited` at that point as the comment claims. A non-terminating walk here would
  be a major finding.
- **Weigh the implementer's stated test gaps.** No test drives `local-limit` through a real
  call site (the two new specs cover `classify` and `noteRpcFailure` in isolation), and
  `probeNeighborLatency` returning `false` — so `probeAndFetch` skips the snapshot fetch — is
  an untested behavior choice. Climb the architecture ladder before filing: one generalized
  test asserting *no* scoring side effect across all six arms beats six point tests, and beats
  a ticket per gap.
- **Confirm `docs/fret.md` reflects shipped reality**, including the counter's actual coverage
  once the point above resolves. Note the expected merge touch with the sibling
  `stream-caps-plumbing` ticket on the same *Stream management* bullet.
- **Produce the `complete/` ticket** with a `## Review findings` section — categories with
  nothing in them stated explicitly and with a reason, never silently or "looks good".
