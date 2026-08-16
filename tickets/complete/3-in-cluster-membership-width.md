description: A node now handles a request itself whenever it is close enough to the target by the documented rule, instead of using a stricter test that made it pass work along and burn an extra network hop.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/in-cluster-width.spec.ts, docs/fret.md, docs/threat-analysis.md
---

## What shipped

`FretService.routeAct`'s "am I in the cluster for this key?" test was `distIdx <= 1` — only the two
peers immediately adjacent to the key on the ring acted. `docs/fret.md` describes a wider rule:
self within the first `k` (or `wants`) entries of the key's alternating two-sided cohort. The code
now implements the documented rule.

- **`inClusterWindow(msg)`** — `max(2, min(wants ?? want_k, want_k))`. `wants` is clamped at
  `want_k` per the wire contract; the floor of 2 keeps both key-adjacent anchors acting for a
  degenerate `want_k` of 0 or 1.
- **Gate** — `neighborDistance(selfId, coord, clusterWindow) < clusterWindow`. `neighborDistance`
  returns `Infinity` when self is absent from a cohort of that size, so the comparison is exactly
  "self appears among the first `clusterWindow` entries".
- **Acting cohort stays `want_k`-wide** even when `wants` narrowed the window — `min_sigs` derives
  from the full k, so `wants` narrows *who acts*, not *how many peers the actor gathers*.
- No public API change; `neighborDistance`'s signature is untouched.
- Docs: `docs/fret.md` membership bullet, routing rule item 1, and the next-hop "index ≥ 2" clause.

## Validation

- `npx tsc --noEmit` — clean. `yarn build` — clean.
- `yarn test` — **535 passing, 0 failing.** No pre-existing failures surfaced;
  `tickets/.pre-existing-error.md` not written.
- `test/in-cluster-width.spec.ts` — 12 passing.
- **Discrimination re-verified in this pass, not taken on trust.** Reverting only the gate to
  `<= 1` and re-running the spec fails **4** of its 12 tests (index 3 acts locally, index 3 answers
  a digest probe, the new index 6/7 boundary, the in-cluster no-handler refusal). The other 8 are
  guards on what must *not* change and pass under both gates by design.

## Review findings

### Checked, nothing found

- **Gate arithmetic and degenerate inputs.** `wants: 0` / negative → floor of 2. `want_k` negative
  → 2. `want_k: NaN` → window `NaN`, cohort walk returns empty, verdict is out-of-cluster and the
  message forwards — no spin, no throw. `wants` larger than `want_k` is clamped down.
- **Cost.** The widening does *not* increase ring-walk work: the pre-change call already passed
  `Math.max(2, want_k)` as the cohort size (15 by default) and merely compared the index against 1.
  The new code walks the same width, and *narrower* when `wants` is supplied. Measured by reading
  the pre-image of the diff, not by benchmark.
- **Other in-cluster sites.** There are none — `grep` over `packages/fret/src` for
  `wants|want_k|inCluster` shows `msg.wants` is read at exactly one place in `routeAct`, and
  `iterativeLookup` never sets `wants` (so `wants ?? k` = k on every message FRET originates).
- **`docs/fret.md` internal consistency.** Its `isInCluster` pseudocode (`self in assembleCohort(key, k)`)
  now matches the code; it did *not* match before this ticket.
- **Interaction specs.** `dialability.spec.ts` (`want_k: 2`, so its window stays 2 — the guard that
  the narrow case did not silently widen), `route.maybeact.integration.spec.ts` (`wants: 2` shape),
  `pick-anchors.spec.ts`, and the full suite: all pass.

### Minor — fixed in this pass

- **`docs/threat-analysis.md` §1.4 stated the old rule verbatim** (`neighborDistance(selfId, coord, k) <= 1`).
  That is living security documentation, not a dated report, so it was left factually wrong by the
  change. Restated with the new window, dropped a stale `fret-service.ts:850-870` line range in the
  same sentence, and added one sentence recording that the window is the *honest* code path only —
  no receiver verifies another peer's in-cluster claim, so widening it changes how many well-behaved
  peers act, not what an attacker can assert.
- **`const window` shadowed the DOM global** inside `routeAct`. House rule is cross-platform code;
  a later `typeof window !== 'undefined'` check added to that method would silently read the local.
  Renamed `clusterWindow` (call site, both comments, the doc comment on `inClusterWindow`).
- **Test premise was arithmetic, not asserted** — the implementer flagged this himself. `buildAt`
  now asserts self's cohort index via `neighborDistance` before driving `routeAct`, so a future
  change to the cohort walk fails at the seeding, naming the real cause, instead of failing at the
  gate and reading as a membership-window regression.
- **The exact boundary was untested.** Index 3 and index 8 straddle it without pinning it. Added
  `admits cohort index 6 and refuses index 7 for a want_k of 7` — the pair an off-by-one in the
  window arithmetic moves and nothing else in the file does.
- **The digest-probe hint-quality claim was untested** — also implementer-flagged. That spec
  asserted only that anchors were non-empty. It now asserts the anchor *set* equals the two ghosts
  at key±1, i.e. an index-3 answerer names the same peers a key-adjacent answerer would, never
  itself or the farther decoy. Without it the widening could trade a hop for a worse hint unnoticed.

### Correction to the handoff

The handoff lists `want_k: 0` → empty acting cohort as a gap "now reachable by more peers". It is
not: at `want_k: 0` the window is 2 under *both* gates (the old code's own `Math.max(2, want_k)`
cohort plus `idx <= 1`), and the acting cohort was already `assembleCohort(coord, 0)`. Behavior is
byte-identical pre- and post-change. Pre-existing, unwidened, left alone.

### Major — none filed, and why

No finding here reached the ticket bar. The two remaining gaps are both "we cannot measure this
cheaply", not "the code is wrong":

- **No end-to-end hop-reduction measurement on a real mesh.** Every spec drives `routeAct` directly
  on an unstarted service with a hand-seeded store, and the one integration bound
  (`libp2p-memory.integration.spec.ts`) is one-sided (`at most`), so a reduction passes there
  silently. Not filed: on a mesh small enough to run in-suite, `maybeActForwarded` can legitimately
  drop to 0 for reasons unrelated to this change, so the ticket would have no closable acceptance
  criterion. The claim stays argued rather than measured, and this paragraph is the record of that.
- **Mixed activity-handler populations** — see the tripwire below.

### Tripwires

- **`want_k` is caller-supplied and unclamped**, sizing this ring walk. Already parked as a `NOTE:`
  in the `inClusterWindow` doc comment by the implementer. Verified accurate rather than accepted:
  a filtered walk is capped at one full traversal (`maxScan = this.size()` in
  `digitree-store.ts:neighborsRight`), and `FretService` always supplies a filter, so cost is
  bounded at C = 2048 regardless of `want_k`. Left as is.
- **An in-cluster node with no activity handler refuses rather than forwarding**, so the widened
  window grows the set of peers that can strand an activity from 2 to `clusterWindow`. Harmless
  while a network installs the handler on every node or none, which is every deployment FRET
  supports today. Parked as a `NOTE:` at the refusal site in `routeAct` naming the fix (forward
  instead of refusing when `msg.activity` is set and no handler exists) — not a ticket, because it
  is conditional on a deployment shape that does not exist.

### Considered and declined

- **`docs/review.html`** contains the original finding this ticket came from ("In-cluster test is
  narrower than the doc promises"), now stale. Deliberately not edited: it is a dated point-in-time
  review report rather than living documentation, and several of its other items (the distance
  metric, correlation-ID phases, size estimation) are also already fixed. Editing one entry would
  misrepresent the document as current.
