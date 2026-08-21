description: Cleaned up the libp2p wrapper around the core FRET service — removed two duplicate methods and added the six missing pass-through methods so the wrapper now exposes the full public FRET service surface.
files: packages/fret/src/service/libp2p-fret-service.ts, packages/fret/src/index.ts
---
Implemented both arms of `implement/22-libp2p-fret-service-cleanup.md` in
`packages/fret/src/service/libp2p-fret-service.ts`:

1. **Removed duplicate methods.** `getNeighborsForKey` and `assembleCohortForKey` deleted —
   both were exact-body duplicates of `getNeighbors` / `assembleCohort` under a different name.
   Grepped the whole `packages/fret` tree first: no call sites existed anywhere outside the
   wrapper file itself (not even in tests), so nothing needed repointing.

2. **Widened the facade.** Added hand-written pass-throughs for the six `FretService` members
   that had no wrapper equivalent: `reportNetworkSize`, `getNetworkSizeEstimate`,
   `getNetworkChurn`, `detectPartition`, `setActivityHandler`, `iterativeLookup`. Each routes
   through the existing `this.ensure()` guard, matching every other pass-through's style.
   `iterativeLookup` returns the generator object directly (no `await`, no wrapping), so
   iterating the wrapper's return value drives the same generator as calling the core service.
   Added `ActivityHandler`, `LookupOptions`, `RouteProgress` to the existing `import type { ... }
   from '../index.js'` line. Widened `FretServiceFacade`'s `Pick<FretService, …>` to include all
   six new names, so the structural tie (`implements Startable, FretServiceFacade`) now covers
   the whole public `FretService` interface.

   Did **not** do the small optional follow-up the ticket mentioned (swap
   `implements Startable, FretServiceFacade` for `implements Startable, FretService` directly
   and delete the now-total `Pick` alias) — left as-is since the `Pick` is now a straight alias
   for the full interface and either form is equivalent; not worth the diff churn.

## Validation performed

- `npx tsc --noEmit` from `packages/fret/` — clean, no errors. This is what would have caught a
  missing `ActivityHandler` / `LookupOptions` / `RouteProgress` import.
- `yarn build` from `packages/fret/` — clean.
- `yarn test` from `packages/fret/` — full suite, **1138 passing, 0 failing** (~3 min). Includes
  `test/peer-discovery.spec.ts` (unaffected by the dupe removal, since nothing there referenced
  the removed names) and the full RPC / stabilization / size-estimate suites.
- Confirmed via grep that no reference to `getNeighborsForKey` or `assembleCohortForKey` remains
  anywhere in the package after removal.

## Use cases for reviewer testing

- **Facade completeness**: any app holding only a `Libp2pFretService` instance (not the core
  `FretService`) can now reach network-size reporting, churn, partition detection, activity
  handling, and iterative lookup — previously unreachable through the wrapper.
- **`iterativeLookup` transparency**: worth a spot check that
  `for await (const p of wrapper.iterativeLookup(key, opts))` yields the same progression as
  calling the core service's `iterativeLookup` directly — I confirmed this by code inspection
  (direct `return`, no `await`/wrap) rather than adding a new generator-semantics test, per the
  ticket's own guidance that one already exists for the core generator.
- **Pre-injection behavior**: all six new pass-throughs share `ensure()`'s
  `"Libp2pFretService: libp2p node not injected"` throw when called before the node is
  available — same as every pre-existing pass-through, so no new pre-injection edge case was
  introduced.

## Known gaps / not covered

- No new unit test was added specifically for the six new pass-through methods (e.g. asserting
  each forwards its arguments and return value verbatim). They're trivial one-line forwards
  identical in shape to the eight pre-existing pass-throughs in the same file, which also have
  no dedicated pass-through tests — consistent with existing coverage, but flagging since the
  reviewer may want a cheap `libp2p-fret-service.spec.ts` covering the full facade surface in
  one pass if that gap matters going forward.
- Did not implement the optional cosmetic follow-up (switching to
  `implements Startable, FretService` and dropping the `Pick` alias) — noted above.
