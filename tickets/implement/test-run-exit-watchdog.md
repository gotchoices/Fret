----
description: When the test suite finishes but the process refuses to quit, the run looks identical to a hung build and someone has to kill it by hand. Make that situation end the run with a clear failure that names whatever is still holding the process open, instead of waiting forever.
files: packages/fret/package.json, packages/fret/test/, AGENTS.md
difficulty: easy
repro: verified
----

## What the investigation actually found

The originating ticket assumed the suite leaks something (a timer, a socket) that keeps Node
alive after the last test, and that the runner would need to be told to force-quit. **Both halves
of that premise are wrong at HEAD, and the measurements are below.** Read this section before
writing any teardown code — the work this ticket asks for is different from what the bug report
assumed.

### 1. The suite is already told to force-quit

`packages/fret/package.json` has carried `--exit` on the test script since commit `f704322`,
well before the hangs were observed:

```
"test": "node --import ./register.mjs node_modules/mocha/bin/mocha.js \"test/**/*.spec.ts\" --colors --exit"
```

So a handle left open by a spec **cannot** be what kept those runs alive. `--exit` makes Mocha
call `process.exit()` as soon as it is finished, regardless of what the tests left running.

### 2. The suite leaks nothing anyway

Three full instrumented runs (a temporary Mocha root hook that dumped
`process.getActiveResourcesInfo()`, `process._getActiveHandles()` and
`process._getActiveRequests()` at the moment the last test finished). Every run, identically:

```
[at run end] activeResources: PipeWrapx2 Timeoutx1
[at run end] handles: Socketx2
[at run end] requests:
```

`PipeWrap`/`Socket` ×2 are the process's own stdout and stderr; the single `Timeout` was the
diagnostic's own unreferenced watchdog. **Nothing else was open.** The suite would exit on its
own with `--exit` removed.

Runs: 488 passing in ~4 min each, all three exited normally (exit code 0), with the patched
`process.exit` confirming Mocha reached it 1–4 ms after the last test. Run 1 direct via node,
run 2 direct via node with the dot reporter, run 3 through `yarn test` (so Yarn's own process was
in the tree). Logs: `tickets/.logs/mocha-hang-repro-2.log`, `-3.log`.

Also checked: no stranded test process was still running on the machine. (There are ~110 stray
`node` processes, but every one is an editor language server, an MCP server or a long-running dev
server for another project — none is a Mocha run.)

### 3. What is left, and why it cannot be pinned down from here

Three of four runs hung for the original reporter; three of three exited cleanly here. The
difference is environment, not code, and the two are not separable after the fact — which is the
real problem this ticket fixes.

The one code path that can wait indefinitely *after* the summary has printed is Mocha's own
force-quit helper, `exitMocha` in `node_modules/mocha/lib/cli/run-helpers.js`. It does not call
`process.exit()` directly; it first submits an empty write to **both** stdout and stderr and waits
for **both** completion callbacks:

```js
const done = () => { if (!draining--) { process.exit(clampedCode) } }
streams.forEach(stream => { draining += 1; stream.write('', done) })
done()
```

That flush is a workaround for an old Windows pipe bug. If either callback never fires — the
consumer on the other end of the pipe stopped reading, say — `process.exit()` is never reached and
the process sits there with an empty event loop, no CPU use, and the full summary already printed.
That is exactly the reported symptom, and it is a path that **only exists because of `--exit`**.
Without that flag Mocha uses `exitMochaLater`, which only sets `process.exitCode` and lets the
process end naturally.

This is a hypothesis, not a confirmed cause: it was not reproduced here, and no measurement pins
it. It is recorded because it is the only mechanism found that is consistent with every reported
observation (summary printed, process alive, no CPU, load-independent).

## What to build

One change of stance at one site — how the suite is invoked — with two halves that only make
sense together:

**Drop `--exit`.** Given measurement 2, it is buying nothing today: there is no handle for it to
paper over. It is costing two things — it hides any leak a future spec introduces, and it is the
only reason the indefinite-flush path above is reachable at all.

**Add a watchdog that makes a non-exiting run fail loudly.** Removing `--exit` without this would
trade one silent hang for another. The watchdog is an unreferenced timer armed when the run ends:
because it is unreferenced it cannot itself keep the process alive, so on a healthy run it never
fires and costs nothing. If the process is still alive after a grace period, it prints what is
still open and exits non-zero.

Sketch (this is close to the diagnostic that produced the measurements above; write it properly):

```js
// Output goes through fs.writeSync on purpose: if the stall is in the stream-flush
// path, anything routed through process.stdout.write() is invisible exactly when needed.
export const mochaHooks = {
  afterAll() { armWatchdog() }
}
```

- Grace period: 10 s is generous — nothing legitimate is pending once the last test has finished.
  Make it overridable by environment variable so a slow machine can widen it without a code edit.
- On firing: report the grace period that elapsed, then a tally of
  `process.getActiveResourcesInfo()` and of the constructor names from
  `process._getActiveHandles()` / `_getActiveRequests()`, then exit non-zero so the run fails.
- **Known limit, worth a `NOTE:` at the site:** an unreferenced timer only fires if the event loop
  is still turning. A process wedged by a synchronous infinite loop or a self-feeding microtask
  chain starves timers, and no in-process watchdog can catch that — only an external wall-clock
  limit can. The watchdog covers the leaked-handle and stalled-flush cases, not that one.

**Wire it so every invocation gets it, not just `yarn test`.** A `.mocharc.json` in
`packages/fret/` with a `require` entry is picked up automatically by both the full-suite script
and the single-spec command in `AGENTS.md`; a `--require` flag in `package.json` only covers the
former. Whichever is chosen, keep it out of the `test/**/*.spec.ts` glob so Mocha does not try to
run it as a spec.

## Expected behavior afterwards

- A healthy run exits on its own within a second of the last test, with no force-quit flag. (This
  is the measured behavior today — the change should not alter it.)
- A run that would previously hang forever instead fails within the grace period, naming the
  handles that held it open.
- If the flush hypothesis was right, that failure mode disappears outright rather than being
  detected.

## TODO

- Remove `--exit` from the `test` script in `packages/fret/package.json`.
- Add the watchdog module under `packages/fret/test/` (a name outside the `*.spec.ts` glob), using
  `fs.writeSync` for its output and an unreferenced timer armed from a root `afterAll` hook.
- Have it dump active resources / handles / requests and exit non-zero when it fires; make the
  grace period environment-overridable.
- Add the `NOTE:` at the watchdog site recording that a starved event loop is outside what it can
  catch.
- Wire it via `.mocharc.json` in `packages/fret/` so single-spec runs are covered too.
- Verify a clean full run still exits by itself, promptly, with the flag gone.
- Verify the watchdog actually fires: temporarily leak a referenced handle (a plain `setInterval`
  in a scratch spec), confirm the run fails within the grace period and names `Timeout`, then
  remove the scratch spec.
- Update the test-command row in `AGENTS.md` if the invocation changes shape.
