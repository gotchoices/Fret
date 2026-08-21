---
description: The libp2p wrapper around the core FRET service still has a duplicated pair of methods and an incomplete public surface — some capabilities of the underlying service (network-size reporting, churn, partition detection, activity handling, iterative lookup) are unreachable through the wrapper even though apps commonly go through it.
files: packages/fret/src/service/libp2p-fret-service.ts, packages/fret/src/index.ts (FretService interface, ~90-127)
difficulty: easy
---
Re-scoped from `plan/22-libp2p-fret-service-cleanup.md` after re-reading the current file
(`packages/fret/src/service/libp2p-fret-service.ts`) against the plan ticket's claims — two of
its four bullets are already fixed on `main`:

- **Already done, no action needed:**
  - Dead constructor wiring: the `node` getter (~74-76) already resolves
    `this.nodeRef ?? this.components.libp2p ?? null`, so a service registered the ordinary
    libp2p way (`services: { fret: fretService() }`) now works without the `setLibp2p` dance.
    `docs/fret.md`'s "libp2p integration" section already documents this as the settled design
    (injection wins because always-available; component is fallback). Landed as part of the
    `consolidate-discovery-emission` review pass.
  - `getDiagnostics` cast: already typed concretely as
    `ReturnType<CoreFretService['getDiagnostics']>` (~146-148), no `as any` anywhere in the file.
  - Interface-drift protection: the class already declares
    `implements Startable, FretServiceFacade`, where `FretServiceFacade = Pick<FretService, …>`
    (~19-25) — so the *currently listed* pass-throughs are structurally tied to `FretService` and
    a signature mismatch is already a compile error. This is the mechanism the plan ticket asked
    for; what's left is only which methods are named in the `Pick`.

- **Still open — two arms:**

  1. **Duplicate methods.** `getNeighborsForKey` (~134-140) and `assembleCohortForKey` (~142-144)
     duplicate `getNeighbors` (~154-156) and `assembleCohort` (~158-160) — identical bodies,
     just calling `this.ensure().getNeighbors(...)` / `.assembleCohort(...)` under a different
     name. Grep the tree for `getNeighborsForKey` / `assembleCohortForKey` call sites first (none
     expected outside this file and its tests, per the plan ticket's research); remove the two
     duplicates and repoint any caller at the non-`ForKey` name.

  2. **Facade surface gap — resolved here as: widen the `Pick`, don't narrow the interface.**
     Six `FretService` members have no pass-through on `Libp2pFretService` at all, so an app that
     only holds the libp2p-wrapped service cannot reach them: `reportNetworkSize`,
     `getNetworkSizeEstimate`, `getNetworkChurn`, `detectPartition`, `setActivityHandler`,
     `iterativeLookup` (signatures below, from `src/index.ts` ~116-125). These are genuine core
     capabilities (size estimation, partition detection, activity handling, iterative lookup),
     not something the wrapper has reason to withhold — every other public `FretService` method
     already gets a pass-through, so the omission reads as an oversight rather than a decision.
     Narrowing the public `FretService` interface instead would be the wrong-sized fix: it
     touches the interface every other consumer of the package depends on, to work around one
     wrapper class's incompleteness.

     Add one hand-written pass-through per member, matching the existing style (e.g.
     `assembleCohort` ~158-160), and add each name to the `FretServiceFacade` `Pick` (~19-23) so
     the tie is structural like the rest:

     ```ts
     reportNetworkSize(estimate: number, confidence: number, source?: string): void {
       this.ensure().reportNetworkSize(estimate, confidence, source);
     }

     getNetworkSizeEstimate(): { size_estimate: number; confidence: number; sources: number } {
       return this.ensure().getNetworkSizeEstimate();
     }

     getNetworkChurn(): number {
       return this.ensure().getNetworkChurn();
     }

     detectPartition(): boolean {
       return this.ensure().detectPartition();
     }

     setActivityHandler(handler: ActivityHandler): void {
       this.ensure().setActivityHandler(handler);
     }

     iterativeLookup(key: Uint8Array, options: LookupOptions): AsyncGenerator<RouteProgress> {
       return this.ensure().iterativeLookup(key, options);
     }
     ```

     `ActivityHandler`, `LookupOptions`, and `RouteProgress` need adding to the existing
     `import type { FretConfig, FretService, RouteAndMaybeActV1, NearAnchorV1, ReportEvent,
     SerializedTable } from '../index.js';` line at the top of the file.

     Once the `Pick` names every `FretService` member, consider (small follow-up, not required)
     switching `implements Startable, FretServiceFacade` to `implements Startable, FretService`
     directly and deleting the now-total `Pick` alias — purely cosmetic, do only if it doesn't
     complicate the diff.

## Edge cases & interactions

- `iterativeLookup` returns an `AsyncGenerator` — the pass-through must return the generator
  object directly (`return this.ensure().iterativeLookup(...)`), not `await` or wrap it; confirm
  with a quick manual check that iterating the wrapper's return value drives the same generator
  as calling the core service directly (a test already exists for the core generator in
  `test/`, so this only needs the plumbing to be transparent — no new generator-semantics test
  needed).
- `ensure()` throws `"Libp2pFretService: libp2p node not injected"` if called before the node is
  available; the six new pass-throughs share that behavior with every existing pass-through (all
  route through `this.ensure()`), so no special pre-injection handling is needed — just confirm
  none of the six bypass `ensure()`.
- After removing `getNeighborsForKey` / `assembleCohortForKey`, re-run
  `packages/fret/test/peer-discovery.spec.ts` and a full-package grep for the two removed names
  to confirm no dangling reference (mirrors how the `consolidate-discovery-emission` review
  verified its own deletions).
- `npx tsc --noEmit` from `packages/fret/` must stay clean after widening the `Pick` — a missing
  import (`ActivityHandler` / `LookupOptions` / `RouteProgress`) will surface there immediately.

TODO:
- Remove `getNeighborsForKey` and `assembleCohortForKey`; confirm no other call sites via grep.
- Add pass-throughs for `reportNetworkSize`, `getNetworkSizeEstimate`, `getNetworkChurn`,
  `detectPartition`, `setActivityHandler`, `iterativeLookup`; import their supporting types;
  widen `FretServiceFacade`'s `Pick` to include all six.
- `npx tsc --noEmit`, `yarn build`, `yarn test` (from `packages/fret/`) — confirm clean before
  handoff.
