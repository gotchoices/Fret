description: On small networks the group of peers chosen to handle a key could come back smaller than asked for, even when enough peers existed; fixed, along with two other places that shrank the same list after building it.
files: packages/fret/src/service/cohort.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/cohort.properties.spec.ts, docs/fret.md
---

## What shipped

`assembleCohort` (packages/fret/src/service/cohort.ts) builds a peer group by alternately
walking clockwise and counterclockwise from a key's ring position. Three under-fill causes
were removed:

- **Cross-walk duplicates** (fix stage, commit `8337dad`). Both directional walks over-fetch
  and, on a small ring, wrap and return the same ids in different orders. The old loop counted
  a duplicate as progress toward `wants`, then collapsed duplicates *after* the loop had
  already stopped. Now a `seen` set sits inside the merge loop next to the caller's `exclude`
  check, so duplicates are skipped as encountered and the loop keeps drawing until it has
  `wants` distinct ids. The trailing `Array.from(new Set(out))` is gone; the result is distinct
  by construction.

- **Over-fetch too narrow for exclusions** (review stage). Each walk fetched a fixed
  `wants * 2` ids. When the caller's `exclude` set covered that whole window, the result came
  back short — or empty — with the rest of the ring untouched. The over-fetch is now
  `wants * 2 + exclude.size`.

- **Post-filtering a sized group** (review stage). Two routing call sites in
  `fret-service.ts` asked for a group and then dropped members from the returned array
  (`.filter(id => !exclude.has(id))`) — the same shrink-after-the-fact shape the original bug
  was. The forwarding path (`routeAct`) filtered out the breadcrumb trail plus self, so a
  long route could exhaust its candidates and dead-end while usable next hops still existed;
  the iterative-lookup path filtered out self, costing one candidate per attempt. Both now
  pass `exclude` into `assembleCohort` so the exclusions are honored *during* the walk.

## Review findings

**Read first**: the implement-stage commit `18a0270` carries no source changes — only ticket
moves and an unrelated AGENTS.md line. The implementation being reviewed actually landed in
the fix-stage commit `8337dad`. Reviewed that diff.

### Major — fixed in this pass (root cause is one invariant, so no ticket filed)

All three findings below resolve at the same invariant: *exclusions belong inside the walk;
never shrink a sized cohort after building it.* Fixing the invariant retires the class, so
per architecture-first this was fixed inline rather than filed as point tickets.

- **`assembleCohort` still under-filled when exclusions blanketed the over-fetch window.**
  `repro: verified` — with the pre-fix `reach = wants * 2`, a 100-peer ring, `wants = 2`, and
  the 4 nearest peers on each side excluded, the function returned `[]`. Temporarily reverted
  `reach` and watched the new regression test fail with `expected [] to have a length of 2`,
  then restored. Fixed by widening the over-fetch to `wants * 2 + exclude.size`.
- **`fret-service.ts` `routeAct` post-filtered its routing candidates against the breadcrumb
  trail.** `repro: static` — read the code; the shrink is unconditional, but a live multi-hop
  route long enough to exhaust `max(4, m)` candidates was not staged. Fixed by passing
  `exclude` into `assembleCohort`.
- **`fret-service.ts` iterative-lookup post-filtered self out of its candidates.** Same fix.
  Lower impact (one id) but the same shape.

### Minor — fixed in this pass

- Trailing `out.slice(0, wants)` in `assembleCohort` was dead: the loop guard admits at most
  one id per pass, so the result can never exceed `wants`. Removed, with a comment saying why
  no trailing truncation belongs there.
- Dead private methods `nextSuccessor` / `nextPredecessor` in `fret-service.ts` — unreferenced
  anywhere outside stale `dist/` output. Removed.
- Unused `const selfCoord = await this.selfCoord()` in `routeAct` — a wasted SHA-256 on every
  inbound routing RPC. Removed.

### Documentation

Treated as stale until read. `docs/fret.md`'s **Cohort assembly algorithm** pseudocode still
showed the old shape — no duplicate check, no over-fetch, exclusions applied inline to a
single-step walk. Rewritten to match the implementation (over-fetch formula, `seen` set,
"distinct by construction — never dedup or truncate afterwards") plus a paragraph stating the
pass-exclusions-in rule and naming the routing/breadcrumb case. Other sections describing
cohort assembly (*Network-scoped admission*, *Determining cluster membership*) were checked
and remain accurate — the fix changes no filter or membership semantics.

### Tests

The implementer's tests were the starting point. Their real contribution was structural:
`cohort.properties.spec.ts` had been testing a *local copy* of the buggy algorithm rather than
importing production code, so its property suite proved nothing about the shipped function.
That is fixed and the properties now run against `src/service/cohort.ts`. Added two tests:

- Property: `exclusion does not under-fill: size = min(wants, n − |exclude|)` — the generalized
  guard for the whole class. Honest limit: on its own it does *not* catch the over-fetch-window
  bug, because fast-check draws at most 60 peers with `wants` up to 30, so the over-fetch
  usually already spans the ring, and the excluded ids it picks are arbitrary rather than the
  nearest ones. It guards the accounting; the deterministic test below guards the window.
- Deterministic: `exclusions wider than the over-fetch window still fill` — 100-peer ring,
  exclude the `wants * 2` nearest on each side. Verified failing pre-fix, passing post-fix.

No test was added for the two `fret-service.ts` call sites directly — exercising them needs the
libp2p harness and a route long enough to accumulate breadcrumbs. They now share the single
invariant the cohort tests cover, and `maybe-act.spec.ts` / `ring-membership.spec.ts` pass
unchanged. The gap the implementer flagged (the `filter` parameter crossed with the small-ring
duplicate case) was judged not worth an explicit case: the dedup lives in the `take()` helper,
upstream of where the store applies `filter`, so the two cannot interact.

### Validation

- `npx tsc --noEmit` — clean.
- `yarn build` — clean.
- `yarn test` — **287 passing, 0 failing** (285 before, plus the 2 new tests).
- Targeted re-run of `cohort.properties` / `cohort.assembly` / `ring-membership` / `maybe-act`
  after the final edit — 41 passing.
- No lint step exists: `packages/fret/package.json` defines only `clean`, `build`, and `test`.
  Typecheck plus build stand in. Not filed as a ticket — adding a linter is a project-level
  decision, not this ticket's business.
- No pre-existing failures surfaced, so nothing was written to
  `tickets/.pre-existing-error.md`.

### Tripwire recorded (not a ticket)

An unfiltered ring walk asked for more ids than the ring holds re-circles and dedups at the
end, so its cost tracks the requested count rather than the ring size. Widening the over-fetch
by `exclude.size` makes that count caller-influenced. Harmless while exclusions stay small
(breadcrumbs, self), so it is parked as a `NOTE:` comment at the `reach` computation in
`cohort.ts` with the condition to watch and the fix (cap `reach` at the store size), rather
than filed.

### Checked, nothing found

- Remaining `assembleCohort` callers (`neighborDistance`, `expandCohort`, `routeAct`'s
  in-cluster branch, `libp2p-fret-service.ts` pass-throughs): none depended on the old
  under-fill behavior. `expandCohort` already passed `exclude` in correctly.
- Merge-loop termination: every branch of the alternating loop advances `si` or `pi`, and the
  loop condition covers the exhausted-side cases, so no input spins.
- `FretService.assembleCohort` (the pass-through the implementer asked to be spot-checked) is
  a one-line delegation that supplies the member filter — correct as written.
- Source hygiene: `cohort.ts` is 61 lines, one exported function with one nested helper — no
  size or decomposition concern. `fret-service.ts` shrank by 11 lines.
- No accepted-tradeoff `NOTE:` exists at any site touched, so nothing was declined-by-design
  here.
