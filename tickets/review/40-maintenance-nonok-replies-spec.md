description: A test file was added that checks the network code handles peers replying "I'm busy" or with garbage; most of reviewing it is now done, and what remains is one documentation check plus a wider look at a trap other test files may have fallen into.
files: packages/fret/test/maintenance-nonok-replies.spec.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
---

<!-- resume-note -->
Fourth run, cut off by `BUDGET_WARNING` again — but the review is now **almost finished**. Every
observation about the spec itself is settled, both minor fixes have been made and verified, and the
only work left is one documentation check and one codebase-wide audit. Everything below marked
*settled* is raw material for the `complete/` ticket's `## Review findings` section and must be
carried into it — do not re-derive it.

## Already done — do NOT redo

**Validation (green):**

- `cd packages/fret && npx tsc --noEmit` → clean (run 2026-08-22 at `bb31cfe`).
- `cd packages/fret && yarn test` → **1264 passing, 0 failing** (9m), same SHA.
- After this run's two edits: the affected spec alone re-run green — **4 passing**
  (`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/maintenance-nonok-replies.spec.ts" --timeout 30000`).
- No `.pre-existing-error.md` needed — nothing failed.

There is no lint step; `yarn check` is the gate, and `yarn format` / `yarn format:check` must not be
run (AGENTS.md).

**Fixes landed this run** (both in `packages/fret/test/maintenance-nonok-replies.spec.ts`, both
minor, both verified by the spec run above):

- `expectAnsweredNotStruck`'s membership assertion message reworded from
  `'an answer on our protocol confirms membership'` to
  `'an answer does not demote a confirmed member'`, with a comment saying why the stronger claim is
  not exercisable here (the near pass draws targets from the live-member-gated ring view, so a peer
  seeded `unknown` is never selected).
- Case 3 (`undecodable`) gained the `p.ok - p0.ok === 0` assertion cases 1 and 2 already carried —
  restores symmetry across the three ping arms.

## Settled observations (carry verbatim into `## Review findings`)

- **`decode-error` scoring is correct.** `noteRpcFailure`'s `decode-error` arm calls
  `noteAnsweredOnProtocol(id)` then `applyFailure(id)` — membership signal + proof of life +
  relevance decay, no contact strike. Case 3's claims match the code exactly.
- **Case 1's `busy` arm matches `probeNeighborLatency` exactly.** Read at
  `fret-service.ts` ~2428–2480: the `busy` case increments `pingsSent` and `pingsFail`, calls
  `noteAnsweredOnProtocol(id)` and `this.backoff.record(id)`, and takes no decay and no strike. All
  five of the spec's case-1 assertions are correct against it.
- **`ProbeBackoff.factor()` returns `0` for a peer with no entry**
  (`packages/fret/src/service/probe-backoff.ts:160` — `this.entries.get(id)?.factor ?? 0`). The
  spec's two `=== 0` assertions on the decay arms are therefore meaningful, not passing by
  coincidence, and its `> 0` on busy is a real signal.
- **`probeAndFetch`'s per-peer ordering and answered-gate match the spec's shared assertions** —
  `wasCancelled` sits ahead of the `answered` gate, and the fetch is skipped for a non-answering
  ping.
- **Case 4 is distinct from `test/fetch-snapshot-failure-arms.spec.ts` — keep it.** That spec's
  cases are `skipped`, `decode-error`, `ok`, `foreign-protocol`, `unreachable` and `timeout`, each
  driven by calling `fetchAndMergeSnapshot` directly against its own connection stub. It has **no
  `busy` arm at all**, and it never runs a whole tick. Case 4 pins the composition — ping half
  scoring while fetch half stays silent, both observed through one `stabilizeOnce` — which nothing
  else covers. The implementer's invitation to delete it is declined.
- **The implementer's stated gaps are the honest floor and are not being re-filed** (coarse backoff
  assertion deferred to `debt-backoff-map-test-surface`, core profile only, one peer per case, no
  negative-pong arm on the fetch side, no comparative "bad answer scores lower than good" case).
  Each is a documented narrowing of a test-only spec, not a defect.

## Still owed (all that is left)

- **Docs check on `docs/fret.md` line 79.** The filename it forward-references twice
  (`test/maintenance-nonok-replies.spec.ts`) **matches what landed** — confirmed this run. The
  `busy`-records-backoff arm is stated accurately there (`pingsSent` + `pingsFail`, no relevance
  decay, no strike, membership confirmed, `ProbeBackoff.record`) — also confirmed against the
  production code above. What is **not** yet checked: whether the `fetchAndMergeSnapshot` silent
  `busy`/`decode-error` arm is stated anywhere in that document and pinned to the right spec.
  `grep -n "fetchAndMergeSnapshot" docs/fret.md` and read the hits; add or correct one sentence if
  the silent arm is missing or attributed to the wrong file.
- **The `getDiagnostics()` shared-object audit** — the finding the implementer deliberately
  escalated, still untouched. `getDiagnostics()` returns the live `diag` object rather than a copy
  (`packages/fret/src/service/fret-service.ts:511`), so **any** spec that captures it as an object
  and diffs later reads zero deltas and passes vacuously. The spec under review avoids the trap by
  reading scalars; other specs may not. Two things are owed:
  - **The audit.** Grep the other specs for the pattern: a `getDiagnostics()` result held as an
    object, then a later `getDiagnostics()` and a subtraction between the two. A spec with that hole
    is passing vacuously *today* — a real latent defect, not a tripwire, so it needs a ticket (or an
    inline fix if it is one or two lines).
  - **The disposition.** A frozen shallow copy would make the bad pattern unrepresentable, at a
    per-call allocation cost, and it is a production change. Climb *Architecture first* before
    filing: this is a types/representation fix (rung 1) if it is worth doing at all. If declined, it
    needs an accepted-tradeoff `NOTE:` at the `getDiagnostics` site, since the trap is currently
    documented only in one spec's file header — the wrong home for a class-level concern.
- **Full suite once at the end**, only if the docs check or the audit changes a file:
  `cd packages/fret && yarn test`. If neither changes anything under `packages/fret/`, the banked
  1264-passing run plus this run's 4-passing spec run is sufficient and re-running is waste.

## Budget discipline for the next run

This is a small amount of work — do not re-open anything under *Settled observations* and do not
re-read `packages/fret/test/maintenance-nonok-replies.spec.ts` (197 lines, fully reviewed, two fixes
landed). Two greps and at most one production-file edit stand between here and the `complete/`
ticket. The `Bash` tool's working directory persists between calls — use absolute paths rather than
repeating `cd packages/fret`.

The output `complete/` ticket must carry a `## Review findings` section listing what was checked,
what was found, and what was done — including the empty categories, each with a reason rather than
"looks good". Everything above is the raw input for it.

## Handoff being reviewed

One commit, `1b85381`, **test-only**: adds `packages/fret/test/maintenance-nonok-replies.spec.ts` and
moves the ticket file. No production source changed. The `Behavior` widening in
`test/helpers/maintenance-rig.ts` (`busy` / `not-ok` / `undecodable`, per-(peer, protocol) overrides)
landed earlier on this branch in `9b7c410` under a different ticket — context, not work to review
here. Do not re-read the git history; that is all of it.
