description: Move the bookkeeping that decides how long to wait before retrying an unresponsive peer out of the main service class and into a small class of its own, so its arithmetic can be tested directly. This ticket builds the class and rewires the service; converting the existing tests to it is a follow-up.
files: packages/fret/src/service/probe-backoff.ts (new), packages/fret/src/service/fret-service.ts, packages/fret/src/service/size-observer.ts (pattern to follow), packages/fret/src/utils/expiring-map.ts, packages/fret/test/probe-backoff.spec.ts (new)
difficulty: medium
---
Extract the per-peer probe backoff — the map, the escalation rule, the retention lifetime and the
three constants — out of `FretService` into its own class with an injectable clock, following the
house pattern `SizeObserver` (`packages/fret/src/service/size-observer.ts`) already sets: a class
that reads nothing but its own state and a `now: () => number`, so its arithmetic is unit-testable
without sleeps or libp2p nodes.

`FretService` keeps every call site and delegates. No behavior change is intended anywhere.

This is phase 1 + phase 2 of the original ticket `backoff-map-test-surface`. The eight spec files
that reach the private field, the shared test helper, and the docs update are the sibling ticket
`backoff-test-surface-migration`, which depends on this one. **Consequence for this ticket: after
your change the existing specs will not compile or pass**, because they reach `backoffMap` /
`recordBackoff` / `clearBackoff` / `getBackoffPenalty` directly. That is expected and is the
sibling ticket's work. Run `test/probe-backoff.spec.ts` alone plus `npx tsc --noEmit`, and say
plainly in the handoff which spec files are left red and that the sibling fixes them.

## Shape

New file `packages/fret/src/service/probe-backoff.ts`.

```ts
export interface ProbeBackoffOptions {
	/** Hard entry ceiling, forwarded to the backing ExpiringMap. Required — see the sizing note at the FretService call site. */
	capacity: number;
	/** First window; doubled per failure. Default 1000. */
	baseMs?: number;
	/** Cap on the doubling factor; longest window is baseMs * maxFactor. Default 32. */
	maxFactor?: number;
	/** How long an escalation is remembered after the last failure. Default 300_000. Must exceed baseMs * maxFactor. */
	retainMs?: number;
	/** Clock seam. Default Date.now. Drives BOTH the window stamp and the retention TTL. */
	now?: () => number;
}

export class ProbeBackoff {
	static readonly DEFAULT_BASE_MS = 1000;
	static readonly DEFAULT_MAX_FACTOR = 32;
	static readonly DEFAULT_RETAIN_MS = 300_000;

	readonly baseMs: number;
	readonly maxFactor: number;
	readonly retainMs: number;
	/** Retained entries; what `capacity` bounds. */
	readonly capacity: number;
	get size(): number;

	constructor(opts: ProbeBackoffOptions);

	/** One more failure: start at factor 1, or double the retained factor up to `maxFactor`. Restarts the retention window. */
	record(id: string): void;
	/** Forget one peer's escalation entirely (proof of life). */
	clear(id: string): void;
	/** Forget every peer's escalation (a start->stop->start cycle is a fresh run). */
	clearAll(): void;

	/** Is this peer inside an open window right now? The off-backoff gate. */
	isBackedOff(id: string): boolean;
	/** Routing-cost term in [0,1]: `min(1, factor / maxFactor)` while the window is open, else 0. */
	penalty(id: string): number;
	/** Escalation factor, 0 when nothing is retained. The ordering key for the re-probe arms. */
	factor(id: string): number;

	/** Drop retention-expired entries. */
	sweep(): void;
	/** Drop entries for peers the predicate says are gone. Orthogonal to `sweep` — no TTL can see that a peer left the store. */
	prune(isKnown: (id: string) => boolean): void;
}
```

### The two readers of one entry

The map has a boolean off-backoff **gate** and a **factor ordering key**, and the interface must
expose both without letting a caller reconstruct the escalation rule for itself. `isBackedOff` and
`factor` are those two readers. `penalty` is a third, for the routing cost function. No accessor
returns the raw `{until, factor}` entry, and there is no `set` — so no caller outside the class can
write a window or a factor, which is what makes the escalation rule live in exactly one place.

`isBackedOff(id)` is exactly today's `getBackoffPenalty(id) === 0` gate negated, and the two are
provably equivalent: a retained entry always carries `factor >= 1`, so an open window always yields
`penalty > 0`, and `penalty === 0` means "no live entry or window closed". Replacing the gate with
the boolean is a readability change, not a behavior one — pin it with the `penalty`/`isBackedOff`
agreement test below.

`factor(id)` returns 0 for an absent or retention-expired entry, mirroring today's
`backoffMap.get(id)?.factor ?? 0`, including `ExpiringMap.get`'s delete-on-read of an expired entry.

### The clock

One injected clock drives both the window stamp (`until = now() + baseMs * factor`) and the
`ExpiringMap` retention TTL. Today those are split — `until` is stamped from `Date.now()` inside
`recordBackoff` while retention runs off the map's own (injectable) clock — which is why
`test/ring-membership.spec.ts` has to swap the whole map in to test retention, and why
`test/failure-recovery.spec.ts` has to hand-write an expired `until`. Unifying them is what removes
both hacks. Production passes no `now`, so both stay `Date.now` and nothing changes.

### One instance, not two

The `foreign` and `dead` re-probe arms deliberately share one backoff map; there is a `NOTE:` at
`reprobeExcludedTargets` recording that as a decision. `FretService` holds **one**
`private readonly backoff: ProbeBackoff`. Do not give the arms an instance each. Carry that `NOTE:`
forward unchanged.

## FretService call sites (all of them)

Grep `backoffMap|recordBackoff|clearBackoff|getBackoffPenalty|BACKOFF_` in
`src/service/fret-service.ts`; line numbers verified 2026-08-22, re-grep rather than trusting them.

| Site | Today | After |
|---|---|---|
| field decl (231) + constructor (514) | `ExpiringMap<{until,factor}>` + sizing comment | `new ProbeBackoff({ capacity: <same expression> })`; **keep the sizing comment verbatim** — it explains the Core/Edge split and why a wrong eviction is cheap |
| constants (251, 253, 268) | three `private static readonly` | delete; the doc comments move onto `ProbeBackoff`'s defaults **unedited** (they are the only record of why retention is not the window) |
| `stop()` (1223) | `backoffMap.clear()` | `backoff.clearAll()` |
| `probeNeighborLatency` busy arm (2475) | `recordBackoff(id)` | `backoff.record(id)` |
| comment (2532) | names `backoffMap` in the phase-2 selection-purity note | reword to name the class; the claim is unchanged |
| `classifyTargets` gate (2572) | `getBackoffPenalty(e.id) === 0` | `!backoff.isBackedOff(e.id)` |
| `reprobeExcludedTargets` gate (2644) | same | same |
| re-probe ordering (2653) | `backoffMap.get(a.id)?.factor ?? 0` | `backoff.factor(a.id)` |
| `probeMembership` ok arm (2680) | `clearBackoff(id)` | `backoff.clear(id)` |
| `probeMembership` arms (2687, 2698, 2709) | `recordBackoff(id)` | `backoff.record(id)` |
| `iterativeLookup` ok arm (3077) | `clearBackoff(next)` | `backoff.clear(next)` |
| `iterativeLookup` arms (3081, 3106) | `recordBackoff(next)` | `backoff.record(next)` |
| `buildNextHopOptions` (3150) | `backoffPenalty: (id) => this.getBackoffPenalty(id)` | `(id) => this.backoff.penalty(id)` |
| `recordBackoff` / `clearBackoff` / `getBackoffPenalty` / `pruneBackoffMap` (3162–3193) | private methods | delete |
| `sweepBoundedMaps` (3207–3209) | `backoffMap.sweep()` + `pruneBackoffMap()` | `backoff.sweep()` + `backoff.prune(id => this.store.getById(id) !== undefined)` |
| `routeAct` arms (3388, 3416, 3477, 3487) | `recordBackoff(...)` | `backoff.record(...)` |

The two production `clearBackoff` callers are **confirmed** to be exactly the two rows above —
`probeMembership`'s `ok` + `out.value.ok` arm, and `iterativeLookup`'s `ok` arm. There are no
others in `src/`; the original ticket left this as "find them with the same grep", and this is the
answer.

## Test surface for this ticket

**New `test/probe-backoff.spec.ts`** — pure unit, no libp2p node, no sleeps, fake clock throughout:

- first `record` yields factor 1 and a window of `baseMs`
- repeated `record` after each window closes doubles: 1, 2, 4, 8, 16, 32
- factor caps at `maxFactor` and stays there across further records
- a closed window is retained: `isBackedOff` false and `penalty` 0, but `factor` still reports the escalation
- once `retainMs` elapses with no further `record`, the entry is forgotten and the next `record` starts at factor 1
- `record` restarts retention (retention is measured from the last failure, not the first): advance to just under `retainMs`, `record`, advance again to just under `retainMs`, factor must still be retained
- `penalty` and `isBackedOff` agree: `penalty(id) > 0` iff `isBackedOff(id)` — the pinned equivalence that lets the gate be written either way
- `penalty` equals `min(1, factor / maxFactor)` while the window is open
- `clear(id)` forgets one peer, `clearAll()` forgets every peer
- `prune(isKnown)` drops entries the predicate rejects and keeps the ones it accepts
- capacity binds: insert `capacity + 1` distinct ids, `size` never exceeds `capacity`
- the retention inequality over the **shipped defaults**, read off `ProbeBackoff.DEFAULT_*` rather than copies: `DEFAULT_RETAIN_MS > DEFAULT_BASE_MS * DEFAULT_MAX_FACTOR`, with a `to.be.a('number')` guard on each so a typo'd name cannot make the comparison vacuous (carry the existing guard idiom over from `test/ring-membership.spec.ts:490`)

## Edge cases & interactions

- **Closed window vs forgotten entry.** Different states that both make `isBackedOff` false and
  `penalty` 0; only `factor` tells them apart. Confusing them is the original bug
  `BACKOFF_RETAIN_MS` exists to prevent (a gate that *deleted* on expiry, so escalation always
  restarted at 1). Test both, and test that `record` after each lands on the right factor.
- **Retention is measured from the last failure.** `record` must re-`set` the map key (which
  restarts the `ExpiringMap` TTL), never mutate a retained entry in place — `ExpiringMap.set`
  deletes-then-inserts specifically so a refreshed key moves to the newest iteration slot and is not
  chosen as the next eviction victim. A read-modify-write that skips `set` would break both the
  retention window and the eviction order.
- **Capacity eviction under an at-capacity map.** `ExpiringMap` evicts the nearest-to-expiry entry
  on insert at capacity. A wrong eviction costs one peer its escalation (next failure restarts at
  factor 1) — cheap, and the existing constructor comment says so. Keep the comment; assert only
  that `size <= capacity`, not *which* id was evicted.
- **`prune` vs `sweep` are orthogonal.** A peer evicted from the routing table can be well inside
  its retention window, and no TTL can see it left the store; conversely a retention-expired entry
  for a peer still in the store is `sweep`'s job. Both are called per tick. Test each independently,
  and do not let one call the other.
- **`prune` iterates a key snapshot.** Today's `pruneBackoffMap` relies on `ExpiringMap.keys()`
  returning an array snapshot — the class documents that it returns an array precisely so a caller
  can delete from the map while walking the result. Preserve that; carry the comment.
- **`stop()` clears, and the leave fan-out runs first.** `stop()` sends leave notices *before*
  clearing, so the fan-out still sees the run's backoff state. Keep `clearAll()` at its current
  position (after `sendLeaveToNeighbors`), not earlier.
- **start -> stop -> start.** The instance is constructed once and `clearAll()`ed on stop, so a
  second run starts empty. Do not reconstruct the instance in `start()`, and do not make the field
  non-`readonly` in production code (the sibling ticket's `setBackoffOf` is a test-only cast).
- **Foreign and dead arms share the instance.** A peer that accumulated backoff while `foreign` and
  later goes `dead` carries its escalation across; that is the recorded decision at
  `reprobeExcludedTargets`. An implementation that gives each arm its own instance passes every unit
  test and silently repeals it.
- **The near pass records no backoff except on `busy`.** `probeNeighborLatency`'s unreachable and
  timeout arms must still record nothing (`test/failure-recovery.spec.ts:167` pins this); only the
  `busy` arm records. Do not "tidy" the delegation into a single record at the top of the failure
  path.
- **`local-limit` records nothing.** Our own stream-cap ceiling firing is not evidence about the
  peer — no backoff, no strike, no decay.
- **Clock monotonicity is not assumed.** A `now` that goes backwards makes `until` look far in the
  future; nothing here needs to defend against it (`Date.now` is the only production clock), but do
  not add an assertion that would throw in a spec stepping a fake clock.
- **`retainMs <= baseMs * maxFactor` is a misconfiguration, not a runtime throw.** The invariant is
  pinned as a test over the defaults, matching how `test/stabilize-budget-invariants.spec.ts` treats
  the tick budgets (specs mutate those statics down, so a runtime assert would fire in them). Do not
  validate it in the constructor.

## TODO

Phase 1 — the class
- Write `src/service/probe-backoff.ts` with the interface above, backed by an `ExpiringMap<{until, factor}>`
- Move the three constants' doc comments onto the defaults unedited
- Write `test/probe-backoff.spec.ts` covering every bullet under *Test surface*; run it alone first

Phase 2 — the service
- Convert every `FretService` site in the table above; delete the four private methods and three statics
- Keep the constructor sizing comment and the `reprobeExcludedTargets` shared-map `NOTE:` verbatim
- `npx tsc --noEmit` from `packages/fret`; list in the handoff exactly which spec files still fail to compile, so the sibling ticket starts from a known set
