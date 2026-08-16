description: A node now handles a request itself whenever it is close enough to the target by the documented rule, instead of using a stricter test that made it pass work along and burn an extra network hop.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/in-cluster-width.spec.ts, docs/fret.md
difficulty: medium
---

## What changed

`FretService.routeAct` decided "am I in the cluster for this key?" with `distIdx <= 1`, which
admits only the two peers immediately adjacent to the key on the ring. `docs/fret.md` describes a
wider rule — self within the first `k` (or `wants`) entries of the key's alternating two-sided
cohort. The code now implements the documented rule.

### Code (`packages/fret/src/service/fret-service.ts`)

- **New private `inClusterWindow(msg)`** (line ~1921): `Math.max(2, Math.min(msg.wants ?? k, k))`
  where `k = msg.want_k ?? this.cfg.k`. Carries the doc comment plus the `want_k`-is-unclamped
  tripwire `NOTE:` (parked as a comment, not a ticket — see *Tripwires* below).
- **Call site** (line ~1940-1941): `const window = this.inClusterWindow(msg);` then
  `const inCluster = this.neighborDistance(selfId, coord, window) < window;`. `neighborDistance`
  returns `Infinity` when self is absent from a cohort of that size, so `< window` is exactly
  "self appears among the first `window` entries".
- **Comment at the acting-cohort call** (line ~1946-1949): the cohort stays `want_k`-wide even
  when `wants` narrowed the window, because `min_sigs` derives from the full k. No behavior change
  there — the comment exists so a later reader does not "fix" it into `wants`.
- No public API change. `neighborDistance`'s signature is untouched (it is exported through
  `src/index.ts:103` and `src/service/libp2p-fret-service.ts:107`).

### Docs (`docs/fret.md`)

- *Determining cluster membership* bullet: appended the exact window formula, the `wants ≤ k`
  clamp, and the floor-of-2 rationale.
- Routing rule item 1: states the window inline, adds a sub-bullet on why it is deliberately wider
  than the anchor pair (the payload heuristic already judged the receiver near enough to act), and
  notes that the acting cohort stays `want_k`-wide.
- Next-hop heuristic bullet: "index ≥ 2" → "index ≥ the membership window (≥ 2)". The argument is
  unchanged and in fact strengthened — a node now forwards with *more* peers ahead of it.

## Validation performed

- `npx tsc --noEmit` from `packages/fret/` — clean.
- `yarn build` — clean.
- `yarn test` — **534 passing, 0 failing.** No pre-existing failures surfaced;
  `tickets/.pre-existing-error.md` was not written.
- New spec `packages/fret/test/in-cluster-width.spec.ts` — 10 passing.

### The witnesses actually discriminate (verified, not assumed)

Reverting only the gate to `<= 1` and re-running the new spec fails **3** of its 10 tests:

- `acts locally at cohort index 3 of a want_k 7 cluster`
- `answers a digest-only probe itself at cohort index 3 rather than forwarding`
- `returns the NearAnchor refusal in-cluster with no handler installed`

The other 7 are guards on what must *not* change (the floor of 2, the `wants` clamp, the
out-of-cluster edge, cohort width, self-absent), so they pass under both gates by design.

**A subtlety worth knowing when editing this spec.** The first draft of the digest-probe and
no-handler tests did *not* discriminate: with only undialable ghost peers in the store, an
out-of-cluster node finds no reachable hop and *also* answers with a NearAnchor, so both gates
produced an identical reply. Both tests now seed a genuinely dialable decoy peer (helper
`seedDialableDecoy`, ring offset +3 from the key, cohort index 4, so self's index is unchanged)
and assert `maybeActForwarded === 0` and zero dials. If you add a test to this file, check it
against the reverted gate rather than trusting a green run.

## Use cases to exercise / re-verify

The spec is a floor, not a ceiling. Concrete things a reviewer can drive:

- **Cohort index 3, `want_k: 7`, activity + handler.** Handler fires exactly once,
  `getDiagnostics().maybeActForwarded === 0`, zero dials. This is the bug the ticket describes.
- **Cohort index 8, `want_k: 7`.** Still out-of-cluster; handler never called.
- **`wants: 2, want_k: 7` at index 3.** Handler not called — `wants` narrows the window.
- **`wants: 99, want_k: 3` at index 5.** Handler not called — `wants` is clamped down to `want_k`.
- **`want_k: 1` and `want_k: 0` at index 1.** Handler fires — the floor of 2 keeps both
  key-adjacent anchors acting. Without it a `want_k: 0` message forwards until TTL expires and the
  activity is silently lost.
- **`wants: 2, want_k: 7` at index 1 with 6 ring members.** Handler fires and the cohort handed to
  it has 7 entries, not 2.
- **In-cluster, activity present, no handler installed.** Still the NearAnchor refusal, still not
  cached (the "only a terminal answer is cached" rule in `handleMaybeAct` is untouched).
- **Self absent from the store** (service never `start()`ed). `neighborDistance` returns `Infinity`
  → out-of-cluster on every key. `test/pick-anchors.spec.ts:159-170` also depends on this.

### Interaction specs checked

All pass in the full run; these are the ones whose ring is small enough for the wider window to
change which node acts:

- `dialability.spec.ts` — its two `routeAct` specs pass `want_k: 2`, so their window stays 2 and
  they are the regression guard that the narrow case did not silently widen.
- `route.maybeact.integration.spec.ts` — sends `wants: 2, want_k: 7`, the narrowing shape.
- `libp2p-memory.integration.spec.ts:348-355` — asserts total forwarded hops is **at most** a
  bound, so a drop in forwarding passes. Confirmed by running it, not by reading it.
- `iterative-lookup.spec.ts`, `maybeact-dedup-phases.spec.ts`, `payload-bounds-ttl.spec.ts` —
  unchanged and passing.

## Known gaps / where to push

Flagged honestly rather than papered over:

- **No spec asserts the hop *reduction* end-to-end on a real mesh.** Every new test drives
  `routeAct` directly on an unstarted service with a hand-seeded store. That is deterministic and
  fast, but it means the claimed win ("strictly fewer hops") is argued rather than measured. The
  integration bound in `libp2p-memory.integration.spec.ts` is one-sided (`at most`), so a
  reduction would not be observed there either. A reviewer wanting proof could add a lower-bound
  or before/after comparison on a mesh — noting the ticket's own warning that on a small mesh
  `maybeActForwarded` can legitimately drop to 0.
- **Ghost-index seeding is arithmetic, not asserted.** `seedGhostsBefore` places `d` ghosts so
  self lands at cohort index `d`, relying on self's hashed coordinate being uniformly random and
  therefore never within a handful of ring units of the key. It is correct (and stable across
  runs, since peer ids are generated per-run and the argument does not depend on the draw), but
  no test asserts self's index directly via `neighborDistance` before exercising `routeAct`. Adding
  that premise assertion would make a future breakage point at the seeding rather than the gate.
- **`want_k: 0` behavior beyond the gate.** The floor keeps such a message in-cluster, and the
  acting cohort then assembles as `assembleCohort(coord, 0)` → an **empty** cohort handed to the
  activity handler. The new spec only asserts the handler fires. Whether an empty cohort is the
  right thing to hand a handler that must gather `min_sigs` signatures is out of this ticket's
  scope and unchanged by it, but it is now reachable by more peers than before.
- **The digest-probe hint-quality claim is untested.** The ticket argues a cohort-index-5 node's
  `buildNearAnchor` is as good a hint as an anchor's, because `pickAnchors` measures against the
  key coordinate. The new spec asserts only that anchors are non-empty, not that they are the same
  anchors a key-adjacent node would return.

## Tripwires parked (not tickets)

- **`want_k` is caller-supplied and unclamped**, sizing this ring walk. Parked as a `NOTE:` in the
  `inClusterWindow` doc comment. Not new exposure — `want_k` already sized two ring walks at this
  call site, and every walk is capped at the store size (C = 2048). Trips if inbound `maybeAct`
  ever needs a tighter per-message cost bound.
