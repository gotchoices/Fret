----
description: After the whole test suite has finished and reported every test as passing, the test process sometimes never exits — so an automated run looks like it hung rather than succeeded, and has to be killed by hand.
files: packages/fret/test, packages/fret/package.json
difficulty: medium
repro: verified
----

## Observed behavior

Running the full suite from `packages/fret/` prints its normal summary line — every test
passing — and then the Node process stays alive indefinitely instead of exiting.

Observations recorded while investigating an unrelated flake:

- Three occurrences. Once under artificial load (24 CPU-busy processes on a 24-core machine):
  `438 passing (6m)`, then alive roughly 90 minutes until killed by hand. Twice on an idle
  machine: `438 passing (4m)`, then alive 30+ minutes.
- One other idle run exited cleanly with code 0 at about 5 minutes. So it is **intermittent,
  and not load-specific** — load was the first suspicion and it does not hold up.
- Every test passes before the hang. Nothing fails, nothing times out, no error is printed.

## Why it matters

An automated run that never exits is indistinguishable from a hung build. A continuous-
integration job would sit until its own wall-clock limit expired and then report failure, on a
suite where every single test actually passed. It also means nobody can trust an unattended
run of `yarn check`.

## What this is (and is not)

This is not a failing test. All work completes; something the process opened is still holding
the event loop open afterwards — a timer, a socket, or a background loop whose teardown was
skipped or raced. Passing `--exit` to the test runner would hide it, which is the wrong move:
the leak is real and would keep leaking in any long-lived embedding of this library, not only
in tests.

## Expected behavior

The suite exits on its own within a few seconds of the last test, on every run, without the
runner being told to force-exit.

## Context for whoever picks this up

- The whole suite runs in a single Node process, so a handle leaked by any one spec file keeps
  every later one's process alive.
- 106 service instances are constructed across 22 spec files in `packages/fret/test`. Several
  specs build a service and never shut it down. Whether an un-shut-down service actually holds
  a handle depends on whether it was ever started — worth establishing first rather than
  assuming.
- Naming the specific handle is the first job; guessing at teardown is not. Mocha's own
  leak reporting, or a handle-dumping tool run at process end, will name it directly.
- Once named, the fix is likely in the `finally`-block teardown of whichever specs own it.

Recorded during the investigation of `dialability-spec-self-position-premise`; that ticket
covers a genuine test failure and is unrelated to this hang.
