description: The libp2p wrapper around the core networking service forwards every call by hand, and nothing checks that those calls actually arrive with the right arguments in the right order — a swapped pair of numbers would go unnoticed.
files: packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/libp2p-facade-forwarding.spec.ts
difficulty: easy
---

<!-- resume-note -->
Seventh run stopped on BUDGET_WARNING, immediately after fixing a third failure. **Three fixes
are already applied and must not be re-derived:**

1. **Test file, `test/libp2p-facade-forwarding.spec.ts`**: `mockCore.stop = () => {}` added right
   before `coreOf(svc).inner = mockCore` (inside the third `it`). Needed because `stop` is
   skip-listed (does discovery-loop teardown around the core call, not a plain forward), so
   `mockCore` never got a `stop` spy and the test's own `finally` block calling `svc.stop()` threw.
   Confirmed working — this part of the test file is done.

2. **Production file, `src/service/libp2p-fret-service.ts`**, method `ready()` (~line 162):
   changed `await this.ensure().ready();` (no return) to `return this.ensure().ready();`. Real
   forwarding-contract bug — every other facade method does `return this.ensure().foo(...)`, this
   one silently dropped the resolved value. Not yet independently re-verified by a green test run
   (see below), but the diagnosis is solid and unchanged from prior sessions.

3. **Production file, same file**, method `setMode()` (~line 166): same bug, same fix. Was
   ```ts
   setMode(mode: FretMode): void {
   	this.ensure().setMode(mode);
   }
   ```
   now
   ```ts
   setMode(mode: FretMode): void {
   	return this.ensure().setMode(mode);
   }
   ```
   Found this session: after fix #2, a mocha run turned up `setMode return identity: expected
   undefined to equal { __sentinel: 'setMode' }` — same missing-`return` pattern, different
   method. `FretService.setMode` (core) is declared `void` and never returns anything in real
   usage, so this has no behavioral effect in production; it matters purely for the exact-forward
   contract this test suite enforces (mock core returns a sentinel object per call; facade must
   pass it through unchanged). **This fix has NOT been verified by any test or tsc run — do that
   first.**

**What is still unverified — do this first, in order, before anything else:**
```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/libp2p-facade-forwarding.spec.ts" --timeout 30000
cd packages/fret && npx tsc --noEmit
```
Expect 4/4 passing now that all three fixes are in. **If a fourth distinct failure surfaces**, the
pattern across this ticket's whole history has been: each fix reveals the next real forwarding gap
(`ready`, then `setMode`), always the same missing-`return` shape on a facade method. Given that
repeat pattern, if a 4th one appears it is very likely the same fix again (`this.ensure().foo(...)`
→ `return this.ensure().foo(...)`) — apply it directly rather than re-deriving from scratch, but do
not spend more than one extra round chasing a 5th before asking a human.

**Once both commands are green**, as a light sanity pass (not a full audit — do not turn this into
a bigger investigation), skim the ~20 forwarding methods in `libp2p-fret-service.ts` for the same
missing-`return` shape now that it's proven to be an easy-to-miss class, so the review stage isn't
the first place a fourth instance surfaces. This is a quick read, not a re-run of the test loop.

**Then write the review/ handoff** (see AGENTS.md implement-stage rules) summarizing the 4 test
cases (skip-list-exists, exactly-20-forwarding-methods, forward-with-mock-identity-and-order,
not-injected-throws). Call out **all three** fixes in the handoff plainly: the test-file
mock-completeness fix (`stop` seam), and the two production forwarding bugs this test suite caught
for the first time (`ready()` and `setMode()`) — it is the only spec that exercises return-identity
across every facade method, which is exactly why two separate instances of the same one-line bug
class turned up only once this suite existed. Note this is a new file (no pre-existing coverage to
compare against). Do not re-derive the REJECTS/ASYNC_UNWRAP/ASYNC_GENERATOR classification or the
skip list — both are already correct and unchanged; the skip-list and enumeration tests already
proved this before any session touched the file, and the not-injected-throws property (which
exercises every method's REJECTS/throw classification) also already passed.

Then delete this ticket from implement/.

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
