description: The libp2p wrapper around the core networking service forwards every call by hand, and nothing checks that those calls actually arrive with the right arguments in the right order — a swapped pair of numbers would go unnoticed.
files: packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/libp2p-facade-forwarding.spec.ts
difficulty: easy
---

<!-- resume-note -->
Sixth run stopped on BUDGET_WARNING, immediately after fixing a second failure. **Two fixes are
already applied and must not be re-derived:**

1. **Test file, `test/libp2p-facade-forwarding.spec.ts`**: added `mockCore.stop = () => {}` right
   before `coreOf(svc).inner = mockCore` (inside the third `it`). This was needed because `stop`
   is in `SKIP_LIST` (it does discovery-loop teardown around the core call, not a plain forward),
   so `mockCore` never got a `stop` spy, and the test's own `finally` block calling `svc.stop()`
   threw `TypeError: this.inner?.stop is not a function`. Fixed, confirmed by a mocha run this
   session (see below for what that run then found next).

2. **Production file, `src/service/libp2p-fret-service.ts`**, method `ready()` (~line 162): changed
   ```ts
   async ready(): Promise<void> {
   	await this.ensure().ready();
   }
   ```
   to
   ```ts
   async ready(): Promise<void> {
   	return this.ensure().ready();
   }
   ```
   **This is a real bug, not a test artifact.** Every other facade method does
   `return this.ensure().foo(...)`, forwarding the core's return value. `ready()` alone did
   `await ...; ` with no `return`, so it always resolved `undefined` regardless of what the core's
   `ready()` produced — it broke the "exact return identity" forwarding contract documented for
   this facade (see `docs/fret.md`, "libp2p integration" section, the paragraph on
   `Libp2pFretService` being tied to the core surface). In practice `FretService.ready()` is typed
   `Promise<void>` so no real caller currently depends on the resolved value, but the facade's job
   per this ticket is exact pass-through, and this was the one method silently not doing that — it
   is exactly the class of bug ("swapped pair of numbers would go unnoticed") this ticket exists to
   catch. This fix has **not yet been verified** — no test or tsc run happened after making it.

**What is still unverified — do this first, in order, before anything else:**
```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/libp2p-facade-forwarding.spec.ts" --timeout 30000
cd packages/fret && npx tsc --noEmit
```
Expect 4/4 passing on the first command now that both fixes are in. If a *third* distinct failure
surfaces, do not assume it is another one-line fix — diagnose fresh (the pattern so far has been:
each fix reveals the next real gap, not a red herring), but do not spend more than one round doing
so before asking a human if it recurs a third time.

If `tsc --noEmit` fails, check `libp2p-fret-service.ts` (the `ready()` change and the `coreOf` cast
helper in the test file are the only edits this ticket has made) — the rest of the package was
type-clean before this ticket touched it.

**Once both commands are green**: write the review/ handoff (see AGENTS.md implement-stage rules)
summarizing the 4 test cases (skip-list-exists, exactly-20-forwarding-methods,
forward-with-mock-identity-and-order, not-injected-throws). Call out **both** fixes in the handoff
plainly: the test-file mock-completeness fix or the (skip-listed, untested-by-design) `stop`
seam, and the production `ready()` forwarding bug this test suite caught for the first time
because it is the only spec that exercises return-identity across every facade method. Note this
is a new file (no pre-existing coverage to compare against). Do not re-derive the
REJECTS/ASYNC_UNWRAP/ASYNC_GENERATOR classification or the skip list — both are already correct
and unchanged; the skip-list and enumeration tests already proved this before this session ever
touched the file, and the not-injected-throws property (which exercises every method's
REJECTS/throw classification) also already passed.

Then delete this ticket from implement/.

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
