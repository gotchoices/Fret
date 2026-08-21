description: Five near-identical ring-walking methods in the peer routing table were collapsed onto one shared walker; reviewed for behavior changes, and the untested branch it rewrote most now has tests.
files: packages/fret/src/store/digitree-store.ts, packages/fret/test/digitree.neighbors.spec.ts
----
## What landed

`DigitreeStore`'s five ordered-read methods (`successorOfCoord`, `predecessorOfCoord`,
`neighborsRight`, `neighborsLeft`, `walkFrom`) each repeated the same loop: seek a start
position, step through the B+Tree, wrap past the end of the ring, skip entries a caller's
optional filter rejects, and stop after at most one lap. That loop now lives in two private
members — `walkRing` (a generator yielding matching entries in ring order, wrapping, bounded by
a `maxScan` parameter) and `collectRing` (collects distinct ids from a `walkRing`, exiting on
the first repeat). The five public methods are thin consumers. `Path` is imported from
`digitree` as a type, aliased `EntryPath`. Net −123/+109 lines in the implement pass.

The load-bearing design call: `maxScan` is a **parameter**, not derived from whether a filter
was supplied. Deriving it inside would let an unfiltered `walkFrom(cursor, count)` with `count`
greater than the ring size circle the ring and return duplicate entries.

## Review findings

**Method reviewed:** read the implement diff (`124eceb`) before the handoff summary, traced each
of the five public methods against its pre-refactor body case by case (empty ring, off-end start
path, wrap, filtered zero-match, filtered sparse-match, count boundaries), then checked the
handoff's own claimed gaps against the test files rather than trusting them.

### Behavior equivalence — checked, nothing found

Walked all five methods against the old code. No behavior change in any of them:

- `successorOfCoord` / `predecessorOfCoord` unfiltered — the old code pre-wrapped an off-end
  path and returned immediately. The new code passes the raw path to `walkRing` with
  `maxScan = size()`; the wrap happens on the first iteration and the first yield returns, so
  the bound is never approached. On an empty store `size()` is 0, the loop body never runs, and
  both return `undefined`, as before.
- Filtered variants of the same two — old and new both count *every* entry visited (match or
  miss) against `size()`, so the one-lap bound is identical.
- `neighborsRight` / `neighborsLeft` — the wrap, the `maxScan` choice (`filter ? size() :
  Infinity`) and the repeat-id exit all moved verbatim into `collectRing`. Ordering is preserved
  because Sets are insertion-ordered, exactly as before.
- `walkFrom` — the strictly-after start path, the per-entry cursor re-stamp, the `count <= 0` /
  empty-ring early return and the `size()` bound are unchanged.

The `count <= 0` guard added to `collectRing` is genuinely required, not defensive: the old
`while (out.size < count && ...)` never entered its body for a non-positive count, but a
`for...of` over a generator pulls one entry before the caller can test.

### Minor — fixed in this pass

- **`successorOfCoord` / `predecessorOfCoord` had no coverage of their filtered branch** — the
  branch the extraction rewrote most. Their only callers anywhere are the simulator
  (`test/simulation/fret-sim.ts`) and two incidental assertions, all unfiltered, so the whole
  skip-and-keep-advancing / bounded-scan path shipped untested through the refactor. Added a
  `DigitreeStore single-entry ring walks` block to `test/digitree.neighbors.spec.ts` pinning
  five behaviors: wrap past the end of the ring in both directions, `undefined` on an empty
  store (filtered and not), skip-past-misses in both directions including via the wrap,
  terminate-in-one-lap when a filter matches nothing (with a timeout, since deleting the bound
  spins rather than failing an assertion), and find a lone match at the far end of the lap
  (which is what proves the bound is one lap of *entries*, not one lap of matches).

### Conditional — recorded as a tripwire, not filed

- **`walkRing` holds a live tree `Path` across every `yield`, and digitree paths are invalid
  after any mutation.** Being a generator makes interleaving reachable in a way the previous
  inline loops were not: a consumer can now run arbitrary code, including a write, between
  entries. Sound as written — all three consumers are in-class, materialize eagerly and mutate
  nothing — so this is "fine now; only matters if a future consumer interleaves a write".
  Parked as a `NOTE:` on `walkRing`'s doc comment naming the fix (snapshot ids first, re-seek
  per entry) rather than as a ticket.

### Handoff claims that did not hold up — checked, no action

The implement handoff flagged two coverage gaps. Both are already covered; verified by reading
the specs rather than re-deriving:

- "nothing directly pins `collectRing`'s `count <= 0` guard for a *negative* count" —
  `test/digitree.neighbors.spec.ts` "returns empty for a count of zero or negative" asserts
  `-3` on both `neighborsRight` and `neighborsLeft`.
- "nothing pins the `walkFrom`-with-`count`-greater-than-ring-size case ... a reviewer should
  confirm it exercises the unfiltered path" — `test/digitree.invariants.spec.ts` "caps a single
  page at one full lap" calls `walkFrom(null, 10)` on a 3-entry ring with **no filter**. That is
  exactly the `maxScan`-as-parameter case, on the unfiltered path.

### Major — none

Nothing rose to a new `fix/`, `plan/` or `backlog/` ticket. The extraction is behavior-preserving
on every path traced, and the one hazard it introduces is conditional (above).

### Declined-by-design — none encountered

No accepted-tradeoff `NOTE:` sits at any site this diff touched, so nothing was skipped on that
basis.

### Judgment call, agreed

The `walkRing` / `collectRing` split (repeat-exit in the consumer rather than in the walker
behind a flag) is right: only the two `neighbors*` methods want it, and pushing it into the
walker would put a flag on the hot path for three callers that can never use it.

### Docs

`docs/fret.md`'s two paragraphs on this code — *Routing store (Digitree) & indices (A2)*'s "A
ring walk exits on the first repeated id" and *Network-scoped admission*'s "The gate is applied
inside the ordered ring walk" — describe behavior, not structure, and both still read true after
the extraction. No edit needed.

## Validation

- `cd packages/fret && npx tsc --noEmit` — clean, no output. Re-run after the tripwire `NOTE:`
  edit; still clean.
- `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js
  "test/digitree.invariants.spec.ts" "test/digitree.neighbors.spec.ts" --timeout 30000` —
  **40 passing**, 0 failing, 38 ms (35 before, +5 added this pass).
- There is no lint step in this repo (`yarn format` / `format:check` are unusable against the
  house tab style — see AGENTS.md); `yarn check` is the gate.

**The full suite was deliberately not run here.** It is the explicit job of
`tickets/implement/21-cleanup-store-ring-verify`, which carries this ticket as its `prereq:` and
whose entire TODO is the four grep-confirm checks plus `npx tsc --noEmit` and `yarn test`.
Running it here would duplicate that ticket, not de-risk it. Consumers of these five methods
outside the store — `FretService`'s ring gating, `assembleCohort`, `FretPeerDiscovery`'s paged
sweep, `estimateSizeAndConfidence` — are exercised by specs that ticket will run.

Performance was not re-measured; the existing guard for it,
`test/digitree.neighbors.spec.ts` "does work proportional to the ring, not to count", passes.
The generator adds one iterator-protocol step per yielded entry, unmeasured at production counts
(~30).

## Note for future readers

`successorOfCoord` and `predecessorOfCoord` have **no `src/` callers** — they are used only by
the deterministic simulator. They are part of the store's documented primitive surface
(`docs/fret.md`, *Ranges and paths integration with Digitree*), so this is not a defect and no
ticket was filed; it is recorded because it explains why their filtered branch went untested
through a refactor of exactly that branch, and it is the reason the tests above now exist.
