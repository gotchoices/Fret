description: A test cleanup bug that left a background timer running forever (so the whole test process never quit) is fixed, and the test runner now catches this class of bug loudly instead of force-quitting over it.
files: packages/fret/test/proactive-announce.spec.ts, packages/fret/package.json, packages/fret/test/mocha-exit-watchdog.ts, AGENTS.md
difficulty: easy

## What changed (three arms, as scoped by the implement ticket)

**Arm 1 — the leak.** `packages/fret/test/proactive-announce.spec.ts`, test "peer disconnect
triggers proactive announcement to remaining neighbors" (~line 41-82). Cleanup used to exclude
node index 2 from *both* the `nodes` stop list and the `services` stop list, but only the node
was already stopped (deliberately, to simulate an abrupt departure) — `services[2]` was still
running its stabilization loop, which re-arms a ref'd `setTimeout` forever. Fix: stop all
services (`services.map(s => s.stop())`), keep only `nodes` filtered to exclude the already-
stopped index 2. The abrupt-departure timing/assertions are untouched — only the post-assertion
cleanup line changed.

**Arm 2 — stop hiding the class.** `packages/fret/package.json` `test` script no longer passes
`--exit` to mocha. The exit watchdog (`test/mocha-exit-watchdog.ts`, wired via `.mocharc.json`,
already existed before this ticket) now gets to do its job: if any future test leaks a live
handle, the run hangs 10s (`FRET_TEST_EXIT_GRACE_MS` to widen) then fails loudly with a dump of
what's still open, instead of `--exit` silently force-quitting over it.

**Arm 3 — make the watchdog's dump actionable.** `test/mocha-exit-watchdog.ts` gained opt-in
timer-origin capture behind `FRET_TEST_EXIT_TRACE=1`: when set, it wraps
`setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` globally, records a creation stack per
live (ref'd) timer, and `describeStillOpen()` prints those stacks alongside the existing
resource/handle/request dump. Off by default — no wrapping, no cost — because it patches global
timer functions process-wide. Verified working: see "How it was tested" below.

`AGENTS.md`'s "Exit watchdog" bullet updated to match — `--exit` is gone, watchdog is live, the
old "see tickets/ for the unresolved leak" pointer replaced with the `FRET_TEST_EXIT_TRACE`
mention.

## How it was tested

1. **Isolated repro of the fix.** Ran the fixed spec file alone, no `--exit`:
   `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/proactive-announce.spec.ts" --reporter dot`
   → 6 passing, exit 0, no watchdog output (previously this file alone triggered the watchdog —
   see the implement ticket's localization steps for the before-state).

2. **Full suite, twice, post-fix.** `yarn test` from `packages/fret` (no `--exit` now) →
   **490 passing, exit code 0, no watchdog output**, both runs (~4-5 min wall clock each). This
   is the ticket's stated acceptance criterion and it's met.

3. **Trace flag sanity check.** Wrote a throwaway spec that leaks a ref'd `setInterval` on
   purpose, ran it with `FRET_TEST_EXIT_TRACE=1 FRET_TEST_EXIT_GRACE_MS=3000`. Watchdog fired and
   printed the exact creation site (file:line of the throwaway spec) under a new `timer origins:`
   section. Deleted the throwaway spec afterward — not part of this diff.

4. **`npx tsc --noEmit`** from `packages/fret` → clean, exit 0. **`yarn build`** → clean, exit 0.

## Gaps / things the reviewer should know

- **A code-diagnostics pass on `mocha-exit-watchdog.ts` may show false-positive TS errors**
  ("Cannot find name 'process'", "`hasRef` does not exist on type 'number'") — that's a
  misconfigured/DOM-lib analysis tool, not the project's real `tsc`. The project's own
  `npx tsc --noEmit` (run from `packages/fret`, using the repo's `tsconfig.json`, which has no
  `types` restriction so `@types/node` applies) passes with zero errors, both before and after
  this change. One of the flagged lines (`timer.unref()` in `armWatchdog`) is pre-existing code
  this ticket didn't touch, which is further evidence the flagged errors aren't real. Trust the
  real `tsc` invocation over a generic LSP here.
- **The trace machinery (arm 3) is untested against `--exit` interaction** — irrelevant now since
  `--exit` is removed from the `test` script, but if a caller manually re-adds `--exit` to a local
  invocation, `--exit` would force-quit before the watchdog (and thus the trace dump) ever runs.
  That's inherent to what `--exit` does, not a bug in the trace code.
- **`negotiateFailures`/backoff-style per-peer state was not touched anywhere** — this ticket's
  scope was strictly the three arms above; no other file in `src/` was modified.
- Full-suite run is ~4-5 minutes wall clock. Not flaky-checked beyond the two consecutive clean
  runs above — if the reviewer wants higher confidence, a third run is cheap (~5 min) but wasn't
  deemed necessary given two consecutive clean 490-passing runs.
- No pre-existing test failures encountered; nothing filed to `tickets/.pre-existing-error.md`.

## Notes carried over from the implement ticket (still true)

- Do **not** unref the stabilization timer in `src/service/fret-service.ts` to make leaks like
  this "go away" generically — a ref'd timer is correct for a running service; a leaked service
  in production is a real leak and unref'ing would hide it there too. This ticket fixed the test's
  cleanup, not the service.
- `tickets/plan/11-networked-test-assertions.md` also lists `proactive-announce.spec.ts` in its
  `files:`, for a different, unrelated concern (weak assertions around the rate-limiting test's
  unasserted `totalSkipped`, originally ~line 134-174, now shifted by the one-line diff in this
  file). No conflict — different site, not touched by this ticket.
