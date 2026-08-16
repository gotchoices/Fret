description: Added a safety net so that if the fret test suite's process refuses to quit after tests finish, the run fails loudly and names what's still open, instead of hanging forever and needing a human to kill it.
files: packages/fret/.mocharc.json, packages/fret/test/mocha-exit-watchdog.ts, packages/fret/test/mocha-exit-watchdog.spec.ts, packages/fret/test/fixtures/exit-watchdog-leak.fixture.ts, packages/fret/test/fixtures/exit-watchdog-clean.fixture.ts, AGENTS.md
----

## What shipped

- **`packages/fret/test/mocha-exit-watchdog.ts`** — Mocha root-hook plugin. Its `afterAll` arms an
  **unref'd** `setTimeout` (10s default, `FRET_TEST_EXIT_GRACE_MS` overrides). If the process is
  still alive when it fires, it writes `process.getActiveResourcesInfo()` (plus the
  `_getActiveHandles`/`_getActiveRequests` tally) to fd 2 with `fs.writeSync` — a raw fd write, so
  a stalled stream-flush is not invisible to the very diagnostic meant to catch it — then fails the
  run with a non-zero exit code.
- **`packages/fret/.mocharc.json`** — `{ "require": ["test/mocha-exit-watchdog.ts"] }`, so every
  mocha invocation from `packages/fret/` gets it, not only `yarn test`.
- **`packages/fret/test/mocha-exit-watchdog.spec.ts`** + two fixtures under `test/fixtures/`
  (added during review) — spawns real child mocha runs and asserts on their exit codes and stderr.
- **`AGENTS.md`** — the watchdog, the env override, and why `--exit` is still on the test script.

`--exit` was deliberately **not** removed from `packages/fret/package.json`, contrary to the
originating ticket: the implement stage reproduced a real, unresolved hang without it. That is
tracked in `tickets/fix/mocha-suite-real-exit-hang.md`, and its analysis stands unchanged after
this review — the leak-fixture experiment here reports the same `resources: Timeout` signature,
corroborating "some leaked, still-referenced timer".

## Review findings

### Major — fixed in this pass, not filed

- **The watchdog printed its diagnosis and then reported the run as passing.**
  `packages/fret/test/mocha-exit-watchdog.ts` ended with `process.exit(1)`, which is not enough
  and fails silently. Without `--exit`, Mocha finishes a run via `exitMochaLater`, which registers
  `process.on('exit', () => { process.exitCode = <test result> })`. That handler runs during the
  watchdog's own exit and stamps the passing code back over the failure. Measured directly: the
  leak fixture printed the full `[exit-watchdog] ... resources: Timeout` dump and still exited **0**.
  This defeated the ticket's entire purpose — "fails loudly" was in fact "prints, then succeeds" —
  and it is exactly the configuration the watchdog exists for, so nothing else would have caught it.
  The handoff's claim that it "exited non-zero" was not borne out.
  Fixed by `failExit()`: exit handlers fire in registration order, so registering ours after the
  run has ended (hence after Mocha's) makes it the last writer. Verified: exit code is now 1.
  Fixed inline rather than filed because it is a two-line change at one site in the very file
  under review, and the new spec now pins the behavior against a future Mocha change.

### Medium — fixed in this pass

- **No automated coverage at all** (a gap the handoff itself flagged). The watchdog is a
  process-lifetime guard, so it is unobservable from inside the suite it guards; the new
  `test/mocha-exit-watchdog.spec.ts` therefore spawns real child mocha processes over two fixtures
  and covers both directions: the leak fixture (ref'd `setInterval`) must exit **1**, print
  `[exit-watchdog]`, honour the 500ms env override, and name `Timeout` in its resources; the clean
  fixture must exit **0** with no watchdog output at all. The children inherit the shipped
  `.mocharc.json`, so the wiring is under test too, not just the module. This is what surfaced the
  major finding above — the exit-code assertion failed on the first run.
  Fixtures are named `*.fixture.ts` under `test/fixtures/`, outside the `test/**/*.spec.ts` glob,
  so the main suite never runs them directly. Cost: ~1.2s added to the suite.

### Minor — fixed in this pass

- The `NOTE:` about `_getActiveHandles`/`_getActiveRequests` sat above the `ProcessInternals`
  interface and said "getActiveResourcesInfo() **above**" when that call is 25 lines *below* it.
  Moved to the actual call site in `describeStillOpen` and reworded.
- `constructorName(null)` returned `'object'` (`typeof null`), which reads as a real handle in the
  dump. Now returns `'null'`.

### Documentation

- `AGENTS.md` described the test commands with no mention that a `.mocharc.json` now injects a
  module into every one of them, nor of `FRET_TEST_EXIT_GRACE_MS`. Added, along with the reason
  `--exit` is still on the `test` script (it force-quits before the watchdog can observe a leaked
  handle, so `yarn test` today is only guarded against the stalled-flush case).
- `docs/fret.md` deliberately **not** touched: it is the protocol/architecture document, and test
  harness invocation is AGENTS.md's subject. Its "Testing strategy" section describes what is
  tested, not how the runner exits.

### Considered and left alone

- **`--exit` retained.** Re-litigating it here would just reproduce the implement stage's finding;
  the root cause is already scoped in `tickets/fix/mocha-suite-real-exit-hang.md` with a bisection
  plan. Not bisected during review — each full-suite data point is ~4 minutes and the ticket
  already owns the work.
- **Event-loop starvation is out of the watchdog's reach** (a synchronous infinite loop or a
  self-feeding microtask chain starves the timer; only an external wall-clock limit catches that).
  Already recorded as a `NOTE:` at the module's export site — no new tripwire needed.

### Tripwires

None new. The two conditional concerns at this site (starved event loop, above; deprecated
`_getActive*` internals returning `[]` on Node 24) already carry `NOTE:` comments in
`mocha-exit-watchdog.ts`.

### No findings

- **Resource cleanup / leaks in the new code**: the watchdog's own timer is unref'd, so it cannot
  keep a healthy process alive — confirmed by the clean-fixture test exiting 0 on its own.
- **Type safety**: no `any`; the deprecated internals are reached through a narrow optional-method
  interface rather than a cast to `any`.
- **Source hygiene**: 78 lines, five single-purpose functions, comments explain *why* (raw fd
  write, unref'd timer, exit-handler ordering) rather than restating the code.

## Validation

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — **490 passing, 0 failing** (488 pre-existing + 2 new).
- Direct child run of the leak fixture with `FRET_TEST_EXIT_GRACE_MS=500`: prints the dump,
  `resources: Timeout`, exit code **1**.
- No lint step exists in this repo (`AGENTS.md`: `yarn check` is the gate; `yarn format` is
  documented as not runnable here).
- No pre-existing failures encountered.
