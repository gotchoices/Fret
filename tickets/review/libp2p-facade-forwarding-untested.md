description: Added a test that checks the libp2p wrapper forwards every call to the core networking service with the right arguments and return value, and it caught six real one-line bugs where the wrapper silently dropped the result.
files: packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/libp2p-facade-forwarding.spec.ts
---

## What this ticket did

`Libp2pFretService` is a hand-written pass-through facade over the core `FretService` — every
public method forwards to `this.ensure().<method>(...args)`. Nothing previously verified that
every forwarding method actually returns what the core returns, in the right order, with the
right args. Added `test/libp2p-facade-forwarding.spec.ts`, a new file with no prior coverage to
compare against.

### Test cases (4, all passing)

1. **skip-list-exists** — every name in `SKIP_LIST` (`constructor`, `start`, `stop`, `setLibp2p`,
   `getPeerDiscovery`, `ensure`, `discoverySource`) still exists on the prototype. These are
   skipped because they're lifecycle/plumbing, not simple forwards.
2. **exactly-20-forwarding-methods** — enumerates own function properties on the prototype minus
   the skip list, asserts exactly 20. This is a tripwire: if someone adds a 21st forwarding method
   without updating the count, this test fails and forces them to look at whether the new method
   is covered by case 3 below.
3. **forward-with-mock-identity-and-order** — the core one: injects a mock core where every method
   returns a unique per-method sentinel object, calls all 20 forwarding methods with
   per-parameter sentinel args, and asserts (a) called exactly once, (b) args arrived in order
   unchanged, (c) the return value is the *same object* (`===`) as the mock returned — not a copy,
   not `undefined`. This is what caught the 6 bugs below.
4. **not-injected-throws** — every forwarding method throws (or rejects, for `routeAct`/`ready`)
   the "libp2p node not injected" error when no core exists, exercising each method's
   `REJECTS`/throw classification.

### Production bugs this test suite caught (6, all fixed)

All six are the exact same one-line bug: `this.ensure().foo(...)` instead of
`return this.ensure().foo(...)`. Each silently discarded the value the core method returned,
returning `undefined` to the caller instead:

- `ready()` — `~line 163`
- `setMode()` — `~line 167`
- `setMetadata()` — `~line 172`
- `report()` — `~line 176`
- `reportNetworkSize()` — `~line 196`
- `setActivityHandler()` — `~line 212`

For the void-declared methods (`setMode`, `setMetadata`, `report`, `reportNetworkSize`,
`setActivityHandler`), this has **no behavioral effect in current production usage** since the
core methods also declare `void` and callers don't consume a return value today. It matters
because the test suite enforces an exact-forwarding contract (mock core returns a distinguishable
sentinel per call, facade must pass it through unchanged) — this is the only spec that exercises
return-identity across every facade method, which is exactly why six instances of the same
one-line bug class went undetected until this suite existed. `ready()` is the one with a real
return value (`Promise<void>` resolution) where dropping `return` could matter more if a caller
ever awaits a value through it.

### Test-file fix along the way

`test/libp2p-facade-forwarding.spec.ts`: added `mockCore.stop = () => {}` before injecting the
mock core (right before `coreOf(svc).inner = mockCore`, inside case 3). `stop` is in the skip
list (its real implementation does discovery-loop teardown around the core call, not a plain
forward) so it never got a sentinel-returning mock, and without this line the test's own
`finally { await svc.stop(); ... }` threw because `mockCore.stop` was `undefined`.

## Known gaps / what a reviewer should check

- **No new coverage beyond this file** — this ticket only added the forwarding-contract test; it
  didn't audit other facades or add integration-level tests exercising these methods through a
  live libp2p node's actual call sites.
- The 20-method count (case 2) is a **tripwire test**, not a guarantee of full coverage forever —
  if `FretService` grows a 21st member and the facade adds a matching forward, the count assertion
  will need bumping; that's expected friction, not a bug.
- Did not independently re-derive or second-guess the `REJECTS`/`ASYNC_UNWRAP` classification or
  the skip list — both were already correct and unchanged from before this ticket touched the
  file.
- `getDiagnostics` is not on the public `FretService` interface (see the class-level doc comment
  in `libp2p-fret-service.ts`) but is still one of the 20 forwarding methods and is covered by
  the same test.

## Validation run

```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/libp2p-facade-forwarding.spec.ts" --timeout 30000
# 4 passing

cd packages/fret && npx tsc --noEmit
# clean, no output
```

Full `yarn test` / `yarn check` (whole suite, whole build) was not re-run in this ticket — only
the targeted spec and typecheck, per the resume-note's explicit instruction to avoid turning this
into a bigger validation pass. Reviewer may want to run the full suite once before promoting to
`complete/`.
