description: Finish the code-review pass on the new test that checks the libp2p wrapper forwards every call to the core networking service correctly — most of the review is done, but the full build-and-test gate still needs to be run before this can be called finished.
files: packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/libp2p-facade-forwarding.spec.ts, docs/fret.md
difficulty: easy
---

## Why this ticket exists

This replaces the original `review/libp2p-facade-forwarding-untested` ticket. The review pass ran
out of its token budget partway through: the reading and analysis are done and two fixes landed,
but the mandatory validation run (whole test suite) never happened, so the work cannot be promoted
to `complete/` yet. Everything below is the finished part; the *Remaining work* section is what is
left.

## What the implement stage actually did

Commits `be0b745..f68396a`, all titled `ticket(implement): libp2p-facade-forwarding-untested`.
Two files of substance:

- `packages/fret/test/libp2p-facade-forwarding.spec.ts` — new file, 4 cases, no prior coverage.
- `packages/fret/src/service/libp2p-fret-service.ts` — six one-line changes, each adding `return`
  in front of a `this.ensure().<method>(...)` call.

## Review findings so far

### Checked and sound — the test design

Read line by line against the facade it covers. These all hold:

- **It detects a member wired to the wrong core method.** The mock records the name it was
  registered under and the assertion compares it against the facade method being driven, so
  `getNeighbors` forwarding to `core.assembleCohort` fails rather than passing quietly.
- **Argument order and count are genuinely covered.** Sentinel arguments are generated from
  `fn.length`; TypeScript optional parameters (`exclude?`, `source?`) compile to plain parameters
  with no default, so they are counted and do receive sentinels. No member is silently driven with
  fewer arguments than it declares.
- **Getters are correctly excluded.** The enumeration filters on a property descriptor's `value`
  being a function, so the three accessors (`Symbol.toStringTag`, `peerDiscoverySymbol`, the
  private `node`) are skipped without being invoked — which matters, because reading `node` off
  the bare prototype dereferences an undefined field and throws. The reason is already commented
  at the site.
- **The sync-throws / async-rejects split is right.** `routeAct` and `ready` carry `async` ahead of
  the `ensure()` call so a missing node surfaces as a rejection; every other member — including
  `importTable`, which forwards a promise but is not itself `async` — throws synchronously. The
  spec's `REJECTS` set matches the source exactly.
- **The skip list is justified.** All seven entries are lifecycle or plumbing rather than plain
  forwards, and a separate case asserts each still exists, so a rename cannot silently empty the
  list.

### Found and fixed in this pass

- **The claim that six production bugs were caught does not hold up, and the ticket led with it.**
  The original ticket's `description:` said the test "caught six real one-line bugs where the
  wrapper silently dropped the result". Not one of the six changes anything a caller can observe.
  Five of them (`setMode`, `setMetadata`, `report`, `reportNetworkSize`, `setActivityHandler`) are
  declared to return nothing in *both* the facade and the core, so returning the core's result and
  discarding it are the same thing at runtime. The sixth, `ready`, sits inside an `async` function,
  where `await x;` and `return x;` both produce a promise resolving to the same value — again no
  difference, since the core's `ready` resolves to nothing. The difference only exists against the
  test's own mock, which returns a distinguishable object from methods the real core returns
  nothing from.

  This does **not** make the change wrong — one uniform exact-forwarding rule across all twenty
  members is better than a per-method judgement about which returns are worth checking, and it is
  the rule that gives the other fourteen members real coverage. It makes the *write-up* wrong, and
  a write-up that overstates what a test caught is how the next person mis-weighs the test. The
  handoff below states it accurately; the `complete/` ticket must too.

- **The `return` on the nothing-returning members was an unmarked trap.** Because it is invisible
  in production, a later reader tidying up "a `return` on a method that returns nothing" would
  delete it and get an unexplained `<method> return identity` failure from a spec that never names
  the facade in its own filename. Added a `NOTE:` above `ready()` in
  `packages/fret/src/service/libp2p-fret-service.ts` naming the six members, the spec, and the
  exact failure message.

- **The design document did not know the test existed.** `docs/fret.md`'s libp2p-integration
  section explains at length why the facade `implements FretService` rather than a `Pick`, but
  named no test — while citing a pinning spec is that document's habit everywhere else. Added a
  bullet stating what the spec pins, what the type system already covers without it (a *forgotten*
  member), and what only the spec can see (a member wired to the wrong core method, or one that
  drops what the core returned).

### Noticed, deliberately not filed

- **The count-of-twenty case is a tripwire, not a coverage guarantee** — already stated honestly in
  the implement handoff, and correct as written. A twenty-first member forces someone to look; it
  does not prove the new member is exercised. No ticket: the compile-time `implements FretService`
  clause is the real guard against a missing member, and this is the intended friction on top.

## Remaining work

- **Run the full gate and make it pass**: `yarn check` from the repo root (typecheck + build +
  test). The implement stage ran only the one new spec plus `tsc --noEmit`, deliberately, and
  neither this pass nor that one has run the whole suite. This is the blocking item — the review
  stage may not promote without it. Note the two edits this pass made are a comment and a
  documentation bullet, so neither can change behavior; a failure is either pre-existing or from
  the implement diff.
- **One remaining question worth a single look while the suite runs**: case 3 calls
  `svc.setMode('passive')` to force the facade to build a *real* core, then overwrites the private
  field with the mock — so that real core is never stopped, and the mock's `stop` is a no-op. Check
  whether `FretService.setMode` arms anything on a core that was never started. The targeted run
  passing is moderate evidence that it does not (`.mocharc.json` loads an exit watchdog that fails
  the run on a live handle 10s after the last test), but it was not confirmed by reading
  `setMode`'s body. If it does arm a timer, the fix is to stop the real core before swapping, not
  to widen the watchdog.
- **Write the `complete/` ticket** with a `## Review findings` section built from the sections
  above, and delete this ticket. Carry the corrected account of the six changes into it verbatim —
  do not restore the "six real bugs" framing.
