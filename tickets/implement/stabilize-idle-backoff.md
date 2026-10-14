description: FRET's background upkeep runs every 1.5 seconds forever, even when nothing in the network has changed for minutes, which keeps idle phones busy and slow. Let the interval double while things are stable, up to a host-settable ceiling (60 s by default), and snap back to 1.5 s the moment anything changes.
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/idle-backoff.ts (new), packages/fret/src/service/fret-service.ts (startStabilizationLoop, runStabilizationPass, stabilizeOnce, phaseTwoTargets, noteDiscovered, applyMembershipSignal, applyContactStrike, noteProofOfLife, setAddressKnown, readPeerStore, ingestAddressHints, handleAnnounce / mergeAnnounceSnapshot, handleLeave, noteInboundRpc, peer:connect / peer:disconnect listeners, setMode, importTable, stop, clearLoopTimers, constructor, diag), packages/fret/src/index.ts (FretConfig), packages/fret/src/service/near-exchange.ts (NEAR_PROBE_MAX_SKIPS comment), packages/fret/test/idle-backoff.spec.ts (new), packages/fret/test/near-exchange.spec.ts, packages/fret/test/address-less-departure.spec.ts, packages/fret/test/service-lifecycle.spec.ts, docs/fret.md, AGENTS.md
difficulty: hard
----
Reported as gotchoices/Fret#2 (p2p-fret 1.0.2, via sereus on phones over a circuit relay); this is the reporter's suggestion 1. `stabilize-skip-redundant-near-exchange` (landed) made each pass cheap on an idle strand; this ticket makes passes rare when they would find nothing. Both prerequisites the plan ticket named (`maintenance-redial-off-the-tick`, `stabilize-skip-redundant-near-exchange`) have landed.

## The design, settled

### Policy: one small clock-free class

`src/service/idle-backoff.ts` exports `IdleBackoff`, a pure state machine with no timer and no clock, so it is unit-testable without sleeps and the loop in `fret-service.ts` stays a thin scheduler.

```ts
export class IdleBackoff {
	constructor(opts: { baseMs: number; capMs: number });   // effective cap = max(capMs, baseMs)
	readonly baseMs: number;
	readonly capMs: number;
	/** The delay the next pass will be armed at. Starts at baseMs. */
	get delayMs(): number;
	/** Consecutive passes that found nothing; 0 after any change. Diagnostics only. */
	get quietPasses(): number;
	/** Something the next pass could act on happened (during or between passes). Resets delayMs to baseMs. */
	noteChange(): void;
	/** Open a pass: snapshot the change counter, clear the pending flag. */
	beginPass(): void;
	/** This pass left work pending (see "pending" below): hold at baseMs, but it is not a change. */
	notePending(): void;
	/** Close the pass and return the delay to arm: baseMs if a change landed since beginPass or the pass is pending, else min(delayMs * 2, capMs). */
	endPass(): number;
	/** A run ended: back to baseMs, nothing pending, quiet count 0. */
	reset(): void;
}
```

Internals: a monotonic change counter bumped by `noteChange`, the counter value captured by `beginPass`, a per-pass `pending` flag, and `delay`. `endPass` compares the counter with the captured value, so a change that lands *during* a pass is seen at that pass's end with no flag to clear at the right moment, and a change that lands *between* passes is handled by the service's wake path (below). `noteChange` also sets `delay = baseMs` immediately, which is what the wake path reads.

Doubling from the base gives 1.5 → 3 → 6 → 12 → 24 → 48 → 60 s: the seventh quiet pass reaches the default cap, about 95 s after the last change, and from then on the loop runs about one pass a minute.

### Constants and config

- `FretService.PASSIVE_INTERVAL_MS = 1500` and `FretService.ACTIVE_INTERVAL_MS = 300` as statics beside the budget statics, replacing the two literals in `startStabilizationLoop`. Active mode is unchanged: 300 ms, never backed off.
- `FretConfig.maxPassiveIntervalMs?: number` — the ceiling the passive interval may grow to while nothing changes. Default 60 000 ms. Validated with `requirePositiveMs` exactly like `dialTimeoutMs` (the constructor throws on a non-positive or non-finite value). A value at or below `PASSIVE_INTERVAL_MS` disables backoff (the effective cap is `max(value, base)`), which is the host's off switch and needs no boolean. Document the field in `index.ts` in the same voice as `dialTimeoutMs`.
- Why 60 s and not 30 s: the two costs the cap trades are stated below (silent loss about 4 min worst case, content re-check about 4 min), and both are bounded by things that are not this loop: libp2p's connection monitor (on by default in libp2p 3.x: it pings every connection every 10 s and aborts the connection on failure, so a half-open connection becomes a `peer:disconnect` — a reset trigger — on stock hosts) and announces, which carry membership changes without waiting for a pass. 30 s would halve both numbers and double the idle pass rate; the reporter's phones are the case to optimise for.

### The loop

`startStabilizationLoop` keeps its shape (generation guard at the top of the tick, re-check after the awaits, `firstStabilizeDone` / `ready()` on the first pass) and changes only how it arms:

- The pass body is `runStabilizationPass()`, which now brackets the work with `idle.beginPass()` first and `idle.endPass()` last and **returns the settled delay**, so a hand-driven `runStabilizationPass()` (as `test/per-tick-hotpath.spec.ts` already does) exercises the policy and a hand-driven `stabilizeOnce()` (as most specs do) bypasses it, exactly as today. `stabilizeOnce` stays `Promise<void>`; it reports pending work through `idle.notePending()`, not a return value (many specs stub it as `async () => {}`).
- After the pass: `delay = this.mode === 'active' ? ACTIVE_INTERVAL_MS : settled`. Arm through one closure, `armLoop(delay)`, created per run inside `startStabilizationLoop` (captures `gen`, refuses to arm when `gen !== this.runGen || this.stopped`), stored on the service together with the delay it armed (`stabilizeTimerDelayMs`). `clearLoopTimers` nulls the closure and the timer as it does today.
- **Wake path** — `private wakeLoop()`: called right after every `noteChange()` and from `setMode`. Target = `mode === 'active' ? ACTIVE_INTERVAL_MS : idle.delayMs` (which `noteChange` has just set to the base). If a timer is armed (`stabilizeTimer != null`) at a delay greater than the target, clear it and `armLoop(target)`. If no timer is armed a pass is in flight; its `endPass` sees the change and arms at the base itself. If the armed delay is already at or below the target, nothing happens. A change therefore never waits out a long timer.
- **Re-arm at the base, never run a pass at once.** Events arrive in bursts (`peer:connect`, then `peer:identify`, then several `peer:update`s); a pass per event would be a pass storm, the base interval is the natural debounce, and a pass may already be in flight. This preserves today's bounds exactly: after a `peer:disconnect` the next pass is at most 1.5 s away, as it is now.
- `stop()`: `idle.reset()` beside the other run-scoped clears, so a start→stop→start cycle begins at the base. The run-generation guard is unchanged; what is new is that a timer is now often tens of seconds long, so the `gen` check inside `armLoop` and the `clearLoopTimers` in `stop()` are what stop a stale long timer resurrecting a loop — verify by inspection; the existing lifecycle specs already cover a mid-tick `stop()`.
- `setMode(mode)`: set the mode, `idle.noteChange()`, `wakeLoop()`, then the existing active-loop arming. Switching to active cuts a pending 60 s timer to 300 ms; switching back to passive starts the ladder at 1.5 s.

### What counts as a change — one seam each

A **change** is anything the next pass could act on. Every site below calls one private `noteChange(reason: string)` on the service (`idle.noteChange()` + `wakeLoop()` + one `log(...)` line naming the reason — the log is the only way to see on a phone why the loop woke). No site anywhere else resets the delay.

| Site | When it counts |
|---|---|
| `noteDiscovered` | returned `true` (an entry was created) — covers every hearsay path: both snapshot merges, leave replacements, the bootstrap seed, `peer:update` / `peer:identify` creating an entry |
| `peer:connect` listener | always |
| `peer:disconnect` listener | always — **load-bearing**, see the departure case below |
| `noteInboundRpc` | when it upserted a new entry (an RPC from a stranger); an RPC from a peer already held is judged by the seams below, so an idle neighbour's periodic ping is not a change |
| `applyMembershipSignal` | when it actually wrote: a label change, or a negotiate strike that progressed a run. A peer already `foreign` at the threshold failing again writes nothing new and does not count |
| `applyContactStrike` | when the strike progressed a run: the peer was not already `dead` before the write. A strike on an already-dead peer (the dead arm re-probing it) does not count — the peer is backed off, there is nothing to act on, and counting it would reset the delay on every dead-arm probe forever |
| `noteProofOfLife` | when it wrote (a run cleared, or `dead` revived) |
| `setAddressKnown` | when the id's membership in the set actually flipped **and** the store holds the id — `peer:update`, `peer:identify`, an accepted hint, an imported record |
| `readPeerStore` (the backstop rebuild) | when the rebuilt set differs from the old one on any id the store holds (compute the difference against `this.store.getById` once, after the swap) |
| `ingestAddressHints` | when `consumePeerRecord` returned `true` (a newer record for a held peer — its addresses changed, so dialability may have) |
| `handleAnnounce` → `mergeAnnounceSnapshot` | always: an announce is sent only when the sender saw a join or departure, and it is never periodic |
| `handleLeave` | always (it marks the sender `dead` anyway) |
| `importTable` | always |
| `setMode` | always |

Deliberately **not** changes: scoring writes (`applyTouch`, `applySuccess`, `applyFailure` — relevance, latency, counters), `backoff.record`, `nearExchange` stamps, an inbound RPC from a live member, a near ping that answered as expected, a fetch whose merge discovered nothing (a digest mismatch alone is not a change: on a quiet large ring the sample set can flap and the digest with it — see the `NOTE:` in `snapshotDigest` — and only what the merge *found* matters), capacity evictions (they follow inserts, which already counted), outbound announces.

Why there is no "inbound RPC from a non-member" row: a stranger creates an entry (row 4); an `unknown` or `foreign` caller is promoted by `applyMembershipSignal('rpc-inbound')` (row 5); a `dead` caller is revived by `noteProofOfLife` (row 7). The three rows together are that rule.

### What counts as pending — hold at the base without a change

`stabilizeOnce` calls `idle.notePending()` when the pass has work whose outcome no event will announce:

- **Phase 2 selected at least one target** (`phaseTwoTargets()` returned non-empty). This is deliberately the *selection*, not the label counts: a ring that has ever lost a phone ungracefully holds a `dead` entry until capacity evicts it (capacity 2048, so on a small network never), and "a dead peer exists" would mean the loop never backs off again. Selection is empty whenever every off-ring peer is inside its backoff window, so the loop sleeps over those windows. Consequence to state in the docs: a `dead` or `foreign` peer whose window (at most 32 s) expires during a backed-off interval is re-probed up to one interval late — at the default cap, recovery of a peer that comes back but never dials us takes at most about 92 s instead of about 33 s. Acceptable: a returning peer normally dials us (`peer:connect`, a change) or pings us (an inbound RPC from a `dead` peer revives it, a change); the dead arm is the path for one that does neither. The alternative the plan ticket offered — sleep until the earliest per-peer backoff expiry — was rejected: it needs a second store walk per pass to find the minimum, to protect a path whose latency is already bounded by the cap.
- **A maintenance redial is in flight at the end of the pass** (`this.redials.size > 0`, checked in `runStabilizationPass` before `endPass`). A slow relayed dial outlives the pass; while it runs the loop holds at the base so the pass after it settles follows up within 1.5 s. No "redial started" or "redial settled" trigger is needed: a dial that connects fires `peer:connect`, a dial that fails books a strike through `applyContactStrike` (a change when it progresses a run, not when the peer is already dead), and a cancelled dial is a `stop()`.

Members the near pass struck as uncontactable progress a run (a change) until they are `dead` and leave the window, so they need no pending rule.

### Diagnostics

`diag.loop = { delayMs: PASSIVE_INTERVAL_MS, quietPasses: 0 }`, written by the loop after each `endPass` (and set back to the base by `stop()`), so a host can see the loop idling. The diag object is live; follow the existing counters' style and document both fields where the object is declared.

## Edge cases & interactions

- **Address-less departure on a backed-off loop.** The departed phone's connection drop is a `peer:disconnect` → change → the next pass is at most 1.5 s away → it strikes (a change, since the run progressed) → two more passes at the base → `dead` in 3–4.5 s, exactly today's bound. The reset at `peer:disconnect` is what keeps that bound, not an optimisation. Pinned by the new case in `test/address-less-departure.spec.ts` (below). The docs bullet that quotes "3–4.5 s" must say why it still holds.
- **Silent loss with no disconnect event** (a half-open relay circuit on a host that disabled libp2p's connection monitor). Detected only by the probes: one skipped pass plus three striking passes = four backed-off intervals, so at the default cap about 4 minutes worst case. State this number in `docs/fret.md` beside the libp2p-monitor fact above. Not capped separately: a host that wants faster detection sets `maxPassiveIntervalMs` lower.
- **Content re-check cadence.** The near-exchange skip cap forces a ping at least every fourth pass, so an unchanged-digest neighbour is re-fingerprinted every ~4 minutes at the cap unless an announce arrives first; restate the "6 s at the passive interval" sentence in the near-exchange docs bullet and in the `NEAR_PROBE_MAX_SKIPS` comment as "6 s at the base interval, about 4 min at the default cap".
- **Two idle phones must actually reach the cap.** Trace, for the implementer and the reviewer: A's pass pings B at most every fourth pass (`ok`, same digest → fetch skipped) — `applySuccess` writes scores only, `applyMembershipSignal` is already settled, nothing counts. B's pings land on A as inbound RPCs from a live member — `applyMembershipSignal('rpc-inbound')` returns before writing, `noteProofOfLife` patches nothing, nothing counts. Phase 2 selects nothing (both are `member`). No redials (connected). So every pass is quiet and the ladder climbs to the cap. Pinned by the new case in `test/near-exchange.spec.ts`.
- **A `peer:update` for a held peer** (tags, protocols re-advertised, a re-fired identical envelope) writes nothing through the seams above and so is not a change — which matters because libp2p fires `peer:update` for every peerStore write, including FRET's own `consumePeerRecord`.
- **Spacing guards** (500 ms contact- and negotiate-failure spacing) only become more satisfied as passes spread out. Verified by inspection: no spec asserts a pass count inside a wall-clock window except `service-lifecycle.spec.ts`'s cadence cases, where the stubbed pass is quiet, so the tick count over 3.4 s becomes 2 (t = 0, 1.5, then 4.5) and the `at.most(3)` assertion still holds — update its comment to say the second re-arm is already backed off.
- **Run-scoped housekeeping that rides the pass**, at a 60 s cap: `ProbeBackoff.sweep` (5-min retention, capacity-bounded — a late sweep delays slot reclamation only); the departure-debounce map (`ExpiringMap.get` drops an expired entry on read, so a late sweep changes nothing observable); the store-membership prunes of `backoff` and `nearExchange` (stale entries for evicted peers linger at most 60 s, bounded by table membership); `enforceCapacity` (listener inserts are changes, so the untrimmed window stays one base interval, unchanged); `ready()` (resolves after the first pass, which runs immediately at `start()`, unchanged); the peerStore backstop (at most 60 s late against a 1 h clock, already stated in the docs); size-estimate recency (computed on read in `SizeObserver`, not tick-driven). Say so in one docs sentence.
- **Off-ring re-probe cadence** — covered under *pending* above; state the up-to-one-interval lateness in the docs' re-probe bullet.
- **Lifecycle.** `stop()` → `clearLoopTimers` (clears the long timer and nulls `armLoop`), `idle.reset()`. A change arriving after `stop()` reaches `wakeLoop`, which checks `this.stopped` first. A stale `armLoop` closure from a previous run refuses on the `gen` check. `start()` after `stop()` begins at the base because `reset()` ran.
- **Multiple services per node** back off independently; no shared state.
- **A change during a pass that is itself quiet** — e.g. a `peer:connect` landing while phase 2 is pooled: `endPass` sees the counter moved and arms at the base. The wake path finds no timer (the pass is in flight) and does nothing. Both halves agree because `noteChange` sets `delay` to the base before either reads it.
- **Active mode**: `endPass` still runs (so the quiet count and `diag.loop` stay meaningful) but the loop arms at `ACTIVE_INTERVAL_MS` regardless; `setMode('passive')` is a change and starts the ladder from the base.

## Tests

Three, each pinning one behaviour; no test of wiring.

- **`test/idle-backoff.spec.ts`** (new, pure): the ladder doubles to the cap and holds there; `noteChange` between `beginPass`/`endPass` pairs arms the base; `noteChange` *inside* a pass makes that pass's `endPass` return the base; `notePending` holds the base; a cap at or below the base returns the base forever. One `it` per row.
- **`test/near-exchange.spec.ts`**, new case beside the two-node idle strand: construct both members with a small `maxPassiveIntervalMs` (12 000, so four quiet passes reach it); after the warm-up passes, drive `runStabilizationPass()` alternately on both sides and assert `diag.loop.delayMs` reaches the cap on **both** sides; then make a real change on B's side only — a third node connecting to B (`peer:connect`) — and assert B's delay is back at the base while A's is still at the cap. This is the reproduction of the issue's claim and the proof that a neighbour's periodic ping does not reset the receiver.
- **`test/address-less-departure.spec.ts`**, new case: a libp2p-hosted dial-only FRET phone (the second existing case's setup) connected to a **started** observer constructed with `maxPassiveIntervalMs: 30_000`; stub the observer's `handleLeave` to a no-op so `dead` can come only from the strike path (the mirror of the existing case that pushes `deadAfterFailures` out of reach); wait until the phone is a live member on the observer; push the observer's `idle` to the cap by hand (`beginPass(); endPass()` until `delayMs === 30_000`) and `waitFor` the armed timer delay (`stabilizeTimerDelayMs`) to read 30 000 after the next natural pass — re-push inside the predicate if a late settling event reset it once; then `a.stop()` and `waitFor` the entry to read `dead` within 8 s. Without the reset the first strike is 30 s away and the bound reddens; with it, 3–4.5 s as today. Record the mutation in the spec header like the existing cases do.

## Docs

`docs/fret.md`, *Stabilization and churn handling*: a new top-level bullet "**The passive interval backs off while nothing changes**" carrying the ladder, the cap and its config field, the change/pending rules in prose (point at the seams, do not restate the table), the re-arm-not-run decision, the two-phone trace, and the worst-case numbers (silent loss about 4 min, content re-check about 4 min, off-ring re-probe up to one interval late) beside the libp2p connection-monitor fact. Restate: the "3–4.5 s" bullet; the near-exchange "6 s" sentence; the foreign-arm saturation arithmetic ("at the base interval"); *Configuration* ("Stabilization period Ts: 1.5 s passive base, doubling to `maxPassiveIntervalMs` (60 s) while nothing changes; 300 ms active"); the A6 bullet (jitter is still not done; say backoff is). `AGENTS.md`: add `service/idle-backoff.ts` to the layout.

## Measuring success

The reporter offered to re-measure on the same two phones: on an idle two-member strand, passes should fall from ~20/min to ~1/min within about two minutes of the last change, and `diag.loop.delayMs` should read 1500 within one pass of a `peer:connect` or `peer:disconnect`.

## TODO

- Add `src/service/idle-backoff.ts` with `IdleBackoff` as specified; not exported from the package root (internal).
- Add `PASSIVE_INTERVAL_MS` / `ACTIVE_INTERVAL_MS` statics; replace the literals in `startStabilizationLoop`.
- Add `FretConfig.maxPassiveIntervalMs` (default 60 000, `requirePositiveMs`, effective cap `max(value, PASSIVE_INTERVAL_MS)`); construct `idle` in the constructor.
- Refactor the loop: `armLoop` closure + `stabilizeTimerDelayMs`; `runStabilizationPass` brackets with `beginPass` / pending-redial check / `endPass` and returns the delay; `wakeLoop`; `clearLoopTimers` and `stop()` updates; `setMode` wiring.
- Add `noteChange(reason)` on the service and call it from the fourteen seams in the table, each guarded as the table says (write actually happened, flip actually happened, not already dead).
- `stabilizeOnce`: `idle.notePending()` when `phaseTwoTargets()` is non-empty.
- `diag.loop` with doc comments.
- Tests: `idle-backoff.spec.ts`, the two new cases, the lifecycle comment update.
- `docs/fret.md` and `AGENTS.md` as above; the `NEAR_PROBE_MAX_SKIPS` comment in `near-exchange.ts`.
- `cd packages/fret && npx tsc --noEmit && yarn test` in the foreground.
