description: A test file was added that checks the network code handles peers replying "I'm busy" or with garbage; reviewing that test file has now been cut short by a budget limit three times and the last few checks still need finishing.
files: packages/fret/test/maintenance-nonok-replies.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/test/helpers/backoff.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/service/probe-backoff.ts, packages/fret/test/fetch-snapshot-failure-arms.spec.ts, docs/fret.md
difficulty: medium
---

<!-- resume-note -->
Third run, cut off by `BUDGET_WARNING` again — but this one **banked the expensive half**. Validation
is done and green, the spec has been read in full, and three of the five open observations are now
settled against the production code. What is left is small and is listed under *Still owed* below.
No code has been changed and no findings filed yet.

## Already done — do NOT redo

**Validation (green, run 2026-08-22 at `bb31cfe`, tree clean apart from ticket moves):**

- `cd packages/fret && npx tsc --noEmit` → clean.
- `cd packages/fret && yarn test` → **1264 passing, 0 failing** (9m). Log at
  `tickets/.logs/40-maintenance-nonok-replies-spec.test.log` if it has not been pruned.
- No `.pre-existing-error.md` needed — nothing failed.

There is no lint step; `yarn check` is the gate, and `yarn format` / `yarn format:check` must not be
run (AGENTS.md).

**Read in full:** `packages/fret/test/maintenance-nonok-replies.spec.ts` (197 lines, 4 cases),
`noteAnsweredOnProtocol` + `noteRpcFailure` + `countStreamLimit` (`fret-service.ts` ~805–905),
`nearProbeTargets` + `probeAndFetch` (~2383–2412).

## Observations now settled against production code

- **`decode-error` scoring is confirmed correct.** `noteRpcFailure`'s `decode-error` arm calls
  `noteAnsweredOnProtocol(id)` then `applyFailure(id)` — membership signal + proof of life + relevance
  decay, no contact strike. Spec case 3's claims match the code exactly. `busy` falls to the
  `default:` arm ("the callers' to handle"), so the busy behavior in case 1 belongs to
  `probeNeighborLatency`, not to this seam — read that one function to close case 1.
- **`expectAnsweredNotStruck`'s membership assertion cannot be strengthened; the comment must be
  softened instead.** `nearProbeTargets` builds its list from `getNeighbors(...)`, which is a
  live-member-gated ring view, so a peer seeded `unknown` is never selected by the near pass and the
  "seed `unknown` on one arm" idea is a dead end. The assertion is therefore as strong as the rig can
  make it — but the comment `'an answer on our protocol confirms membership'` claims a *promotion*
  the arm never exercises. **Disposition: minor, fix inline** — reword to something like
  `'an answer does not demote a confirmed member'`.
- **`probeAndFetch`'s per-peer ordering and answered-gate are exactly as the spec's shared assertions
  describe** — `wasCancelled` ahead of the `answered` gate, fetch skipped for a non-answering ping.
  Case 4's "ping scores, fetch stays silent" composition is coherent with it.

## Still owed (small, ordered cheapest-first)

- **`ProbeBackoff.factor()` for a peer with no entry.** It is at
  `packages/fret/src/service/probe-backoff.ts:160` — read that one method and confirm it returns `0`
  rather than `undefined` or a throw. Three assertions in the spec depend on it (`> 0` on busy,
  `=== 0` on both decay arms); if it returns `undefined`, the two `=== 0` assertions are passing by
  coincidence and the spec needs a different accessor.
- **Case 3 (`undecodable`) is missing the `pingsOk` delta assertion** that cases 1 and 2 both carry.
  Almost certainly an oversight — one line restores symmetry. **Minor, fix inline.**
- **`probeNeighborLatency` (`fret-service.ts` ~2428–2480)** — the one production function still
  unread. It owns the `busy` arm the spec's case 1 pins (backoff recorded, `pingsSent` + `pingsFail`,
  no decay, no strike, membership confirmed). Confirm case 1's five assertions against it.
- **Overlap with `test/fetch-snapshot-failure-arms.spec.ts`.** The implementer invited deleting case 4
  if a reviewer judges it not distinct. The spec's own header argues case 4 is the whole-tick
  composition that spec cannot cover (it calls `fetchAndMergeSnapshot` directly, one arm at a time).
  Read that spec and make the call — keep or delete, but say which and why.
- **Docs.** `docs/fret.md` line 79 forward-references `test/maintenance-nonok-replies.spec.ts` twice;
  confirm the filename matches what landed. Also check whether the `busy`-records-backoff arm and the
  `fetchAndMergeSnapshot` silent arm are stated in that document accurately and pinned to this spec.

## The finding the implementer deliberately escalated (untouched)

`getDiagnostics()` returns the live `diag` object rather than a copy
(`packages/fret/src/service/fret-service.ts:511`), so **any** spec that captures it as an object and
diffs later reads zero deltas and passes vacuously. This spec avoids the trap by reading scalars.
Two things are owed, neither started:

- **The audit** — grep the other specs for the object-snapshot pattern (a `getDiagnostics()` result
  held as an object, then a later `getDiagnostics()` and a subtraction between the two). A spec with
  the hole is passing vacuously *today* — a real defect, not a tripwire.
- **The disposition** — a frozen shallow copy would make the bad pattern unrepresentable, at a
  per-call allocation cost, and it is a production change. Climb *Architecture first* before filing:
  this is a types/representation fix if it is worth doing at all. If declined, it needs an
  accepted-tradeoff `NOTE:` at the `getDiagnostics` site, since the trap is currently documented only
  in one spec's header — the wrong home for a class-level concern.

## Budget discipline for the next run

Validation is already banked, so **do not re-run `yarn test` unless you actually change a file** —
and if you do, run only the affected spec first
(`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/maintenance-nonok-replies.spec.ts" --timeout 30000`)
and the full suite once at the end. Read only the line ranges named above; grep the symbol if a range
looks off rather than reading around it. The `Bash` tool's working directory persists between calls —
use absolute paths rather than repeating `cd packages/fret`.

The output `complete/` ticket must carry a `## Review findings` section listing what was checked, what
was found, and what was done — including the empty categories, each with a reason rather than
"looks good". The material above is the raw input for it; the validation results and the three settled
observations can be carried across verbatim.

## Handoff being reviewed

One commit, `1b85381`, **test-only**: adds `packages/fret/test/maintenance-nonok-replies.spec.ts` and
moves the ticket file. No production source changed. The `Behavior` widening in
`test/helpers/maintenance-rig.ts` (`busy` / `not-ok` / `undecodable`, per-(peer, protocol) overrides)
landed earlier on this branch in `9b7c410` under a different ticket — context, not work to review here.
Do not re-read the git history; that is all of it.

The implement-stage handoff was honest about its gaps: coarse backoff assertion (factor `> 0` only,
arithmetic left to `debt-backoff-map-test-surface`), core profile only, one peer per case, no
negative-pong arm on the fetch side (the rig rejects it loudly and a neighbors reply has no `ok`
field), and no comparative case proving a bad answer scores *lower* than a good one. Treat those as
the floor the review should push on, not as settled scope.
