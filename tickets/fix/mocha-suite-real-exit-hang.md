description: After all tests finish, the fret test suite sometimes never lets the process quit on its own — something is still running that keeps Node alive, and nobody has found what yet. Right now the test script forces the process to quit anyway, which hides the problem.
files: packages/fret/package.json, packages/fret/test/mocha-exit-watchdog.ts, packages/fret/.mocharc.json
repro: verified
severity: cosmetic
likelihood: normal-use
tradeoffs: `--exit` already hides this every time, so leaving it in place costs nothing today except that a future real leak (e.g. from new test code) stays invisible too; a maintainer could reasonably defer this until it causes an actual problem (flaky CI, slow agent runs) rather than root-causing a Windows-only Node-24-only hang now.
----

## Why this exists

`tickets/implement/test-run-exit-watchdog.md` set out to drop the `--exit` flag from the
fret test script (`packages/fret/package.json`) and add a watchdog (now landed at
`packages/fret/test/mocha-exit-watchdog.ts`, wired via `packages/fret/.mocharc.json`) that
fails loudly instead of hanging forever. That ticket's own investigation had measured 3 clean
runs without `--exit` and concluded the suite leaks nothing, pinning the likely cause on a
Windows pipe-flush bug inside Mocha's own `--exit` force-quit helper — meaning removing `--exit`
should have been sufficient on its own.

Verifying that conclusion here reproduced the opposite: with `--exit` removed, a full run
(`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter dot`,
no output piping) prints `488 passing (4m)` and then never exits — confirmed two separate times,
once for 400+ seconds (command backgrounded and killed) and once caught cleanly by the new
watchdog at the 10s grace mark. Because `--exit` was absent in both runs, Mocha's own force-quit
flush helper (`exitMocha`) never executes at all — so whatever is happening here is a different,
real mechanism from the one the original ticket hypothesized, not confirmation of it.

**Environment this reproduced in:** Node v24.2.0, win32, invoked from an agent/CI-style harness
(the `tess` ticket runner), from `packages/fret/`. Not yet tried in an interactive terminal or on
another Node version / OS — that comparison is exactly what's missing (see below).

## What was ruled out

- **Not the Windows-pipe-flush hypothesis.** That path only exists inside `--exit`'s `exitMocha`
  helper; it was never reached in these runs.
- **Not a classic leaked handle the usual diagnostics would show.** `process.getActiveResourcesInfo()`
  (the current, supported introspection API) showed nothing but the watchdog's own timer at the
  moment of firing.
- **`process._getActiveHandles()` / `process._getActiveRequests()` are dead on this Node version —
  do not trust them for this investigation.** Verified directly: a plain script with a genuinely
  ref'd `setInterval` still keeping the process alive returns `[]` from both. They are long-
  deprecated internal APIs with no stability guarantee, and on Node v24.2.0 they no longer report
  anything at all, ref'd or not. `getActiveResourcesInfo()` correctly saw the same ref'd interval
  in the same script, so it is the only one of the three worth trusting going forward. (A `NOTE:`
  recording this is already at the point where `mocha-exit-watchdog.ts` calls all three.)
- **Not merely "hasn't decided to exit yet."** A `process.on('beforeExit', ...)` probe (temporary,
  not shipped) never fired once across a 10+ second wait — Node's event loop was never actually
  empty, i.e. something real stayed referenced continuously, not just intermittently. This rules
  out a benign "cleanup still draining" explanation and points at an actual live handle.
- **Not the watchdog's own timer or debug instrumentation causing the appearance of a hang.**
  Controlled without any `require`d root-hook file at all (temporarily renamed `.mocharc.json`
  out of the way), the same full run still failed to exit within 400+ seconds. The hang is real
  and independent of anything added by the ticket that produced this file.

## What's still unknown

The actual resource keeping the process alive was not identified. `getActiveResourcesInfo()`
during the watchdog-caught run reported only `Timeout` (in addition to the watchdog's own,
already-excluded-by-the-unref-sanity-check timer) — so it's some timer, somewhere, still
referenced, that a whole-suite run leaves behind. It was not bisected to a specific spec file;
the suite is 50 spec files and a bisection (roughly: run half, see if it still hangs, repeat) was
not attempted due to time. Prime suspects worth checking first, since they own real timers and
run in nearly every spec via the shared libp2p test helper: the FRET service's own stabilization
loop / active-mode preconnect loop (`docs/fret.md` → "Service shell & lifecycle" section
describes a "run generation" scheme specifically meant to prevent exactly this kind of stale-timer
resurrection — worth checking whether some teardown path in `test/helpers/libp2p.ts` or a
individual spec's `afterEach` isn't calling `stop()` on every service it creates), or something
in the in-memory libp2p transport/connection teardown.

## What to do

- Bisect: run subsets of `test/**/*.spec.ts` (no `--exit`, no output piping) to narrow which
  spec file(s) leave the process unable to exit on their own. A binary split is the fastest way
  in: run half the specs, see if it hangs; if not, the leak is in the other half.
- Once narrowed, confirm with `getActiveResourcesInfo()` (not `_getActiveHandles`/
  `_getActiveRequests` — see above) what's actually still referenced, then trace it to the
  `setInterval`/`setTimeout` call site that creates it and to the teardown path that should be
  clearing it but isn't.
- Only once the real leak is found and fixed should `--exit` come back out of
  `packages/fret/package.json`'s `test` script — until then it stays, because removing it
  reproducibly turns a currently-green `yarn test` into a run that hangs until the watchdog kills
  it at the 10s grace mark (or hangs indefinitely in a harness with no watchdog config picked up).
- The watchdog (`packages/fret/test/mocha-exit-watchdog.ts`, wired via `.mocharc.json`) is
  already in place and does not need to change for this — it will validate the eventual fix for
  free: once the real leak is closed, dropping `--exit` should produce the fast, watchdog-silent
  exit both the original ticket and this one expected but never observed.
