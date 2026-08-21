description: Cleaned up the libp2p wrapper around the core FRET service — removed two duplicate methods, added the six missing pass-throughs, and retied the wrapper to the full service interface so a future missing method becomes a compile error instead of going unnoticed.
files: packages/fret/src/service/libp2p-fret-service.ts, packages/fret/src/index.ts, docs/fret.md
---
`Libp2pFretService` is a thin facade over the core `FretService`. It now re-exposes that
interface in full, and is tied to it by `implements Startable, FretService` rather than by a
hand-maintained key list.

## What the implement stage delivered

- **Removed two duplicate methods.** `getNeighborsForKey` and `assembleCohortForKey` were
  exact-body duplicates of `getNeighbors` / `assembleCohort` under different names, with no call
  sites anywhere in the package. Deleted.
- **Widened the facade.** Added pass-throughs for the six `FretService` members that had no
  wrapper equivalent: `reportNetworkSize`, `getNetworkSizeEstimate`, `getNetworkChurn`,
  `detectPartition`, `setActivityHandler`, `iterativeLookup`. Each routes through the existing
  `ensure()` guard; `iterativeLookup` returns the core's generator object directly, so iterating
  the wrapper's return value drives the same generator.

## Review findings

### Fixed in this pass

- **The type tie did not cover the drift class this ticket exists for.** The facade was declared
  `implements Startable, Pick<FretService, …>` over an explicit list of member names, and its own
  doc comment claimed that tie prevents the two surfaces drifting. It only prevents *one* of the
  two drift directions. A named key list does flag a **signature** on a listed member that no
  longer matches the interface — the case the comment cites, the `Record<string, any>` metadata
  regression. But `Pick` over an explicit list never asks whether the list is complete, so it
  keeps compiling when `FretService` **grows a member**. Verified rather than assumed: a
  three-member interface with a two-key `Pick` compiles clean under `--strict`.

  That blind spot *is* how this ticket's own bug happened — six interface members sat unreachable
  through the wrapper with the "structural tie" in place the whole time. The implement stage fixed
  the six instances and left the mechanism that permitted them, explicitly declining the switch as
  "not worth the diff churn" on the grounds that a now-total `Pick` and the interface are
  equivalent. They are equivalent as *types*; they are not equivalent as *guards*, and the guard
  is the reason the alias exists.

  Since the `Pick` had become total, the switch was free: deleted the `FretServiceFacade` alias and
  declared `implements Startable, FretService`. Adding a member to `FretService` is now a compile
  error at the wrapper. Rewrote the class doc comment, which previously argued for the weaker
  mechanism, to state which direction each form catches and why the interface is used.

- **`setMode` had a second, smaller instance of the same hole.** The wrapper declared
  `setMode(mode: 'active' | 'passive')` while the interface declares `setMode(mode: FretMode)`.
  Identical today, but TypeScript method parameters are bivariant even under
  `strictFunctionTypes`, so the inlined union would keep compiling if `FretMode` ever gained a
  third mode — the wrapper would then silently under-declare what it accepts. Changed to
  `FretMode`.

- **The design document described the superseded mechanism.** `docs/fret.md` stated the facade
  re-exposes a "**subset**" of the surface and that widening it "means naming the method in that
  `Pick`". Both halves were wrong after this ticket even before the change above. Rewritten to
  describe the full-interface tie and to record which drift direction each form catches, so the
  reasoning survives the next person who wonders why it is not a `Pick`.

### Filed as a ticket

- **Nothing verifies that the pass-throughs actually forward their arguments.** The compiler now
  guarantees the surface is complete and every signature matches, but a body that forwarded its
  arguments in the wrong order would type-check. `reportNetworkSize(estimate: number,
  confidence: number, source?)` is the live instance: two adjacent numbers, and a swap would feed
  the size estimator a confidence value as a population count with nothing to catch it. Filed as
  `backlog/debt-libp2p-facade-forwarding-untested` — deliberately scoped as *one table-driven test
  that enumerates the wrapper's prototype*, so a pass-through added later is covered without
  editing the test, rather than 21 point tests that would themselves drift. Not fixed inline
  because the run had crossed its token budget by the time it was identified. Checked first that
  no open ticket already claims this file for this concern (`backlog/impl/5-message-signatures`
  lists it, but for message signing).

### Noticed and deliberately left

- **The network-size-estimate return shape is spelled out three times** — inline as
  `{ size_estimate: number; confidence: number; sources: number }` in `src/index.ts`, in the core
  class, and now (added by this diff) in the wrapper. Extracting a named exported type is the DRY
  fix and is mechanical, but it touches the public type surface and so wants a full test run to
  land honestly; under the budget warning that was worse value than leaving three copies of a
  three-field shape that the compiler already keeps in agreement. Recorded here rather than filed:
  the cost of the duplication is readability, not correctness, and the `implements` clause above
  means a divergence between the copies is a compile error.

### Checked and clean

- **Dead references from the deletions.** Grepped the whole repository (sources, tests, docs) for
  `getNeighborsForKey` and `assembleCohortForKey`: no occurrence outside the ticket text itself.
  The design document does not name either method.
- **`iterativeLookup` transparency.** The wrapper returns the core generator object directly with
  no `await` and no wrapping, so iterating the wrapper's result drives the same generator. The core
  method is an `async *` generator function, so calling it returns the generator without running
  the body, and the wrapper's `ensure()` throw therefore surfaces synchronously at the call site —
  where a caller's `try` around a `for await` still catches it.
- **Pre-injection behavior.** All six new pass-throughs go through `ensure()`, matching every
  pre-existing pass-through, so no new pre-injection edge case was introduced. (That this holds is
  currently unverified by any test — folded into the filed ticket above as a second property.)
- **Source hygiene.** The wrapper is 216 lines (`wc -l`), every method is a single forwarding
  statement, and the only prose is the class doc comment. Nothing here needs splitting.

### Not applicable

- No error-handling, resource-cleanup, or performance findings: the diff adds no `try`/`catch`, no
  stream or timer ownership, and no loop. Every added method is a single synchronous forward.

## Validation

- `npx tsc --noEmit` from `packages/fret/` — clean.
- `yarn build` from `packages/fret/` — clean, exit 0.
- The implement stage ran the full suite (`yarn test`, 1138 passing / 0 failing) against the code
  as it stood before this review. **The review's own changes were not re-run against that suite,
  by deliberate choice**: deleting a type alias, changing an `implements` clause, and swapping a
  parameter's type for its own alias are all erased at compile time, so the emitted JavaScript is
  unchanged and no runtime test can observe the difference. `tsc --noEmit` and `yarn build` are the
  checks that *can* observe it, and both pass. Stating this plainly because "type-only" is a claim
  a reader should be able to weigh rather than take on faith.

No pre-existing test failures were encountered.
