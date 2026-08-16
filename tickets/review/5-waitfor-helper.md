description: A shared test helper now waits for the actual condition instead of sleeping a fixed number of seconds, so slow-converging tests fail fast with a clear label instead of timing out opaquely, and fast-converging ones finish in milliseconds instead of seconds.
files: packages/fret/test/helpers/wait-for.ts, packages/fret/test/libp2p-memory.integration.spec.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/membership-identify.spec.ts
----
Code landed prior to this ticket file (commit `bc1bd6c ticket(plan): waitfor-helper`, on
`main`). This pass re-verified the landed state and hands it to review — no code changes made
here.

## What to review
- `packages/fret/test/helpers/wait-for.ts` — shared `waitFor(predicate, timeoutMs = 12000,
  stepMs = 25, label?)`. Polls every `stepMs`; **throws** (with `label` if given) on timeout
  rather than returning silently. Any future caller relying on "wait then check anyway" would
  need to explicitly catch — no current call site does.
- `libp2p-memory.integration.spec.ts` — fixed sleeps (previously up to 6s) replaced with
  `waitFor` on real convergence state (peer counts, neighbor-set population, snapshot exchange
  counts) via two local predicates, `allHaveMinPeers` / `allHaveNeighbors`. Explicit timeouts
  passed are 6000-10000ms (shorter than the 12000ms default) since these tests chain a wait with
  other setup work.
- `ring-membership.spec.ts` and `membership-identify.spec.ts` — each had a private duplicate
  `waitFor`; both deleted, both now import the shared helper. `ring-membership.spec.ts`'s own
  sleep→predicate conversion had already happened under an earlier ticket
  (`membership-classification-strength`); this pass's work here was purely de-duplication.

## Verification performed this pass
- `cd packages/fret && npx tsc --noEmit` — clean, no errors.
- `cd packages/fret && yarn test` (full suite) — **544/544 passing**, 0 failing, ~4 min wall
  clock. No pre-existing-failure entry needed.
- Spot-checked all three target files still import from `./helpers/wait-for.js` and no private
  `waitFor` remains (grepped `waitFor|import.*wait-for` across the three specs — only the shared
  import + call sites, one `// poll path... no waitFor` comment in membership-identify.spec.ts
  which is explanatory, not a duplicate implementation).

## Known gaps / things NOT covered by this ticket
- **Timeout budget headroom** was asserted by inspection, not measured under load: worst case in
  `ring-membership.spec.ts` chains 3 waits at the 12000ms default (3×12000 = 36000ms) against
  Mocha's 30000ms per-test timeout — the ticket claims this is fine because the individual waits
  resolve quickly in practice, but nobody has forced a slow-CI scenario to confirm the chain
  doesn't itself blow the Mocha timeout before any single `waitFor` does. Low risk (tests pass
  now, `waitFor` fails fast with a clear label rather than hanging) but not stress-tested.
- **`stepMs` default (25ms) polling overhead** — carried over from pre-existing patterns,
  never measured against CI timing sensitivity. Noted in the originating ticket as a caveat, not
  something this pass investigated.
- **Out-of-scope fixed sleeps remain** in other spec files, deliberately not touched (original
  ticket named only the three files above): `churn.leave.spec.ts`, `fret.mesh.spec.ts`,
  `iterative-lookup.spec.ts`, `maybeact-dedup-phases.spec.ts`, `network.isolation.spec.ts`,
  `payload-bounds-ttl.spec.ts`, `peer-discovery.spec.ts`, `proactive-announce.spec.ts`,
  `route.maybeact.integration.spec.ts`, `profile.behavior.spec.ts`, plus three sleeps still at
  the end of `ring-membership.spec.ts` itself: a 400ms discovery-emission wait, a
  deliberately-real 2×600ms spaced-failure test (tests real time-based backoff spacing, not a
  candidate for predicate-waiting), and a 2000ms single-node-startup wait. A future ticket could
  sweep these deliberately; this is a tripwire, not a defect — each of those sleeps was working
  and untouched at review time, filed here so a future reviewer doesn't need to rediscover the
  list.

## Suggested test/validation for reviewer
- Re-run `yarn test` from `packages/fret/` to confirm the 544/544 count independently.
- Spot-run just the three touched files to see the timing win directly:
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/ring-membership.spec.ts" "test/membership-identify.spec.ts" "test/libp2p-memory.integration.spec.ts" --timeout 30000`
  — the 10-node convergence case in `libp2p-memory.integration.spec.ts` that used to sleep 6s
  fixed now completes in ~141ms once real convergence is reached.
- Confirm no other spec file has a leftover private `waitFor` this ticket should have caught:
  `grep -rn "^function waitFor\|^const waitFor" packages/fret/test/*.spec.ts` (expect no hits
  outside the shared helper file).
