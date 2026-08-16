description: The size limits for the main service's two internal bookkeeping tables are now in the code, but the tests that would catch someone quietly re-tuning them are still missing. Add those tests and run the full suite.
files: packages/fret/src/service/fret-service.ts (changed, done), packages/fret/src/utils/expiring-map.ts (unchanged), packages/fret/test/expiring-map.spec.ts (new, done), packages/fret/test/ring-membership.spec.ts (changed, done this pass), packages/fret/test/profile.behavior.spec.ts (still TODO), packages/fret/test/peer-discovery.spec.ts (still TODO), docs/fret.md (updated, done)
difficulty: easy
---

<!-- resume-note -->
Second continuation of `map-capacity-bounds-service`, cut short again by a budget warning — this
time partway through the **implement** stage's own remaining-work list. **The production change
is still complete and green** (see prior notes below). This pass added the three backoff-map
tests to `ring-membership.spec.ts` and stopped there per the budget-warning protocol: **do not
re-derive what changed — the diff is already in the working tree** (uncommitted; the runner
commits after this ticket completes). Everything below "Remaining work" has NOT been done yet in
this pass and has NOT been run — no `tsc`, no test suite, this session.

## What already landed (do not redo)

- **`fret-service.ts`** — `backoffMap` / `departureDebounce` converted to `ExpiringMap`,
  `BACKOFF_BASE_MS` / `BACKOFF_MAX_FACTOR` promoted to `private static readonly`,
  `sweepBoundedMaps()` wired into `stabilizeOnce`. Full detail in the design/history is in
  `docs/fret.md` (Security and abuse considerations → Current state) and in the prior tickets'
  commits (`map-capacity-bounds`, `map-capacity-bounds-service`) — read those commits if you need
  the "why", not this file.
- **`docs/fret.md`** — both sentences added (libp2p integration bullet; Security/Current state).
- **`packages/fret/test/expiring-map.spec.ts`** — written, 24 specs, all passing (verified two
  continuations ago).
- **`packages/fret/test/ring-membership.spec.ts`** — the `Foreign re-probe backoff growth`
  describe block (was 2 specs, now 5) gained three new specs THIS PASS:
  - `'backoff escalation survives an expired window, within retention'`
  - `'escalation resets to factor 1 after BACKOFF_RETAIN_MS with no further failure'` (swaps in a
    fake-clock-driven `ExpiringMap` for `(svc as any).backoffMap` after `start()`)
  - `'BACKOFF_RETAIN_MS comfortably exceeds the longest possible backoff window'` (reads the real
    `(CoreFretService as any).BACKOFF_BASE_MS` / `BACKOFF_MAX_FACTOR` / `BACKOFF_RETAIN_MS`)

  Also added the `ExpiringMap` import at the top of the file. **These three new specs have not
  been run yet** — the file has not been type-checked or executed this pass. Read them before
  trusting them; they were written against the source but never compiled/run. If any fails on a
  small logic slip (e.g. the fake-clock swap losing the `now` reference), fix it in place — it's
  a small, self-contained block, easy to re-derive from the source at
  `packages/fret/src/service/fret-service.ts` lines ~181, ~218, ~2162-2180 (recordBackoff /
  getBackoffPenalty) if something doesn't line up.

## Remaining work

### `test/profile.behavior.spec.ts` — per-profile bounded-map capacities

Not started. Add a new `describe('Bounded internal map capacities', ...)` block (e.g. right
before the final `describe('Diagnostics rejection tracking', ...)` block, or after it — either
is fine, just don't start a second top-level describe). Needs two new imports at the top of the
file:

```ts
import { peerDiscoverySymbol } from '@libp2p/interface'
import { Libp2pFretService } from '../src/service/libp2p-fret-service.js'
```

Specs to add (the existing `createService(profile)` helper in this file already returns
`{ node, svc }` for a started `CoreFretService`):

- `(svc as any).backoffMap.capacity` — Core 2048 (`cfg.capacity`, default — `createService`
  passes no explicit `capacity`), Edge 512.
- `(svc as any).departureDebounce.capacity` — Core 512, Edge 128.
- Discovery debounce map (`maxTracked`) lives on `Libp2pFretService`, not `CoreFretService`, and
  is set purely from `cfg` at construction — **no node/start needed**:

  ```ts
  it('Core discovery debounce map (maxTracked) defaults to 4096', () => {
  	const svc = new Libp2pFretService({}, { profile: 'core', k: 7 })
  	const disc = svc[peerDiscoverySymbol] as any
  	expect(disc.emitted.capacity).to.equal(4096)
  })
  ```
  Mirror for Edge → 1024. Also add one confirming the `??` merge that lets an explicit
  `discoveryCfg.maxTracked` win over the profile default (otherwise untested):
  ```ts
  it('an explicit discoveryCfg.maxTracked overrides the profile default', () => {
  	const svc = new Libp2pFretService({}, { profile: 'core', k: 7 }, { maxTracked: 77 })
  	const disc = svc[peerDiscoverySymbol] as any
  	expect(disc.emitted.capacity).to.equal(77)
  })
  ```

### `test/peer-discovery.spec.ts` — cap / re-emission

Not started. Add one test to the top `describe('FretPeerDiscovery', ...)` block (e.g. after
"respects batchSize limit per scan"): emit more members than a small `maxTracked` and confirm (a)
every member is eventually emitted and (b) at least one is emitted more than once — proving an
evicted peer is re-emitted rather than silently dropped forever. Use real peer ids
(`createMemNode` via the existing `makeStore` helper in this file — `scan` calls
`peerIdFromString` on `entry.id`, so a synthetic id throws and is silently skipped).

Sketch (5 members, `maxTracked: 3` so the debounce map's capacity binds well before its
`debounceMs` TTL would, `batchSize: 2` so a single tick can't emit everyone at once):

```ts
it('debounce map caps at maxTracked and evicts, so an evicted peer is emitted again later', async () => {
	const count = 5
	const nodes = await Promise.all(Array.from({ length: count }, () => createMemNode()))
	await Promise.all(nodes.map(n => n.start()))
	const ids = nodes.map(n => n.peerId.toString())
	const coords = await Promise.all(nodes.map(n => hashPeerId(n.peerId)))
	const store = makeStore(ids, coords)

	const disc = new FretPeerDiscovery(store, {
		emissionIntervalMs: 100,
		batchSize: 2,
		debounceMs: 60_000,
		maxTracked: 3,
	})

	const emitted: string[] = []
	const handler = (evt: CustomEvent<PeerInfo>) => { emitted.push(evt.detail.id.toString()) }
	disc.addEventListener('peer', handler)
	await disc.start()
	await new Promise(r => setTimeout(r, 1800))
	disc.removeEventListener('peer', handler)
	await disc.stop()
	await stopAll(nodes)

	const emittedSet = new Set(emitted)
	for (const id of ids) expect(emittedSet.has(id)).to.equal(true, `${id} must eventually be emitted`)

	const counts = new Map<string, number>()
	for (const id of emitted) counts.set(id, (counts.get(id) ?? 0) + 1)
	expect(Array.from(counts.values()).some(c => c > 1)).to.equal(true,
		'an evicted peer must be re-emitted, not dropped forever')
})
```

This relies on `ExpiringMap`'s capacity-eviction (nearest-expiry-first, which under one constant
TTL is insertion order) freeing a slot once `maxTracked` is exceeded — see
`packages/fret/src/utils/expiring-map.ts`. Not timing-fragile in the way a debounce-window test
is: it only asserts "eventually true across many ticks", not an exact tick count.

### Gate — has not been run at all this pass or the prior one

- `cd packages/fret && npx tsc --noEmit`
- `cd packages/fret && yarn test` (foreground, no redirection — **the full suite has still never
  been run since `ExpiringMap` landed**, across two prior continuations; treat this as the real
  gate, not a formality). Persistence is unaffected — none of these maps is serialized, so
  `exportTable` / `importTable` must not grow a field; if `service.table-persistence.spec.ts` or
  `digitree.persistence.spec.ts` moves, something is wrong and is NOT pre-existing.
- If `tsc` or the suite surfaces a failure in a file this ticket didn't touch, check
  `tickets/.pre-existing-known.md` first, then follow the pre-existing-failure protocol
  (`tickets/.pre-existing-error.md`) rather than chasing it here.

## TODO

- Add the `Bounded internal map capacities` describe block to `test/profile.behavior.spec.ts`
  (backoffMap/departureDebounce capacities per profile, discovery `maxTracked` per profile + the
  explicit-override case).
- Add the cap/re-emission test to `test/peer-discovery.spec.ts`.
- Sanity-check the three new specs already added to `test/ring-membership.spec.ts` this pass
  compile and pass (they have not been run).
- `cd packages/fret && npx tsc --noEmit`, then `yarn test` from `packages/fret` — the real gate,
  not yet run under `ExpiringMap`.
- Only once all of the above is green: write the review/ handoff ticket (per the ticket workflow
  in `tess/agent-rules/tickets.md`) and delete this implement/ ticket.
