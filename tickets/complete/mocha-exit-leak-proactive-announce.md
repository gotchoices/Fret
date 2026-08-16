description: A test cleanup bug that left a background timer running forever (so the whole test process never quit) is fixed, and the test runner now catches this class of bug loudly instead of force-quitting over it.
files: packages/fret/test/proactive-announce.spec.ts, packages/fret/test/mocha-exit-watchdog.ts, packages/fret/test/mocha-exit-watchdog.spec.ts, packages/fret/package.json, AGENTS.md

## What shipped

**Arm 1 — the leak.** `test/proactive-announce.spec.ts`, test "peer disconnect triggers proactive
announcement to remaining neighbors": cleanup excluded index 2 from both the `services` and the
`nodes` stop lists, but only the *node* had been stopped (deliberately, to simulate an abrupt
departure). `services[2]` kept re-arming a ref'd `setTimeout` in its stabilization loop forever,
which alone kept Node alive. Now all services are stopped; only `nodes` stays filtered.

**Arm 2 — stop hiding the class.** `--exit` removed from the `test` script in
`packages/fret/package.json`, so the pre-existing exit watchdog (wired through `.mocharc.json`)
actually fires on a leaked handle instead of mocha force-quitting over it.

**Arm 3 — actionable dump.** `test/mocha-exit-watchdog.ts` gained opt-in timer-origin capture
behind `FRET_TEST_EXIT_TRACE=1`: wraps `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`,
records a creation stack per live ref'd timer, prints them under `timer origins:`. Off by default.

`AGENTS.md`'s "Exit watchdog" bullet updated to match.

## Review findings

**Diff read first, then the handoff.** The implement-stage claims were re-derived rather than
taken on trust: the spec's cleanup was read in context (the abrupt-departure window and its
assertions are genuinely untouched — only the post-assertion stop line changed), `--exit` was
grepped for repo-wide (one remaining live mention, the corrected `AGENTS.md` bullet; the rest are
comments explaining *why* it is absent, plus `tickets/.logs/` history), and every claimed check
was re-run locally rather than accepted from the write-up.

**Minor — fixed in this pass:**

- *Every captured stack led with the watchdog's own wrapper frame.* `captureStack()` sliced 2
  lines (the `Error:` message + its own frame) but the stack also contains the wrapping
  `globalThis.setTimeout` frame, so the first line a maintainer read named
  `mocha-exit-watchdog.ts`, not the leaking call site — blunting the exact thing arm 3 exists to
  provide. Now slices 3, with the reason stated at the site.
- *Arm 3 shipped with zero test coverage, next to a harness purpose-built for it.*
  `test/mocha-exit-watchdog.spec.ts` already spawns child mocha runs over fixtures in
  `test/fixtures/` and asserts on their exit code and stderr; adding trace coverage was a
  three-line change to `runFixture` plus two cases. Added: one asserting the trace dump names the
  fixture's own call site **on its first frame** (which pins the slice depth above, so a future
  frame added between `captureStack` and the wrapper fails here rather than silently degrading
  the output), and one asserting the off-by-default path prints the "set `FRET_TEST_EXIT_TRACE=1`"
  hint. Both pass; the first fails against the pre-fix slice depth, so it is a real regression pin.

**Tripwires — parked at the site, not filed:**

- The trace patches the *globals* only. A timer armed via a `node:timers` / `node:timers/promises`
  import is invisible to it. Nothing in this package imports timers that way today (verified by
  grep over `src/` and `test/`), so widening the patch would be untested machinery for a case that
  does not exist. Recorded as a `NOTE:` above `TRACE_ENABLED` in `test/mocha-exit-watchdog.ts`,
  including the symptom that would mean you have hit it (a live `Timeout` in the dump with no
  origin captured).

**Major — none, so no new tickets filed.** Checked specifically for a class behind arm 1's
instance: the "stop the node but not its service" shape appears exactly once in the suite
(`grep -rn "filter((_, i)" test/*.spec.ts` → the single, now-correct `nodes` filter). The standing
invariant for the class is arm 2 itself — with `--exit` gone, any future leak of this shape fails
its run loudly, which is a higher rung than a point ticket would have been.

**Considered and left alone:**

- Unref'ing the stabilization timer in `src/service/fret-service.ts` would make this and every
  future leak of the shape vanish — and that is exactly why it is wrong; a ref'd timer is correct
  for a running service, and unref'ing hides real production leaks too. Declined at both prior
  stages; agreed, nothing re-litigated.
- `--exit` re-added to a local invocation would force-quit before the watchdog (and its trace)
  runs. That is what `--exit` *does*; not a defect in this code, and the `test` script no longer
  passes it.
- The trace map holds a strong reference per live timer. Bounded by the number of outstanding
  timers, off by default, and only ever enabled for a one-off bisect — no action.

**Docs:** `AGENTS.md`'s watchdog bullet was read against the shipped code and is accurate
(`--exit` gone, watchdog live, `FRET_TEST_EXIT_TRACE` documented). `docs/fret.md` was checked and
deliberately not touched — its "Testing strategy" section describes what is tested, never the
runner's invocation flags, so this change gives it nothing to say.

**Diagnostics noise, confirmed a false positive:** the editor's TS analysis reports
`Cannot find name 'process'` and `hasRef does not exist on type 'number'` in
`mocha-exit-watchdog.ts` — it flags pre-existing untouched lines (`timer.unref()`) identically.
The project's own `npx tsc --noEmit` from `packages/fret` is clean, so the handoff's assessment
holds.

## Validation (all re-run at review, not carried over)

- `npx tsc --noEmit` from `packages/fret` → clean, exit 0.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/mocha-exit-watchdog.spec.ts"`
  → 4 passing (2 pre-existing + 2 new), exit 0.
- `yarn test` (full suite, no `--exit`) → **492 passing, exit 0, zero `exit-watchdog` output** in
  ~4 min. The count is 490 + the 2 tests added here.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
