---
description: One unresponsive neighbour can eat the whole time budget of the background maintenance cycle, so the half of that cycle that re-checks written-off peers never runs — and if the neighbour stays that way it never runs again. Give that second half a guaranteed slice of every cycle, and make the per-request limits add up.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, docs/fret.md
difficulty: medium
---

## Background

`FretService.stabilizeOnce` (`packages/fret/src/service/fret-service.ts`, ~line 2197) runs two
pooled phases under one tick-wide deadline, `STABILIZE_TICK_BUDGET_MS` (5000):

- **Phase 1** — up to 4 near peers, each `probeAndFetch`: `probeNeighborLatency` (ping, bounded by
  `MAINTENANCE_RPC_TIMEOUT_MS` = 2000) then `fetchAndMergeSnapshot` (neighbor snapshot, which
  passes **no** `timeoutMs` and so takes the route-sized default `RPC_TIMEOUT_MS` = 5000).
- **Phase 2** — `phaseTwoTargets()`: the classification arm (`unknown` peers) and both re-probe
  arms (`foreign`, `dead`), pooled through `probeMembership`.

Phase 2 sits behind a barrier on phase 1 and behind an explicit
`if (budget.signal.aborted) return`.

One phase-1 unit's worst case is 2000 + 5000 = 7000 ms against a 5000 ms tick cap, so a **single**
stalled near peer consumes the whole tick and phase 2 is skipped. That is survivable once. It is
not survivable when the cause persists: a peer that answers the cheap ping but stalls the snapshot
request never accrues contact failures, so it is never marked `dead`, so it stays in the near list
and repeats the stall on every tick — starving phase 2 indefinitely. Phase 2 is the *only* path by
which a `dead` peer is ever contacted again, and the only path by which an `unknown` peer is
classified.

There is an existing `NOTE:` in `stabilizeOnce` describing this and naming a slug
(`bug-tick-budget-starves-phase-two`); that comment is superseded by this work and must go.

## The fix, and why this shape

Two changes that compose. Neither alone is sufficient:

**1. Phase 2 gets a reserved slice of every tick (the structural half).** Phase 1 runs under its
own sub-deadline, a *child* of the tick deadline, so phase 1 exhausting its slice leaves the tick
signal un-aborted and phase 2 still runs. This retires the whole class rather than this instance:
no future growth in a per-RPC limit inside phase 1 can starve phase 2, because phase 1 can no
longer reach the tick deadline at all under normal operation.

**2. The per-request limits are made to add up (the arithmetic half).** The near-pass snapshot
fetch stops taking the route-sized 5000 ms default and takes an explicit maintenance-sized budget.
Without this, phase 1 would merely fail to complete a single unit inside its own slice on every
stalled peer, and the near passes would degrade rather than starve — better, but still wrong.

Chosen numbers, and the reasoning for each:

| constant | value | why |
|---|---|---|
| `MAINTENANCE_RPC_TIMEOUT_MS` | 2000 (unchanged) | existing ping/announce budget |
| `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` | **1000** (new) | `fetchNeighbors` is `dial: 'never'`, so there is no dial cost in this budget — only stream open on an already-multiplexed connection, a write, and a read capped at `MAX_NEIGHBORS_BYTES` (16 KiB). 1000 ms is orders of magnitude above what that costs on any link that is not already broken; exceeding it means "this peer is stalled", which is exactly the verdict we want promptly. The route-sized 5000 ms default was inherited, not chosen — the comment at the call site ("a snapshot is a real payload, not a ~50-byte ping") argues for *more than a ping*, which 1000 ms still is. |
| `STABILIZE_PHASE_ONE_BUDGET_MS` | **3000** (new) | ≥ one worst-case phase-1 unit (2000 + 1000), so a unit that is merely slow still completes rather than being cut off by the phase budget. |
| `STABILIZE_TICK_BUDGET_MS` | 5000 (unchanged) | leaves a phase-2 reserve of 2000 ms = exactly one `MAINTENANCE_RPC_TIMEOUT_MS` ping, so in the pathological case phase 2 can still complete a probe against a peer that is genuinely *alive* — which is the entire purpose of the re-probe arms. A probe against a peer that is still dead aborts on the reserve, records nothing (`wasCancelled`), and costs nothing. |

Raising `STABILIZE_TICK_BUDGET_MS` instead was rejected: the existing `NOTE:` at that constant
records that active mode ticks every 300 ms and a 5 s budget already makes active stabilization
effectively continuous under mass failure. Growing it makes that worse for no gain the reserve
does not already give.

Removing the barrier entirely (one shared pool) was also rejected: phase-2 target selection reads
the store *after* phase 1's merges, so peers first heard of in this tick's snapshots are classified
this tick. Merging the pools costs that, and the reserve fixes the starvation without paying it.

**3. Cheap mitigation, included: skip the snapshot fetch when the ping did not answer.** Today
`probeAndFetch` returns `void` from the ping and always proceeds to the fetch. A ping outcome of
`unreachable` / `timeout` / `foreign-protocol` means the fetch can only fail too, so it wastes up
to a further 1000 ms of phase-1 wall time per unreachable near peer. Have `probeNeighborLatency`
report whether the peer answered and gate the fetch on it. "Answered" is the round-trip rule
already stated in `docs/fret.md` under *Evidence strength*: `ok`, `busy` and `decode-error` all
answered; `unreachable`, `timeout` and `foreign-protocol` did not. `cancelled` / `skipped` are our
own doing and must not be reported as "did not answer" in a way that scores anything — the
existing `wasCancelled` check in `probeAndFetch` already short-circuits before the fetch, and it
must stay ahead of the new gate so the two cannot disagree.

This changes no scoring. It only removes an RPC that could not have succeeded.

## The invariant, and where it is checked

> The worst-case cost of one pooled unit inside a phase must be strictly less than that phase's
> own budget, and the phases' budgets plus a one-RPC reserve must fit inside the tick budget.

Concretely:

- `MAINTENANCE_RPC_TIMEOUT_MS + MAINTENANCE_SNAPSHOT_TIMEOUT_MS <= STABILIZE_PHASE_ONE_BUDGET_MS`
- `STABILIZE_PHASE_ONE_BUDGET_MS + MAINTENANCE_RPC_TIMEOUT_MS <= STABILIZE_TICK_BUDGET_MS`

Check it as a **test over the declared constants**, not as a runtime assertion in `stabilizeOnce`.
Reason: `test/helpers/maintenance-rig.ts` and `test/per-tick-hotpath.spec.ts` both mutate
`STABILIZE_TICK_BUDGET_MS` down to tens of milliseconds to keep tests fast, so a runtime assert
would throw in every such test. A static test over the defaults is the checkable form that
survives the rig.

## TODO

- Add `MAINTENANCE_SNAPSHOT_TIMEOUT_MS = 1000` beside `MAINTENANCE_RPC_TIMEOUT_MS` in
  `fret-service.ts`, with the doc comment stating *why* it is smaller than the route-sized default
  (no dial in the budget; 16 KiB cap; exceeding it is a stall verdict). Pass it as `timeoutMs` from
  `fetchAndMergeSnapshot`'s `fetchNeighbors` call and replace the now-wrong
  "Default (route-sized) budget" comment there.
- Add `STABILIZE_PHASE_ONE_BUDGET_MS = 3000` beside `STABILIZE_TICK_BUDGET_MS`, documenting that
  its complement is phase 2's reserved slice and that the reserve is sized at one
  `MAINTENANCE_RPC_TIMEOUT_MS`.
- In `stabilizeOnce`, open a phase-1 deadline as a **child of the tick deadline's signal**
  (`deadline(STABILIZE_PHASE_ONE_BUDGET_MS, budget.signal)`), run phase 1's pool and
  `probeAndFetch` calls against *that* signal, and `cancel()` it immediately after phase 1 drains
  — `deadline`'s cancel is mandatory, same rule as the tick deadline, and it must also run on the
  throw path. Phase 2 keeps using the tick signal.
- Keep `enforceCapacity` and the announce where they are — after phase 1 drains, outside the pool,
  and above the phase-2 early return, so a truncated tick still enforces. `enforceCapacity` must
  run even when phase 1 was cut off by its *own* budget.
- Confirm the phase-2 early return still tests the **tick** signal, not the phase-1 signal. Delete
  the stale `NOTE:` block that names `bug-tick-budget-starves-phase-two` and explains the
  starvation; replace it with one or two lines describing the reserve.
- Change `probeNeighborLatency` to return whether the peer answered (`ok` / `busy` /
  `decode-error` → answered; `unreachable` / `timeout` / `foreign-protocol` → not answered;
  `cancelled` / `skipped` → not answered, and unreachable in practice because of the point below).
  The `catch` arm (malformed id) reports not-answered. Do not change any scoring in this method.
- In `probeAndFetch`, keep the existing `wasCancelled(signal)` early return **ahead of** the new
  answered gate, then skip `fetchAndMergeSnapshot` when the ping did not answer. Return `[]` in
  that case, as the cancel arm already does.
- New spec `packages/fret/test/stabilize-budget-invariants.spec.ts`: read the four private statics
  off `FretService` and assert both inequalities above, with the failure message naming which
  number moved. Assert against the *declared defaults*, so it must not run inside a rig that has
  mutated them.
- Extend `packages/fret/test/stabilize-concurrency.spec.ts` with the case the plan ticket named:
  a near peer whose stub connection answers `PROTOCOL_PING` and **hangs** `PROTOCOL_NEIGHBORS`,
  with the real (unmutated) budgets in place, plus at least one `dead` and one `unknown` peer in
  the store. Assert the phase-2 peers **are** contacted — on the first tick and again on a second
  tick, so the "and it never gets a turn again" half is pinned too. Written against HEAD this test
  must fail; check that it does before writing the fix, and say so in the handoff.
- Add the companion case: a near peer that is entirely unreachable (ping times out) issues **no**
  `PROTOCOL_NEIGHBORS` request at all — pins the mitigation, since the previous behavior was a
  request that could only fail.
- Check `test/helpers/maintenance-rig.ts` — it saves/restores `STABILIZE_TICK_BUDGET_MS` around a
  run. If any test needs to shrink phase 1 independently, give the rig a `setPhaseOneBudget` beside
  `setTickBudget` with the same save/restore discipline; do not add it speculatively if no test
  needs it.
- Update `docs/fret.md`:
  - *Stabilization and churn handling* → the **Two phases** bullet: state the phase-1 sub-budget
    and phase 2's reserved slice, and that phase 2 can no longer be starved by a phase-1
    straggler; state that a near peer whose ping did not answer is not snapshot-fetched.
  - *Stream management* → the per-call-site timeout override list: add the neighbor-snapshot fetch
    at `MAINTENANCE_SNAPSHOT_TIMEOUT_MS`, and record why it is *not* the route-sized default (the
    reasoning there currently reads as if only `sendMaybeAct` is exempt).
  - State the invariant and where it is pinned.

## Edge cases & interactions

- **Phase 1 cut off by its own sub-budget must still enforce capacity and announce.** The seeds no
  longer trim for themselves, so skipping `enforceCapacity` on a truncated phase 1 leaves that
  tick's inserts untrimmed. It sits above the phase-2 return today for exactly this reason; the new
  phase-1 deadline must not move it below.
- **A phase-1 task cut off by the phase budget must score nothing** — no strike, no backoff, no
  relevance decay, no `pingsFail`. `wasCancelled` compares against the signal the task was handed;
  that signal is now the phase-1 signal, not the tick signal. Confirm every phase-1 task is handed
  the phase signal explicitly and none defaults to `runSignal` (the existing rule) or to the tick
  signal (the new hazard). A test that aborts mid-phase-1 and asserts zero strikes belongs here.
- **`stop()` must still collapse the whole tick at once.** The phase-1 deadline is a child of the
  tick deadline which is a child of the run signal, so a `stop()` aborts all three. Pin it: a
  `stop()` landing inside phase 1 must leave phase 2 un-run and record nothing.
- **Double cancel / leak.** Two `deadline()` handles are now live in one tick. Both must be
  cancelled on every exit path including a throw, or the tick leaks a timer and the mocha exit
  watchdog (`test/mocha-exit-watchdog.ts`, 10 s grace) fails the run. That watchdog is the
  regression detector here — do not add `--exit`.
- **Tests that mutate `STABILIZE_TICK_BUDGET_MS` below `STABILIZE_PHASE_ONE_BUDGET_MS`**
  (`per-tick-hotpath.spec.ts` sets 50) must still work: the phase-1 deadline is a *child*, so it
  aborts with the parent at 50 ms and the phase budget is simply never the binding constraint.
  Confirm both those specs still pass unchanged rather than assuming it.
- **Phase 2 with an empty target set** still short-circuits at `phaseTwoTargets()` via the store's
  O(1) per-label counts — the reserve must not turn the single-network steady state into a store
  walk. Nothing here should touch `phaseTwoTargets`; verify it still returns early with zero
  `store.list()` calls.
- **The four candidate sets stay disjoint.** Nothing here changes selection, but the disjointness
  assertion in `stabilize-concurrency.spec.ts` is what makes pooling safe against the
  lost-increment race on the score counters — it must still pass.
- **Pool concurrency high-water mark.** The existing spec asserts the high-water mark *equals* the
  cap, proving the tick genuinely overlaps. Splitting the phases across two `runPooled` calls with
  the same `concurrency` must not break that; if the two phases now need different signals, build
  two pool option objects rather than mutating one.
- **A near peer that answers `busy`.** `busy` is an answer, so the snapshot fetch still runs. That
  is deliberate — the peer is on our protocol and alive — but it means a peer answering `busy` on
  ping and stalling the snapshot still costs a full phase-1 unit. Bounded now by the sub-budget, so
  it is no longer a starvation path; no further handling needed.
- **Edge profile.** `maintenanceConcurrency` is 2 on Edge, so 4 near peers take two pool rounds and
  phase 1 is likelier to hit its sub-budget. That is the profile's stated posture ("fewer probes per
  window") and phase 2's reserve is unaffected — but sanity-check the Edge case as well as whatever
  profile the rig defaults to.

## Expected test outputs

- `stabilize-budget-invariants.spec.ts`: both inequalities hold at the shipped numbers
  (2000 + 1000 ≤ 3000; 3000 + 2000 ≤ 5000). Flipping `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` back to
  `RPC_TIMEOUT_MS` fails the first; raising `STABILIZE_PHASE_ONE_BUDGET_MS` to 4000 fails the
  second.
- `stabilize-concurrency.spec.ts`, stalled-snapshot case: the `dead` and `unknown` peers each
  receive exactly one `PROTOCOL_PING` per tick, on both tick 1 and tick 2. Against HEAD: zero on
  both.
- `stabilize-concurrency.spec.ts`, unreachable-near-peer case: zero `PROTOCOL_NEIGHBORS` streams
  opened to that peer. Against HEAD: one.

## Validation

From `packages/fret/`:

```
npx tsc --noEmit
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/stabilize-concurrency.spec.ts" "test/stabilize-budget-invariants.spec.ts" "test/per-tick-hotpath.spec.ts" "test/failure-recovery.spec.ts" "test/dead-state.spec.ts" --timeout 30000
yarn test
```

Run `yarn test` in the foreground with no redirection so the runner's idle timer stays alive. Note
in the handoff whether the stalled-snapshot test was confirmed failing against HEAD before the fix.

<!-- resume-note -->
## Discovered state (second interrupted run — still NO code changed)

Two implement runs have now stopped on a token-budget warning during investigation. The working
tree carries **no** changes from either. The section below supersedes the previous resume note: it
is the *patch*, not a reading list. Every snippet below was read verbatim from HEAD this run, so
the next run should apply them and go straight to validation. Line numbers are from this run; grep
the named symbol rather than trusting them.

The ticket's instruction to confirm the stalled-snapshot test **fails against HEAD before writing
the fix** has still not been carried out, and the handoff must still say so.

### Edit 1 — `src/service/fret-service.ts`, immediately after `MAINTENANCE_RPC_TIMEOUT_MS = 2000;` (~line 321)

```ts
	/**
	 * Whole-RPC budget for the neighbor-snapshot fetch (`fetchNeighbors` in
	 * `fetchAndMergeSnapshot`) — deliberately smaller than the route-sized default.
	 *
	 * `fetchNeighbors` is `dial: 'never'`, so no dial cost sits inside this budget: it is a stream
	 * open on an already-multiplexed connection, one write, and a read the wire cap bounds at
	 * `MAX_NEIGHBORS_BYTES` (16 KiB). 1 s is orders of magnitude above what that costs on any link
	 * that is not already broken, so exceeding it means "this peer is stalled" — the verdict we
	 * want promptly, because phase 1 of a tick is bounded by {@link STABILIZE_PHASE_ONE_BUDGET_MS}
	 * and a stalled snapshot must not eat it. Still well above {@link MAINTENANCE_RPC_TIMEOUT_MS}
	 * in kind: a snapshot is a real payload, not a ~50-byte ping.
	 */
	private static readonly MAINTENANCE_SNAPSHOT_TIMEOUT_MS = 1000;
```

### Edit 2 — same file, immediately after `STABILIZE_TICK_BUDGET_MS = 5000;` (~line 339)

```ts
	/**
	 * Wall-clock cap on **phase 1** of a stabilization tick (the pooled near-peer
	 * ping then snapshot-fetch pass), opened as a *child* of the tick deadline.
	 *
	 * Its complement inside {@link STABILIZE_TICK_BUDGET_MS} is phase 2's reserved slice:
	 * 5000 - 3000 = 2000 ms, exactly one {@link MAINTENANCE_RPC_TIMEOUT_MS} ping, so even a phase 1
	 * that runs to its own deadline leaves phase 2 able to complete a probe against a peer that is
	 * genuinely alive — which is the whole purpose of the classification and re-probe arms. Phase 2
	 * is the *only* path by which a `dead` peer is contacted again or an `unknown` one is
	 * classified, so a phase-1 straggler must not be able to starve it.
	 *
	 * 3000 is >= one worst-case phase-1 unit ({@link MAINTENANCE_RPC_TIMEOUT_MS} +
	 * {@link MAINTENANCE_SNAPSHOT_TIMEOUT_MS}), so a merely-slow peer still completes rather than
	 * being cut off by the phase budget. Both inequalities are pinned over the declared defaults by
	 * `test/stabilize-budget-invariants.spec.ts` rather than asserted at runtime — the test rigs
	 * mutate these statics down to tens of milliseconds, so a runtime assert would throw in them.
	 */
	private static readonly STABILIZE_PHASE_ONE_BUDGET_MS = 3000;
```

### Edit 3 — `stabilizeOnce` (~line 2198)

HEAD body, verbatim (long NOTE blocks elided as marked — keep them unchanged):

```ts
		const budget = deadline(FretService.STABILIZE_TICK_BUDGET_MS, this.runSignal);
		try {
			const pool = { concurrency: this.maintenanceConcurrency, signal: budget.signal };
			const merged = await runPooled(near.map((id) => () => this.probeAndFetch(id, budget.signal)), pool);
			logRejected(merged, near, 'probeAndFetch');
			const announced = fulfilledValues(merged).flat();
			// ... long NOTE block about enforceCapacity — KEEP unchanged ...
			await this.enforceCapacity();
			if (announced.length > 0) this.detach(this.announceToNewPeers(announced), 'announceToNewPeers');

			// Selecting phase-2 targets costs at most one store walk, ... Tracked as
			// `bug-tick-budget-starves-phase-two`.       <-- DELETE this whole paragraph
			if (budget.signal.aborted) return;
			const targets = this.phaseTwoTargets();
			const probed = await runPooled(targets.map((id) => () => this.probeMembership(id, budget.signal)), pool);
			logRejected(probed, targets, 'probeMembership');
		} finally {
			budget.cancel();
		}
```

Replace the phase-1 lines with a nested deadline, and give phase 2 its own pool object (do **not**
mutate the shared one — the phases now run against different signals):

```ts
			// Phase 1 runs under its own sub-deadline, a *child* of the tick's, so phase 1
			// exhausting its slice leaves the tick signal un-aborted and phase 2 still runs.
			// `cancel()` is mandatory on every exit path including a throw — same rule as the tick
			// deadline — or the tick leaks a timer and the mocha exit watchdog fails the run.
			const phaseOne = deadline(FretService.STABILIZE_PHASE_ONE_BUDGET_MS, budget.signal);
			let announced: string[];
			try {
				const phaseOnePool = { concurrency: this.maintenanceConcurrency, signal: phaseOne.signal };
				const merged = await runPooled(near.map((id) => () => this.probeAndFetch(id, phaseOne.signal)), phaseOnePool);
				logRejected(merged, near, 'probeAndFetch');
				announced = fulfilledValues(merged).flat();
			} finally {
				phaseOne.cancel();
			}
```

`enforceCapacity` and the announce stay exactly where they are — after phase 1 drains, outside the
pool, above the phase-2 early return — so a phase 1 cut off by its **own** budget still enforces.

Stale-NOTE replacement (sits above `if (budget.signal.aborted) return;`):

```ts
			// Phase 2 tests the **tick** signal, never phase 1's: phase 1 exhausting its own
			// sub-budget must not skip phase 2 — the reserve between the two budgets
			// (STABILIZE_TICK_BUDGET_MS - STABILIZE_PHASE_ONE_BUDGET_MS = one ping) is exactly what
			// buys phase 2 its turn. This return still fires for a `stop()` or a tick that really
			// is out of time.
```

Phase-2 pool line becomes:

```ts
			const phaseTwoPool = { concurrency: this.maintenanceConcurrency, signal: budget.signal };
			const probed = await runPooled(targets.map((id) => () => this.probeMembership(id, budget.signal)), phaseTwoPool);
```

Also refresh the method's own doc block (~line 2178) — its numbered list should state the phase-1
sub-budget and phase 2's reserved slice.

### Edit 4 — `probeAndFetch` (~line 2266)

HEAD body, verbatim:

```ts
	private async probeAndFetch(id: string, signal: AbortSignal | undefined): Promise<string[]> {
		await this.probeNeighborLatency(id, signal);
		// A tick that ran out of budget mid-ping has nothing to fetch — and `fetchNeighbors` would
		// swallow the abort into an empty snapshot and count it as fetched.
		if (this.wasCancelled(signal)) return [];
		return this.fetchAndMergeSnapshot(id, signal);
	}
```

Becomes:

```ts
	private async probeAndFetch(id: string, signal: AbortSignal | undefined): Promise<string[]> {
		const answered = await this.probeNeighborLatency(id, signal);
		// A tick that ran out of budget mid-ping has nothing to fetch — and `fetchNeighbors` would
		// swallow the abort into an empty snapshot and count it as fetched. Stays *ahead* of the
		// answered gate below so the two can never disagree about a cancelled ping.
		if (this.wasCancelled(signal)) return [];
		// A ping that did not answer (`unreachable` / `timeout` / `foreign-protocol`) means the
		// fetch can only fail too, so it would spend up to MAINTENANCE_SNAPSHOT_TIMEOUT_MS of
		// phase-1 wall time for nothing. This removes an RPC that could not have succeeded; it
		// scores nothing and changes no verdict.
		if (!answered) return [];
		return this.fetchAndMergeSnapshot(id, signal);
	}
```

### Edit 5 — `probeNeighborLatency` (~line 2280): `Promise<void>` becomes `Promise<boolean>`

The body is one `try` around `switch (out.kind)`; **every arm already returns**, so this is a
per-arm edit with no fallthrough to reason about. "Answered" is the round-trip rule from
*Evidence strength* in `docs/fret.md`:

| arm | returns |
|---|---|
| `ok`, `out.value.ok` true (the `applySuccess` path) | `true` |
| `ok`, `out.value.ok` false (the peer's negative pong) | `true` |
| `busy` | `true` |
| `decode-error` | `true` |
| `foreign-protocol` / `unreachable` / `timeout` (one shared arm) | `false` |
| `cancelled` / `skipped` (one shared arm) | `false` |
| `catch` (malformed id) | `false` |

Change **no scoring** in this method. Add to its doc comment: what the return means, the
round-trip rule, and that `cancelled` / `skipped` returning `false` is unreachable in practice
because `probeAndFetch`'s `wasCancelled` check sits ahead of the gate.

### Edit 6 — `fetchAndMergeSnapshot` (~line 2564)

HEAD, verbatim:

```ts
		const announced: string[] = [];
		// Default (route-sized) budget: a snapshot is a real payload, not a ~50-byte ping.
		const out = await fetchNeighbors(this.node, id, this.protocols.PROTOCOL_NEIGHBORS, {
			signal,
			// The fetch path's single cap enforcement point — the merge loop below does not slice.
			// Truncating here puts the bound ahead of the parse-and-hash loop instead of inside it.
			parse: makeSnapshotParser(this.mergeSnapshotCaps()),
		});
```

Replace the "Default (route-sized) budget" comment and add `timeoutMs`:

```ts
		const announced: string[] = [];
		// Maintenance-sized, not the route-sized default: this fetch runs inside a tick's phase-1
		// sub-budget, and there is no dial in it (`fetchNeighbors` is connection-only), so the
		// route budget would let one stalled peer consume the phase. See
		// MAINTENANCE_SNAPSHOT_TIMEOUT_MS.
		const out = await fetchNeighbors(this.node, id, this.protocols.PROTOCOL_NEIGHBORS, {
			signal,
			timeoutMs: FretService.MAINTENANCE_SNAPSHOT_TIMEOUT_MS,
			// The fetch path's single cap enforcement point — the merge loop below does not slice.
			// Truncating here puts the bound ahead of the parse-and-hash loop instead of inside it.
			parse: makeSnapshotParser(this.mergeSnapshotCaps()),
		});
```

Confirm `fetchNeighbors`' options bag in `src/rpc/neighbors.ts` accepts `timeoutMs` — every other
sender does, it is the same `rpcRequest` options shape — but check rather than assume.

### Edit 7 — `test/helpers/maintenance-rig.ts`

Two additions.

**(a) Per-(peer, protocol) behavior.** `PeerRig.behavior` is `Map<string, Behavior>` keyed by peer
id only, so it cannot express the headline case: a peer that answers `PROTOCOL_PING` and hangs
`PROTOCOL_NEIGHBORS`. The hook point is one line inside `PeerRig.open`, which already has
`protocol` in hand.

```ts
	/** `id + '|' + protocol` to behavior; consulted before the per-peer map. */
	readonly protocolBehavior = new Map<string, Behavior>()

	setProtocolBehavior(id: string, protocol: string, b: Behavior): void {
		this.protocolBehavior.set(`${id}|${protocol}`, b)
	}
```

In `open`, replace

```ts
		if ((this.behavior.get(id) ?? 'answers') === 'hangs') return hangsUntilAbort(opts, settle)
```

with

```ts
		const behavior = this.protocolBehavior.get(`${id}|${protocol}`) ?? this.behavior.get(id) ?? 'answers'
		if (behavior === 'hangs') return hangsUntilAbort(opts, settle)
```

Every current caller is unchanged — the per-peer map stays the fallback.

**(b) `setPhaseOneBudget`**, mirroring `setTickBudget` exactly: capture `originalPhaseOneBudget`
beside `originalTickBudget` at build time and restore both in the same `teardown`. Add it **only
if a test needs it** — the headline test runs at the real budgets and should not need it.

### Edit 8 — specs

**`test/stabilize-budget-invariants.spec.ts` (new).** Read the four private statics off
`FretService` (`(FretService as any).X`) and assert

- `MAINTENANCE_RPC_TIMEOUT_MS + MAINTENANCE_SNAPSHOT_TIMEOUT_MS <= STABILIZE_PHASE_ONE_BUDGET_MS`
- `STABILIZE_PHASE_ONE_BUDGET_MS + MAINTENANCE_RPC_TIMEOUT_MS <= STABILIZE_TICK_BUDGET_MS`

with failure messages naming which number moved. It must **not** use `buildMaintenanceRig` — that
rig mutates the tick budget. Assert against the declared defaults only.

**`test/stabilize-concurrency.spec.ts` (extend)**, both cases driving `(svc as any).stabilizeOnce()`
directly at the real, unmutated budgets:

- *Stalled snapshot.* One near peer with `setProtocolBehavior(id, rig.neighbors(), 'hangs')` (its
  ping still answers), plus at least one `dead` and one `unknown` peer seeded. Assert each phase-2
  peer sees exactly one `PROTOCOL_PING` per tick, on tick 1 **and** tick 2. Against HEAD: zero on
  both — run it against HEAD first and record in the handoff that it failed.
- *Unreachable near peer.* A peer whose ping hangs (plain per-peer `'hangs'` suffices) opens
  **zero** `PROTOCOL_NEIGHBORS` streams. Against HEAD: one.
- Wall clock: at the real budgets a hung phase 1 costs ~3 s per tick, so the stalled-snapshot case
  is ~6 s over two ticks. The validation command already passes `--timeout 30000`; keep it.

### Edit 9 — `docs/fret.md`

- *Stabilization and churn handling*, the **Two phases** bullet: the phase-1 sub-budget, phase 2's
  reserved slice, that phase 2 can no longer be starved by a phase-1 straggler, and that a near
  peer whose ping did not answer is not snapshot-fetched.
- *Stream management*, the per-call-site timeout override list: add the neighbor-snapshot fetch at
  `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` and record why it is *not* the route-sized default — that
  paragraph currently reads as if only `sendMaybeAct` is exempt.
- State the invariant and that `test/stabilize-budget-invariants.spec.ts` pins it.

### Facts confirmed this run — do not re-derive

- `maintenanceConcurrency` getter is at ~line 2174, Core 6 / Edge 2.
- `phaseTwoTargets` (~line 2347) already returns early off the three O(1) label counts; nothing in
  this ticket touches it.
- `nearProbeTargets` (~line 2244) slices to 4 dialable live members in ring order.
- The rig never starts the service, so `runSignal` is `undefined` and `deadline` accepts it. The
  phase-1 `deadline(PHASE_ONE, budget.signal)` is still a real child of the tick deadline.
- `rig.seedPeers` marks every peer `setAddressKnown` and `node.getConnections` is stubbed to return
  one open stub connection per peer, so every seeded peer is connected and `fetchNeighbors`
  (connection-only) is reachable at all.
- `hangsUntilAbort(opts, onSettle)` is exported from the rig and is what a hanging stream must use:
  it settles only on the caller's signal, so a hang under the new phase-1 sub-deadline ends when
  that child aborts.
- `per-tick-hotpath.spec.ts` sets the tick budget to 50 ms. The phase-1 deadline is a *child*, so
  it aborts with the parent and the phase budget is never the binding constraint there — confirm
  by running it rather than assuming.
