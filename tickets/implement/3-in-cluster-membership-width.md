----
description: A node decides whether it is close enough to a request's target to handle the request itself. That test is stricter than the design says, so nodes that should handle a request pass it along instead, costing extra network hops.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/in-cluster-width.spec.ts, docs/fret.md
difficulty: medium
----

## What is wrong

`FretService.routeAct` (`packages/fret/src/service/fret-service.ts:1914-1929`) decides "am I in
the cluster for this key?" like this:

```ts
const distIdx = this.neighborDistance(selfId, coord, Math.max(2, msg.want_k ?? this.cfg.k));
const inCluster = distIdx <= 1;
```

`neighborDistance` builds the key's alternating two-sided cohort and returns self's index in it
(`Infinity` if absent). `distIdx <= 1` therefore admits **only the two key-adjacent anchors** —
`successor(key)` and `predecessor(key)`.

`docs/fret.md` line 76 states a different test:

> Local membership test: peer p locally computes the alternating two-sided cohort using its S/P
> index and checks if p is within the first k (or wants) entries.

So a node at cohort index 3 for a key — a genuine cluster member by the documented rule —
forwards instead of acting. When the arriving message already carries an activity payload, that
is a hop the sender never budgeted for: the payload was attached because `shouldIncludePayload`
judged the sender near enough that the receiver would act
(`packages/fret/src/service/payload-heuristic.ts`).

## Resolution (settled — no open options)

Widen the acting condition to the documented window, and update the doc where it still describes
the narrow behavior.

### The membership window

```ts
/**
 * The doc's local membership test: self is in-cluster for a message when it appears among the
 * first `window` entries of the key's alternating two-sided cohort.
 *
 * `wants` is the caller's staged/partial-cohort ask and is capped at `want_k`, per the wire
 * contract (`wants ≤ k`), so a malformed message cannot widen the window past the cluster the
 * sender asked for.
 *
 * The floor of 2 keeps both key-adjacent anchors acting even for a degenerate `want_k` of 0 or
 * 1; without it nobody would consider itself in-cluster and the message would forward until TTL
 * ran out. It also preserves today's behavior as a strict lower bound — this change only ever
 * widens the window, never narrows it.
 */
private inClusterWindow(msg: RouteAndMaybeActV1): number {
	const k = msg.want_k ?? this.cfg.k;
	return Math.max(2, Math.min(msg.wants ?? k, k));
}
```

and at the call site:

```ts
const window = this.inClusterWindow(msg);
const inCluster = this.neighborDistance(selfId, coord, window) < window;
```

`neighborDistance` returns `Infinity` when self is absent from a cohort of that size, so
`< window` is exactly "self appears among the first `window` entries" — the doc's
`isInCluster(self, key, k)` pseudo-code in *Cohort assembly algorithm*. Keep `neighborDistance`'s
public signature (it is exported through `src/index.ts:103` and
`src/service/libp2p-fret-service.ts:107`); this ticket adds no public API.

### What deliberately does **not** change

- **The acting cohort stays `want_k`-wide.** `routeAct` line 1921 keeps
  `this.assembleCohort(coord, msg.want_k ?? this.cfg.k)`. The cohort exists to gather
  `min_sigs` signatures, and `min_sigs` is derived from the full `k`; `wants` narrows *who acts*,
  not *how many peers the actor gathers*. Note the asymmetry in a comment at that line so a
  later reader does not "fix" it into `wants`.
- **No new fan-out.** A receiver either acts or forwards to exactly one hop — never both — so
  widening the window cannot amplify a message. It strictly *reduces* hops: a peer that used to
  forward now answers. The one path that sends the same activity to more than one peer is
  `iterativeLookup`'s resend-to-anchor (`fret-service.ts:2356-2361`), which is unchanged and, if
  anything, triggers less often because the first probed peer is now more likely to act outright.
- **Duplicate work is still blocked by the existing dedup cache** (correlation id + phase). This
  change does not touch it.
- **`want_k` remains attacker-influenced and unclamped.** It already sizes two ring walks at
  `routeAct` lines 1915/1921 today, and every walk is capped at the store size (C = 2048), so this
  is not new exposure. Park it as a tripwire comment at `inClusterWindow`, not a ticket:
  `// NOTE: want_k is caller-supplied and sizes this walk; bounded today only by the store size
  (C = 2048). If inbound maybeAct ever needs a tighter per-message cost bound, clamp want_k to a
  profile maximum here.`

### Why the next-hop strict-improvement floor still holds

`docs/fret.md` line 118 argues that withholding a backwards hop on the forwarding path costs
nothing, because a forwarding node "sits at index ≥ 2 of the key's alternating two-sided cohort,
which puts at least one peer strictly closer to the key than it is." Widening only strengthens
that: a node now forwards when its index is ≥ `window` (≥ 2 by the floor), i.e. with *more* peers
ahead of it, not fewer. The doc sentence needs its constant updated, not its argument.

### Doc edits (`docs/fret.md`)

- **Routing rule, item 1** (~line 96, "If local membership test says 'in-cluster'"): state the
  window explicitly — self within the first `min(wants ?? want_k, want_k)` cohort entries, floored
  at 2 so the two key-adjacent anchors always act. Say in one sentence that this is deliberately
  wider than the anchor pair: the payload-inclusion heuristic attaches an activity because the
  sender judged the receiver near enough to act, so a cluster member that forwards spends a hop
  the sender never budgeted for.
- **Line 118** (next-hop heuristic): change "it sits at index ≥ 2 of the key's alternating
  two-sided cohort" to "it sits at index ≥ the membership window (≥ 2) of the key's alternating
  two-sided cohort".
- **Line 76** (*Determining cluster membership*) is already correct; append only the floor-of-2
  note and the `wants ≤ k` clamp so the doc and the code state the same rule end to end.
- Do **not** restate the design essay in the source. The code carries the short "why", the doc
  carries the argument.

## Edge cases & interactions

- **`n < k` (small ring).** The cohort walk yields `min(n, window)`, so on a 3-node ring every
  started node is in-cluster and acts locally. That is the documented behavior ("Handling n < k:
  the alternating walk yields min(n, k); quorum adapts automatically"), and it means integration
  specs on small meshes will see `maybeActForwarded` drop, often to 0.
  `test/libp2p-memory.integration.spec.ts:348-355` asserts forwarded hops are *at most* a bound,
  so it still passes; confirm rather than assume.
- **Self absent from the store.** A service that never ran `start()` has no self entry, so
  `neighborDistance` returns `Infinity` and the node is out-of-cluster on every key — unchanged,
  and `test/pick-anchors.spec.ts:159-170` depends on it.
- **`want_k: 2` callers.** `test/dialability.spec.ts:184` and `:238` pass `want_k: 2`, so their
  window stays 2 and their forwarding assertions must still hold. They are the regression guard
  that this change did not silently widen the narrow case too.
- **`wants` narrower than `want_k`.** `wants: 2, want_k: 7` must keep the window at 2, not 7.
  `test/route.maybeact.integration.spec.ts:29-31` sends exactly this shape.
- **`want_k` of 0, 1, or absent.** The floor of 2 must keep both anchors acting; without it a
  `want_k: 0` message forwards until TTL expires and the activity is silently lost.
- **`wants` larger than `want_k`** (malformed sender): clamped down to `want_k`, never widening
  past the requested cluster.
- **In-cluster, activity present, no handler installed.** Still returns the NearAnchor refusal
  (`routeAct` line 1927) and is still not cached — the "only a terminal answer is cached" rule in
  `handleMaybeAct` is untouched. Widening means *more* peers can reach this arm, so confirm the
  refusal path is exercised at a non-anchor cohort index.
- **Store/selector coordinate agreement.** The in-cluster test reads self's *store* entry while
  the forwarding floor reads `selfCoord()` (the hashed peer id). Any spec that seeds self must
  seed it at `hashPeerId(node.peerId)`, not a fabricated coordinate — see the comment at
  `test/dialability.spec.ts:202-210` for the flake this prevents.
- **Digest-only probes now terminate earlier.** A probe reaching a cohort-index-5 node answers
  with that node's `buildNearAnchor` instead of forwarding to an anchor first. The anchors are
  still measured against the key coordinate (`pickAnchors`), and a cohort member has a good view
  of the key's neighborhood, so hint quality is preserved; the win is one fewer round trip.
- **Concurrency.** `inClusterWindow` is pure over the message and `cfg`; it adds no state and no
  ordering constraint against the inflight/rate-limit guards in `handleMaybeAct`.

## TODO

- Add `private inClusterWindow(msg: RouteAndMaybeActV1): number` to `FretService` next to
  `routeAct`, with the doc comment and the `want_k` tripwire `NOTE:` above.
- Replace the `distIdx <= 1` gate in `routeAct` (`fret-service.ts:1914-1916`) with the window
  test; keep the `neighborDistance` call (it is the doc's membership test) rather than reaching
  into `assembleCohort` directly.
- Add a one-line comment at `routeAct`'s `assembleCohort(coord, msg.want_k ?? this.cfg.k)` call
  explaining why the acting cohort stays `want_k`-wide while the membership window honours
  `wants`.
- New spec `packages/fret/test/in-cluster-width.spec.ts`. Build an unstarted `FretService`
  (no timers), seed self at `await hashPeerId(node.peerId)` as a `member`, and push self to a
  chosen cohort index by seeding ghost members at `ringOffset(keyCoord, ±1…±d)` — a random self
  coordinate is essentially never within a handful of ring units of the key, so `d` ghosts put
  self at index `d`. Reuse the `seedMember` / `ghostPeerId` / `countDials` patterns from
  `test/dialability.spec.ts:26-50` and `ringOffset` from `test/helpers/ring.ts`. Cover:
  - self at cohort index 3, `want_k: 7`, activity + handler installed → handler fires exactly
    once, `getDiagnostics().maybeActForwarded === 0`, no dials. (This is the regression witness:
    it fails on the old `distIdx <= 1` gate.)
  - self at cohort index 3, `want_k: 7`, no activity → NearAnchor with non-empty anchors, handler
    never called, no forward.
  - self at cohort index 8, `want_k: 7`, activity + handler → handler **not** called (out of
    cluster); the ghosts are undialable so the result is the NearAnchor fallback.
  - self at cohort index 3, `want_k: 7`, `wants: 2`, activity + handler → handler **not** called;
    `wants` narrows the window.
  - self at cohort index 1, `want_k: 1`, activity + handler → handler fires; the floor of 2 keeps
    both anchors acting.
  - `wants: 99, want_k: 3`, self at cohort index 5 → handler **not** called; `wants` is clamped to
    `want_k`.
- Apply the three `docs/fret.md` edits listed above.
- Run `cd packages/fret && npx tsc --noEmit` and `yarn test` in the foreground (no redirection).
  Pay attention to `dialability.spec.ts`, `route.maybeact.integration.spec.ts`,
  `iterative-lookup.spec.ts`, `maybeact-dedup-phases.spec.ts`, `payload-bounds-ttl.spec.ts` and
  `libp2p-memory.integration.spec.ts` — they are the specs whose ring is small enough for the
  wider window to change which node acts.
