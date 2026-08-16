----
description: One test shuts down a peer's network connection but forgets to shut down the peer's own background service, which keeps a repeating timer running forever and stops the test process from ever quitting. Fix that test, then stop force-killing the test process so any future leak of this kind fails loudly instead of hiding.
files: packages/fret/test/proactive-announce.spec.ts, packages/fret/package.json, packages/fret/test/mocha-exit-watchdog.ts, AGENTS.md
difficulty: easy
----

## Root cause (found — no further investigation needed)

`packages/fret/test/proactive-announce.spec.ts`, test **"peer disconnect triggers proactive
announcement to remaining neighbors"** (line ~41). The test deliberately kills node 2 abruptly
(`await nodes[2].stop()`, line 69) to simulate an ungraceful departure. Cleanup then excludes
index 2 from **both** lists:

```ts
await Promise.all(services.filter((_, i) => i !== 2).map(s => s.stop()))   // line 81
await stopAll(nodes.filter((_, i) => i !== 2))                             // line 82
```

Excluding the *node* is correct — it is already stopped. Excluding the *service* is the bug:
`services[2]` is never stopped, so its stabilization loop
(`src/service/fret-service.ts:1290` `startStabilizationLoop`) keeps re-arming a **ref'd**
`setTimeout(tick, 1500)` at line 1310 for the life of the process. Only `stop()` bumps the run
generation and clears that timer (`clearLoopTimers`, line ~588). One ref'd repeating timer is
enough to keep Node alive forever — which is exactly the whole-suite hang.

That also explains why the watchdog's dump was uninformative: `getActiveResourcesInfo()` reported
`Timeout` and nothing else, because a bare timer is all there is.

## How it was localized

Every spec file was run alone, no `--exit`, `FRET_TEST_EXIT_GRACE_MS=3000`:

```bash
cd packages/fret
for f in test/*.spec.ts; do
  out=$(FRET_TEST_EXIT_GRACE_MS=3000 node --import ./register.mjs \
        node_modules/mocha/bin/mocha.js "$f" --reporter dot 2>&1)
  echo "$out" | grep -q exit-watchdog && echo "HANG $f" || echo "ok   $f"
done
```

42 files, exactly one `HANG`: `test/proactive-announce.spec.ts`. Narrowed within the file:

- `--grep "peer disconnect triggers"` → 1 passing, then watchdog fires (`resources: PipeWrap,
  PipeWrap, Timeout`), exit 1.
- `--grep "peer disconnect triggers" --invert` → 5 passing, exit 0, watchdog silent.

The correction was also pre-verified with a throwaway spec (since deleted) reproducing the same
shape but stopping *all* services after the node was already down: passes, exits 0, no watchdog.
So `svc.stop()` on a service whose libp2p node is already stopped neither throws nor hangs —
`unregisterRpcHandlers()` is fine against a stopped registrar and `sendLeaveToNeighbors()` is
already wrapped in a try/catch.

## Shape of the fix

**Arm 1 — the leak.** Stop `services[2]` too, *after* the assertions, so the measurement window
still sees an abrupt departure with no graceful FRET leave notice (that is what the test is
about). Only the node stays excluded from cleanup, since it is already stopped:

```ts
await Promise.all(services.map(s => s.stop()))
await stopAll(nodes.filter((_, i) => i !== 2))
```

**Arm 2 — stop hiding the class.** Drop `--exit` from the `test` script in
`packages/fret/package.json`. The watchdog (`test/mocha-exit-watchdog.ts`, wired via
`.mocharc.json`) then fails any future run that leaks a handle, instead of `--exit` force-quitting
over it. This is the point of the whole exercise: the watchdog is the standing boundary invariant
for this bug class, and it is inert while `--exit` is passed. Update the `AGENTS.md` "Exit
watchdog" bullet, which currently says the `test` script still passes `--exit` and points at this
ticket for why.

**Arm 3 — make the watchdog's dump actionable.** Today it prints `Timeout` and nothing more, which
cost a ~6-minute whole-suite bisect to turn into a file name. Add opt-in origin capture behind an
env flag (e.g. `FRET_TEST_EXIT_TRACE=1`): wrap `setTimeout`/`setInterval` to record a creation
stack per live handle, and have `describeStillOpen()` print the stacks of whatever is still
outstanding. Off by default so a normal run pays nothing. Tradeoff: it is extra machinery in a
test-only file, and a maintainer could reasonably decide the next bisect is cheap enough — if so,
say so at the site rather than leaving the gap undocumented.

## Notes for whoever picks this up

- `tickets/plan/11-networked-test-assertions.md` also lists `proactive-announce.spec.ts` in its
  `files:`, but for a different concern (weak assertions around lines 134–174 — the rate-limiting
  test's unasserted `totalSkipped`). Different site, no conflict; do not fold the two together.
- Do **not** unref the stabilization timer in `src/service/fret-service.ts` to make this go away.
  A ref'd timer is correct for a running service — a leaked service in production is a real leak,
  and unref'ing would hide it there too.
- Full-suite validation takes ~4 minutes plus a 10s grace; run it in the foreground with no
  redirection so the runner's idle timer keeps ticking.

## TODO

- Fix the cleanup in `test/proactive-announce.spec.ts`'s "peer disconnect triggers proactive
  announcement to remaining neighbors" so `services[2]` is stopped after the assertions; leave
  `nodes[2]` excluded (already stopped) and leave the abrupt-departure timing untouched.
- Run that file alone with no `--exit` and confirm 6 passing, exit 0, watchdog silent:
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/proactive-announce.spec.ts" --reporter dot`
- Remove `--exit` from the `test` script in `packages/fret/package.json`.
- Run the full suite (`yarn test` from `packages/fret`) and confirm it exits on its own with no
  watchdog output — that is the acceptance criterion for the whole ticket.
- Update the "Exit watchdog" bullet in `AGENTS.md`: `--exit` is gone, the watchdog is live, and
  the unresolved-leak sentence pointing at `tickets/` no longer applies.
- Add opt-in timer-origin capture to `test/mocha-exit-watchdog.ts` behind an env flag, default
  off, and note in that file what it costs when enabled. If you decide against it, leave a
  `NOTE:` at `describeStillOpen()` recording that the dump names only the resource *type* and
  that localizing a leak means a per-file sweep.
- `npx tsc --noEmit` from `packages/fret`.
