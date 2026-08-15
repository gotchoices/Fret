description: The routing table's size limit is silently skipped during the exact moments the table is bulk-loaded at startup, so it can balloon past its cap right when enforcement matters most.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/service.table-persistence.spec.ts, docs/fret.md, packages/fret/README.md
difficulty: easy
----
`enforceCapacity` returned early and did nothing while `cachedSelfCoord` was still null. That null state held precisely during `start()`'s first peerStore seed and during any pre-start `importTable()` — the two paths most likely to insert a large batch of peers at once. Capacity therefore went unenforced exactly when a bulk insert could overflow the table.

## Fix already applied (research + implementation both done in this pass)

Went with the ticket's second option: **`enforceCapacity` now awaits `selfCoord()`** instead of reading the nullable `cachedSelfCoord` cache and bailing. `selfCoord()` already memoizes (`if (this.cachedSelfCoord) return this.cachedSelfCoord;`), so this costs nothing once the hash is warm and correctly resolves it lazily the first time.

`enforceCapacity` (`fret-service.ts` ~313) changed `private enforceCapacity(): void` → `private async enforceCapacity(): Promise<void>`, `const self = this.cachedSelfCoord; if (!self) return;` → `const self = await this.selfCoord();`.

All five call sites now `await` it:
- `mergeAnnounceSnapshot` (~1233)
- `seedFromPeerStore` (~1287) — the `start()` first-seed path from the ticket
- `seedFromBootstraps` (~1346)
- `mergeNeighborSnapshots` (~1537)
- `importTable` (~2267) — the pre-start bulk-import path from the ticket

Four of those five call sites were already inside `async` functions, so `await` was a one-line addition. `importTable` was the one genuinely public, synchronous API (`(table: SerializedTable) => number`) — since it can legitimately be called before `start()` (see `docs/fret.md`'s "Routing table persistence" usage example), the null-coord case is not hypothetical there, and hashing self's peer id (`hashPeerId`, SHA-256 over the multihash bytes) is inherently async. So `importTable` became `async (table: SerializedTable) => Promise<number>`. Per AGENTS.md ("Don't worry about backwards compatibility yet") this was changed in place rather than shimmed, and propagated to:
- the `FretService` interface in `src/index.ts`
- the `Libp2pFretService` pass-through wrapper in `src/service/libp2p-fret-service.ts`
- the three call sites in `test/service.table-persistence.spec.ts` (added `await`, made the enclosing `it(...)` callbacks `async`)
- the usage examples in `docs/fret.md` and `packages/fret/README.md` (added `await`, noted the signature/rationale)

## Verification already done

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn build` — clean.
- `cd packages/fret && yarn test` — full suite, 408 passing, 0 failing (includes `test/service.table-persistence.spec.ts` and the simulation/size-estimator suites, unaffected).

## TODO

- Confirm the diff reads cleanly (small, mechanical: one `void`→`async` conversion propagated through its callers) and hand off to `review/`.
- No known gaps or follow-up work identified — this was a narrowly-scoped null-check fix with no behavioral surface beyond "capacity enforcement now actually runs during bulk-insert paths."
