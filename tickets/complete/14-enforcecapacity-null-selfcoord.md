description: The routing table's size limit used to be silently skipped while the table was being bulk-loaded at startup; it is now enforced there, and a test pins the behavior so it cannot quietly regress.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/service.table-persistence.spec.ts, docs/fret.md, docs/threat-analysis.md, packages/fret/README.md
----
## What shipped

`enforceCapacity` read the memoized-but-nullable `cachedSelfCoord` and returned early when it was still `null`, doing nothing. That null window covered the two bulk-insert paths most able to overflow the table: `start()`'s first peerStore seed, and any `importTable()` call made before `start()`. The hard cap (`cfg.capacity`, default 2048) therefore went unenforced exactly when a bulk insert could blow past it.

Fix: `enforceCapacity` is `private async enforceCapacity(): Promise<void>` and awaits `this.selfCoord()` (which memoizes internally, so it is free once warm) instead of reading the cache. All five call sites await it — `mergeAnnounceSnapshot`, `seedFromPeerStore`, `seedFromBootstraps`, `mergeNeighborSnapshots`, and `importTable`. `importTable` was the one public synchronous member of that group, so it became `async` (`(table: SerializedTable) => number` → `Promise<number>`), propagated to the `FretService` interface (`src/index.ts`), the `Libp2pFretService` pass-through, the tests, and the usage examples in `docs/fret.md` / `packages/fret/README.md`.

## Review findings

**Read the code diff, not the handoff's account of it.** The implement-stage commit (`9443493`) contains only a ticket-file move; the code landed in the fix-stage commit (`4926910`). Reviewed that diff line by line.

**Correctness of the change — confirmed, with one refinement to the ticket's story.** The fix is right, but the bug's blast radius was narrower than the ticket described. Three of the four internal call sites (`seedFromPeerStore`, `seedFromBootstraps`, `mergeNeighborSnapshots`) call `applyTouch` per peer first, and `applyTouch` already awaits `selfCoord()` — so `cachedSelfCoord` was warm by the time `enforceCapacity` ran on any non-empty batch there. The genuinely broken path is `importTable` before `start()`, which writes straight through `store.importEntries` and touches nothing. This does not change the fix (awaiting is correct at every site regardless) but it does say which path the regression test must exercise.

**Missing regression test — the handoff's own flagged gap. Fixed in this pass.** Added `FretService routing-table import before start()` to `test/service.table-persistence.spec.ts`: constructs a service with `capacity: 20, m: 8`, does **not** start it, imports 40 entries, and asserts the store is trimmed to 20 and that trimming went by relevance. Verified it is a real regression test rather than a test that merely passes — temporarily restored the old `if (!self) return;` early return and the new test failed with `expected 40 to equal 20` while the three pre-existing tests stayed green, which is precisely the blind spot the handoff described. Restored the fix and re-ran.

The relevance assertion is deliberately weak in one direction: self's ring coordinate is a hash of a per-run peer id, so *which* peers land in the protected neighbor window is not predictable across runs. The test asserts only what holds whatever that window contains — the window holds at most `2m` ids, so the `capacity - 2m` highest-relevance peers survive on relevance alone. Asserting that a specific low-relevance peer was evicted would have been flaky.

**Concurrency across the new `await` — checked, no hazard.** `enforceCapacity`'s only `await` is `selfCoord()`, before it lists the store; the list/sort/evict loop has no await inside it, so two overlapping calls cannot interleave mid-eviction. The second caller finds the size already at cap and breaks on its first iteration. Worth stating explicitly because converting a synchronous mutation to `async` is exactly the change that usually introduces this class of bug — here it does not.

**New failure mode from the conversion — acceptable.** `enforceCapacity` can now reject (via `hashPeerId`) where it previously could only return. All four internal call sites sit inside existing `try`/`catch` chains that reach the stabilization tick's handler; `importTable` propagates to its caller, which `docs/fret.md` already tells callers to wrap. No change needed.

**Signature-change propagation — complete.** Grepped every `importTable` / `enforceCapacity` reference across source, tests, docs, and the README: all five internal `enforceCapacity` calls await, all four test calls await, and no unawaited `importTable` caller exists. `test/simulation/fret-sim.ts` has its own separate synchronous `enforceCapacity` — a different class with its own coordinate source, unaffected.

**Docs — read every touched file plus the ones that should have been touched.** `docs/fret.md` and `packages/fret/README.md` both correctly describe the `async` signature and the reason for it. One file the change should have reached and did not: `docs/threat-analysis.md` §5.5 cited `exportTable`/`importTable` at `fret-service.ts:1347-1360`, which was already stale and is now off by ~900 lines. Fixed inline by replacing the line-number citation with a symbol-relative one, since line numbers in a ~2300-line file will drift again.

**Major finding — filed as an arm on an existing ticket, not a new one.** `Libp2pFretService` is declared `implements Startable` only, so nothing checks its hand-written pass-throughs against the public `FretService` interface. Verified by adding `implements FretService` and compiling: six members are missing — `reportNetworkSize`, `getNetworkSizeEstimate`, `getNetworkChurn`, `detectPartition`, `setActivityHandler`, `iterativeLookup`. An application reaching FRET through the libp2p wrapper cannot use size estimation, partition detection, the activity handler, or iterative lookup at all. This is also the invariant behind this ticket's own manual work: the `importTable` signature change had to be propagated to the wrapper by hand with nothing but attention preventing a silent mismatch. Per the architecture-first rule this is a representation fix (make the drift a build error), not a point bug, and the site is already claimed by `tickets/plan/21-libp2p-fret-service-cleanup.md` — appended there as an arm rather than filed fresh.

**Tripwire recorded, not ticketed.** `enforceCapacity` lists and fully sorts the store to drop a handful of entries. It is unreachable until the table is at capacity, so it is a no-op in the common case — but a ring that settles at cap under steady churn runs it on every merge and seed. Parked as a `NOTE:` at the site in `fret-service.ts`, alongside the existing same-shape note on `selectDiverseSample`.

**Accepted tradeoffs — none encountered.** No `NOTE:` at any site this change touches records a previously-declined finding, so nothing was left alone on those grounds.

**Categories with nothing to report, and why.** *Source hygiene*: the diff adds four comment lines and changes six signatures; no function grew, none needed decomposition, and `fret-service.ts`'s ~2300-line size is a pre-existing concern this change does not move. *Resource cleanup*: nothing is allocated, opened, or scheduled by the diff. *Type safety*: no `any`, no cast, no widened type; the one type change (`number` → `Promise<number>`) is the point of the ticket and is reflected in the interface. *Pre-existing test failures*: none — the suite was green before and after.

## Verification

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn build` — clean.
- `cd packages/fret && yarn test` — **409 passing, 0 failing** (~5m); 408 before, +1 for the new regression test.
- Negative control: with the pre-fix early return restored, the new test fails and the rest of the suite still passes. Fix restored afterward and the working tree re-verified against `HEAD` for that file.
