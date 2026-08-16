description: Add a safety net so that if the fret test suite's process ever refuses to quit after tests finish, the run fails loudly and names what's still open, instead of hanging forever and needing a human to kill it.
files: packages/fret/package.json, packages/fret/.mocharc.json, packages/fret/test/mocha-exit-watchdog.ts
difficulty: easy
----

## What landed

- **`packages/fret/test/mocha-exit-watchdog.ts`** (new): a Mocha root-hook plugin
  (`export const mochaHooks = { afterAll() {...} }`) that arms an **unref'd** `setTimeout` once
  the whole suite finishes. If the process is still alive after the grace period (default 10s,
  overridable via `FRET_TEST_EXIT_GRACE_MS`), it writes a dump of `process.getActiveResourcesInfo()`
  (plus, for what it's worth — see below — `_getActiveHandles`/`_getActiveRequests` constructor
  names) via `fs.writeSync(2, ...)` — a raw fd write, not `process.stderr.write()`, on purpose:
  the leading hypothesis for these hangs involves a stalled stream-write callback, so routing
  through that same stream object would be invisible exactly when it matters. Then it calls
  `process.exit(1)`, turning a silent hang into a clear, non-zero, discoverable failure.
- **`packages/fret/.mocharc.json`** (new): `{ "require": ["test/mocha-exit-watchdog.ts"] }` —
  picked up automatically by any invocation from `packages/fret/` (both `yarn test` and the
  single-spec command documented in `AGENTS.md`), since Mocha auto-loads `.mocharc.json` from the
  working directory.
- **`packages/fret/package.json`**: **`--exit` was NOT removed** — see "Why this deviates from
  the ticket" below. The `test` script is unchanged from before this ticket.

## Why this deviates from the ticket

The ticket (`tickets/implement/test-run-exit-watchdog.md`, now deleted) called for dropping
`--exit` as well, on the strength of 3 measured clean runs in its own investigation. Verifying
that here reproduced the opposite, consistently: with `--exit` removed, a full suite run
(`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter dot`,
run directly with no output piping, matching how the ticket's own clean runs were taken) prints
`488 passing` and then never exits on its own — reproduced twice, once left running 400+ seconds
before being killed, once caught by the new watchdog at the 10s mark. This is a **different**
mechanism than the one the ticket's own investigation flagged as the likely cause (a Windows pipe-
flush bug inside Mocha's own `--exit` force-quit helper): that code path only exists when `--exit`
is *present*, so it cannot explain a hang observed with `--exit` absent.

Full writeup of what was ruled in/out, what's still unknown, and next steps is in the new ticket
`tickets/fix/mocha-suite-real-exit-hang.md`. Short version: something real and reproducible is
keeping the process alive after a full run; it wasn't bisected to a specific spec file or a
specific timer call site in the time available. Given that, shipping `--exit`'s removal would
turn a currently-green `yarn test` into one that hangs (or fails via the watchdog) on every future
run in an environment like this one — the opposite of what tickets in this pipeline should hand
off. So `--exit` stays for now; only the watchdog and its wiring landed. The watchdog is unaffected
by this — it still does exactly what it's meant to (verified working, see below) — it's just that
the "safe to also drop `--exit`" half of the plan turned out to be blocked on a real, separate bug.

## What to test / how to validate

- **Normal path still fast and clean.** `cd packages/fret && node --import ./register.mjs
  node_modules/mocha/bin/mocha.js "test/token-bucket.spec.ts" --timeout 30000 --exit` — passes,
  exits in ~2s wall time (node startup dominates), no watchdog output. Ran this as part of the
  handoff; unaffected by the new `.mocharc.json`/watchdog require.
- **Full suite still green.** All 488 tests pass under the existing `--exit` invocation. (The
  hang investigated above only manifests with `--exit` removed, which this ticket does not ship.)
- **Watchdog actually fires and reports correctly.** Verified live (not simulated) during this
  ticket's own investigation into the `--exit` removal: with `--exit` removed, the watchdog fired
  at the configured grace period and printed `[exit-watchdog] process still alive 10000ms after
  the last test finished. Still open: resources: Timeout ...` to stderr, then exited non-zero.
  That output is genuine evidence of the real hang in `tickets/fix/mocha-suite-real-exit-hang.md`,
  not a manufactured leak — a **deliberate scratch-spec leak test** (per the original ticket's own
  TODO list: add a plain `setInterval` in a throwaway spec, confirm the watchdog names `Timeout`
  and fails within the grace period, then remove the scratch spec) was **not additionally run**,
  since the real hang already demonstrated the exact same code path firing correctly end to end.
  Flag this as a gap if a fully synthetic/isolated repro is wanted on top of the real one.
- **Typecheck clean.** `cd packages/fret && npx tsc --noEmit` passes with the new file included
  (it's under `test/`, covered by `tsconfig.json`'s `include`).
- **`FRET_TEST_EXIT_GRACE_MS` override**: implemented (any positive finite value overrides the
  10s default; anything else falls back to the default) but not explicitly test-run under this
  ticket — low risk, single `Number()` parse with a guard, but a reviewer wanting extra confidence
  could run e.g. `FRET_TEST_EXIT_GRACE_MS=500 yarn test` against a deliberately-hung process.

## Known gaps for the reviewer

- **The real hang in `tickets/fix/mocha-suite-real-exit-hang.md` is unresolved** — this is the
  most important thing to carry forward. It blocks ever safely removing `--exit`, which was the
  other half of the originating ticket.
- **`process._getActiveHandles()` / `process._getActiveRequests()` are effectively dead on Node
  v24.2.0** (verified: return `[]` even for a script with a genuinely ref'd, still-alive
  `setInterval`) — a real gap in the ticket's own suggested diagnostic, discovered while verifying
  it, and recorded as a `NOTE:` at their use site in `mocha-exit-watchdog.ts`. They're kept in the
  watchdog's output for older-runtime compatibility and because the original ticket asked for the
  tally, but `getActiveResourcesInfo()` is the only one of the three actually load-bearing today.
- **No automated test exercises the watchdog module itself** — its correctness was verified by
  observing it catch the real hang above (a live, non-mocked end-to-end firing), not by a unit
  test in the suite. A synthetic leak-and-catch test (per the original TODO list) was not added;
  see the validation section above for why, and it remains a reasonable thing to add if the
  reviewer wants suite-enforced coverage rather than relying on this handoff's manual verification.
