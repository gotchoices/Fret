description: Added a test that checks the libp2p wrapper forwards every call to the core networking service correctly, and reviewed it — the test is sound, the write-up that oversold it was corrected, and the full build-and-test gate passes.
files: packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/libp2p-facade-forwarding.spec.ts, docs/fret.md
---

## What shipped

`Libp2pFretService` re-exposes the whole public `FretService` surface as hand-written
pass-throughs. `implements FretService` already makes a *forgotten* member a compile error; it
cannot see a member wired to the wrong core method, or one that calls the core and drops what it
returned. Nothing covered that until now.

- `packages/fret/test/libp2p-facade-forwarding.spec.ts` — new file, 4 cases. A mock core returns a
  distinct sentinel from every member; each facade method must be called exactly once, receive its
  arguments in order unchanged, and hand that same object (`===`) back. Companion cases assert the
  enumerated member count (so a member added later is not silently uncovered), that the seven
  skipped lifecycle/plumbing members still exist, and that every member surfaces the
  "libp2p node not injected" error when no node was supplied.
- `packages/fret/src/service/libp2p-fret-service.ts` — six one-line changes adding `return` in
  front of `this.ensure().<method>(...)`, so the exact-forwarding rule is uniform across all
  twenty members.
- `docs/fret.md` — the libp2p-integration section now names the spec and states what it pins.

## Review findings

### Checked and sound — the test design

Read line by line against the facade it covers:

- **Detects a member wired to the wrong core method.** The mock records the name it was registered
  under and the assertion compares it against the facade method being driven, so `getNeighbors`
  forwarding to `core.assembleCohort` fails rather than passing quietly.
- **Argument order and count genuinely covered.** Sentinel arguments are generated from `fn.length`;
  TypeScript optional parameters (`exclude?`, `source?`) compile to plain parameters with no
  default, so they are counted and do receive sentinels. No member is driven with fewer arguments
  than it declares.
- **Getters correctly excluded.** Enumeration filters on a property descriptor's `value` being a
  function, so the three accessors (`Symbol.toStringTag`, `peerDiscoverySymbol`, the private `node`)
  are skipped without being invoked — which matters, because reading `node` off the bare prototype
  dereferences an undefined field and throws. Reason already commented at the site.
- **The sync-throws / async-rejects split is right.** `routeAct` and `ready` carry `async` ahead of
  the `ensure()` call so a missing node surfaces as a rejection; every other member — including
  `importTable`, which forwards a promise but is not itself `async` — throws synchronously. The
  spec's `REJECTS` set matches the source exactly.
- **The skip list is justified.** All seven entries are lifecycle or plumbing rather than plain
  forwards, and a separate case asserts each still exists, so a rename cannot silently empty it.

### Found and fixed in this pass

- **The claim that six production bugs were caught does not hold up.** The implement handoff's
  `description:` said the test "caught six real one-line bugs where the wrapper silently dropped the
  result". Not one of the six changes anything a caller can observe. Five (`setMode`, `setMetadata`,
  `report`, `reportNetworkSize`, `setActivityHandler`) are declared to return nothing in *both* the
  facade and the core, so returning the core's result and discarding it are identical at runtime.
  The sixth, `ready`, sits inside an `async` function, where `await x;` and `return x;` both produce
  a promise resolving to the same value — again no difference, since the core's `ready` resolves to
  nothing. The difference exists only against the test's own mock, which returns a distinguishable
  object from methods the real core returns nothing from.

  This does **not** make the change wrong — one uniform exact-forwarding rule across all twenty
  members is better than a per-method judgement about which returns are worth checking, and it is
  the rule that gives the other fourteen members real coverage. It made the *write-up* wrong, and a
  write-up that overstates what a test caught is how the next person mis-weighs the test. Corrected
  here; the "six real bugs" framing is retired.

- **The `return` on the nothing-returning members was an unmarked trap.** Because it is invisible in
  production, a later reader tidying up "a `return` on a method that returns nothing" would delete
  it and get an unexplained `<method> return identity` failure from a spec that never names the
  facade in its own filename. Added a `NOTE:` above `ready()` in
  `packages/fret/src/service/libp2p-fret-service.ts` naming the six members, the spec, and the exact
  failure message.

- **The design document did not know the test existed.** `docs/fret.md`'s libp2p-integration section
  explains at length why the facade `implements FretService` rather than a `Pick`, but named no test
  — while citing a pinning spec is that document's habit everywhere else. Added a bullet stating
  what the spec pins, what the type system already covers without it (a *forgotten* member), and
  what only the spec can see (a member wired to the wrong core method, or one that drops what the
  core returned).

### Checked and cleared — the un-stopped real core in case 3

Case 3 calls `svc.setMode('passive')` to force the facade to build a *real* core, then overwrites
the private field with the mock, so that real core is never stopped. Read `setMode`'s body
(`fret-service.ts:1217`): it assigns `this.mode` and arms the active-preconnect loop **only** when
`mode === 'active'`. The spec passes `'passive'`, so nothing is armed and there is no live handle.
Corroborated by the run: `.mocharc.json` loads an exit watchdog that fails the run on a live handle
10 s after the last test, and the full suite exits clean. No change needed.

### Tripwires

None. The one conditional concern noticed — that the count-of-twenty case is a tripwire rather than
a coverage guarantee — is already stated honestly in the implement handoff and is correct as
written: a twenty-first member forces someone to look, it does not prove the new member is
exercised. The compile-time `implements FretService` clause is the real guard against a missing
member, and this case is the intended friction on top. Nothing further to park.

### Tickets filed

None. Nothing found rose above "fix inline" — the two fixes above are a comment and a documentation
bullet, and neither the test nor the six source edits has a defect behind it.

### Validation

`yarn check` from the repo root (typecheck + build + full test suite): **1232 passing, 0 failing**,
~5 min. No pre-existing failures surfaced.
