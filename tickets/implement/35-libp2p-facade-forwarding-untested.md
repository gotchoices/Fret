description: The libp2p wrapper around the core networking service forwards every call by hand, and nothing checks that those calls actually arrive with the right arguments in the right order — a swapped pair of numbers would go unnoticed.
files: packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/libp2p-service-node-source.spec.ts, packages/fret/test/libp2p-facade-forwarding.spec.ts (new)
difficulty: easy
---
`Libp2pFretService` (`packages/fret/src/service/libp2p-fret-service.ts`) re-exposes all public
`FretService` members as hand-written one-line pass-throughs to a private core instance
(`this.inner`, built lazily by the private `ensure()`). `implements Startable, FretService` gives
compiler proof the surface is complete and every signature matches. What no check covers is
whether each body forwards **the arguments it was given, unchanged and in order**, and returns
what the core returned.

Not hypothetical for one shape: `reportNetworkSize(estimate: number, confidence: number,
source?: string)` takes two adjacent numbers; a body that forwarded them swapped would
type-check perfectly and silently feed the size estimator a confidence value as a population
count. The existing wrapper spec (`test/libp2p-service-node-source.spec.ts`) only covers where
the node reference comes from (component vs `setLibp2p` injection vs neither) — it never
inspects call forwarding.

## Design (resolved)

New file `test/libp2p-facade-forwarding.spec.ts`, one table-driven test, not 21 hand-written ones:

1. Construct `new Libp2pFretService({ libp2p: node }, { profile: 'core', k: 7 })` with a node from
   `createMemNode()` (helper already in `test/helpers/libp2p.ts`), then force the private core to
   build by calling `svc.setMode('passive')` (or any cheap real pass-through) once — or simply
   invoke the private `ensure()` via the same cast used below. Either way, one narrow named cast
   helper reaches the private field:
   ```ts
   function coreOf(svc: Libp2pFretService): { inner: unknown } {
     return svc as unknown as { inner: unknown }
   }
   ```
2. Replace `coreOf(svc).inner` with a hand-built mock object implementing the `FretService`
   surface: every method is a small spy that records `(name, args)` into a shared array and
   returns a distinct sentinel object (`{ __sentinel: methodName }`) so return-by-identity is
   checkable with `.to.equal(...)`, not `.to.deep.equal(...)`.
3. Enumerate the wrapper's own prototype methods at runtime:
   `Object.getOwnPropertyNames(Libp2pFretService.prototype)` filtered to
   `typeof proto[name] === 'function'` (this naturally excludes the two `get` accessors —
   `[Symbol.toStringTag]` and `[peerDiscoverySymbol]` — since their property descriptor has no
   plain `value`).
4. Skip list (methods deliberately not plain forwards to a same-named core method — read off the
   current source, so a maintainer adding a new one must touch this list, which is the property
   the ticket wants):
   - `constructor` (not a method call)
   - `start`, `stop` — do extra discovery-loop work around the core call
   - `setLibp2p` — sets `nodeRef` only, never touches `inner`/core
   - `getPeerDiscovery` — returns `this.discovery`, not a core forward
   - `ensure`, `discoverySource` — private helpers; `ensure()` is what *builds* `inner`, and
     `discoverySource` has no same-named core counterpart at all
5. For every remaining method name: call it on `svc` with a fresh set of distinct sentinel
   arguments (one sentinel per parameter position — plain objects/strings/numbers that are easy
   to tell apart, e.g. `{__arg: 0}, {__arg: 1}, ...`), then assert:
   - the mock's same-named method was called exactly once
   - with exactly those sentinels, in that order (`.to.deep.equal` on the args array is fine here
     — argument *identity* doesn't need proving, only order/completeness; it's the *return value*
     identity that must not be cloned)
   - the wrapper's return value is `.to.equal` (identity) the mock's return sentinel — covers both
     sync returns and `Promise`-returning methods (`await` both sides)
6. Second property, same rig: before installing the mock (i.e. with `inner` still `null` and no
   node ever supplied — construct a second `svc2 = new Libp2pFretService({})` for this part, no
   `setLibp2p`), call each non-skipped method and assert it rejects/throws matching
   `/libp2p node not injected/` — proving every pass-through actually funnels through `ensure()`'s
   guard. Async methods: assert on the rejected promise; sync methods: assert on the thrown call.

Reaching into `svc.inner` uses the one named cast helper (`coreOf`) above — not sprinkled `any`.

## Edge cases & interactions

- **Sync vs async methods differ in call shape.** `routeAct`, `ready`, `importTable`,
  `iterativeLookup` (async generator, not a plain `Promise`) need different invocation/assertion
  handling than the sync majority. `iterativeLookup` returns an `AsyncGenerator` object directly
  (not awaited) — the identity check is on the generator object itself, not on anything it later
  yields; do not iterate it.
- **Optional trailing parameters must still be exercised.** `reportNetworkSize(estimate,
  confidence, source?)`, `getNeighbors`/`assembleCohort`/`expandCohort` (optional `exclude`) —
  call once with the optional argument present (this is the case that would catch a swap) since
  the whole point of this ticket is catching a swapped/misordered argument list.
- **Getter properties are not methods and must not appear in the enumerated list** —
  `[Symbol.toStringTag]` and `[peerDiscoverySymbol]`. Confirm the enumeration filter actually
  excludes them (assert the generated method-name list's length/contents once, so a future
  reader sees the filter is doing real work, not just trusting it silently).
- **The skip list itself should be asserted against the live prototype**, not just trusted: e.g.
  assert every skip-listed name actually exists on the prototype (catches a rename left stale in
  the test) and that the remaining (enumerated − skipped) set is non-empty and matches the known
  21-ish member count roughly, so a future interface member that should be forwarded doesn't
  silently fall into an ever-growing skip list unnoticed.
- **`getDiagnostics`** is not on the public `FretService` interface but *is* a real wrapper
  method calling `this.ensure().getDiagnostics()` — it must NOT be skip-listed; it's exactly the
  kind of member the plain-forward test should cover, and the mock object needs a
  `getDiagnostics` spy too even though it's typed via `ReturnType<CoreFretService[...]>` rather
  than the `FretService` interface.
- **Mock installation must happen after `ensure()` has run once**, otherwise the first
  non-`ensure`-triggering call under test would go through the *real* `ensure()` logic and throw
  or construct a second real core. Simplest path: call `svc.setMode('passive')` (or any single
  harmless real pass-through) once before swapping `inner`, to force construction, then swap.
- **Two separate `Libp2pFretService` instances needed** — one with a node (for the
  forwarding-with-mock property) and one with no node at all (for the not-injected-throws
  property) — don't try to reuse one instance across both, since once `inner` is set/mocked the
  not-injected guard can no longer be exercised on it.

## TODO

- Write `test/libp2p-facade-forwarding.spec.ts` per the design above
- Enumerate prototype methods at runtime; assert the skip list against the live prototype
- Build the mock core (spy + sentinel-return per method) and the one named cast helper (`coreOf`)
- Cover sync, async (`Promise`), and async-generator (`iterativeLookup`) return shapes
- Exercise optional trailing parameters at least once each (`reportNetworkSize` source arg,
  `exclude` sets)
- Add the not-injected-throws property against a second, un-injected instance
- Run `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/libp2p-facade-forwarding.spec.ts" --timeout 30000` and `npx tsc --noEmit`
