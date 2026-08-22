description: The libp2p wrapper around the core networking service forwards every call by hand, and nothing checks that those calls actually arrive with the right arguments in the right order — a swapped pair of numbers would go unnoticed.
files: packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/libp2p-facade-forwarding.spec.ts
difficulty: easy
---

<!-- resume-note -->
Fifth run stopped on BUDGET_WARNING, immediately after running mocha and diagnosing the one
failure. **Do not re-read `libp2p-fret-service.ts` or re-derive anything — the fix is known and
below.** `tsc --noEmit` has still never been run against the new file.

**File `test/libp2p-facade-forwarding.spec.ts` exists and 3 of 4 tests pass.** The 4th
("forwards every non-skipped method to the core with exact args, order, and return identity")
fails with:

```
TypeError: this.inner?.stop is not a function
 at Libp2pFretService.stop (file:///C:/projects/Fret/packages/fret/src/service/libp2p-fret-service.ts:124:27)
 at async Context.<anonymous> (test\libp2p-facade-forwarding.spec.ts:93:4)
```

**Root cause**: the test builds `mockCore` only for the enumerated (non-skip-listed) forwarding
methods — `stop` is in `SKIP_LIST` on purpose (it does discovery-loop teardown around the core
call, not a plain forward), so `mockCore` never gets a `stop` spy. The test's `finally` block then
calls `await svc.stop()`, and the real `Libp2pFretService.stop()` body does
`this.inner?.stop()` — `inner` is the mock object (truthy, so `?.` does not guard), and calling a
property that doesn't exist on it throws. This is a test-file bug, not a bug in
`libp2p-fret-service.ts` — the facade's `stop()` is correct; the mock is just incomplete.

**Fix (one line, in the test file only)**: add a no-op `stop` spy to `mockCore` before installing
it, e.g. right after the `for (const name of methods) { ... }` loop that populates `mockCore` and
before `coreOf(svc).inner = mockCore`:
```ts
mockCore.stop = () => {}
```
`stop` is deliberately not part of the `AnyFn`-returns-sentinel loop (it's skip-listed, has no
sentinel-return assertion), so a plain no-op is correct — nothing asserts on it, it only needs to
exist so the real facade's `stop()` can call it without throwing during the test's own cleanup.

**Verification commands (run both, in order, after applying the one-line fix)**:
```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/libp2p-facade-forwarding.spec.ts" --timeout 30000
cd packages/fret && npx tsc --noEmit
```
Expect 4/4 passing on the first command. If `tsc --noEmit` fails, check the new file's `coreOf`
cast helper — the rest of the package was type-clean before this ticket touched it.

If mocha still fails after the one-line fix, re-check whether `Libp2pFretService.stop()` also
calls anything else on `inner` beyond `.stop()` (read only that one method, not the whole file)
and give `mockCore` whatever else it needs the same way (a bare no-op, not a sentinel-asserting
spy, since `stop` is skip-listed and untested-by-design here).

**Once both commands are green**: write the review/ handoff (see AGENTS.md implement-stage rules)
summarizing the 4 test cases (skip-list-exists, exactly-20-forwarding-methods,
forward-with-mock-identity-and-order, not-injected-throws), note this is a new file (no
pre-existing coverage to compare against), and delete this ticket from implement/. Do not
re-derive the REJECTS/ASYNC_UNWRAP/ASYNC_GENERATOR classification or the skip list — both are
already correct and unchanged (3 of 4 tests already prove this: skip-list and enumeration tests
pass, and the not-injected-throws property — which exercises every method's REJECTS/throw
classification — also passes).

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
