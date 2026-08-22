description: A departing peer also says goodbye to a couple of peers just outside its immediate neighborhood, and that courtesy list is capped at a fixed number. Nothing checked the cap, and one test named after this step could never actually watch it happen; the cap now has a real test and the misleading one is gone.
files: packages/fret/test/churn.leave.spec.ts, packages/fret/src/service/fret-service.ts
difficulty: medium
----

## What changed

Test-only. `packages/fret/src/service/fret-service.ts` is **byte-identical to HEAD** — it was
mutated once during validation (see *Mutation check* below) and restored; `git diff` shows only
the spec file.

Three edits, all in `packages/fret/test/churn.leave.spec.ts`:

- **`makeSenderRig` gained a fourth, optional parameter** `profile: 'core' | 'edge' = 'core'`,
  threaded to the one line that used to hardcode `{ profile: 'core', k }`. Every existing caller
  is unchanged and still runs core.
- **New `describe`**, `at the edge profile, with the fan-out pool wider than the cap`, beside the
  existing `at the shipped k of 15` inside the `Leave notice replacements (sender side)` parent,
  with its own `before` / `after` (`sendLeaveToNeighbors` is once-per-lifetime per service, so it
  cannot share the neighbouring rig's departure).
- **Deleted** the misnamed `fan-out notifies peers beyond immediate S/P` star-topology test. Its
  rig gave the departing node exactly one connection — to the hub, a ring neighbour — so `spSet`
  always covered it and the beyond-S/P arm's `extra` list was always empty; its own comment
  conceded it asserted only that the survivors kept running, which duplicates
  `a graceful stop sends leave notices to its neighbors without throwing` directly above it. The
  deletion orphaned no imports (`buildMesh` / `Mesh` / `waitFor` / the `allConverged` /
  `anyProgressed` helpers / `alreadyStopped` all still have users).

## What the new spec actually pins, and why it is hard

The clamp under test is `.slice(0, fanOut)` in `sendLeaveToNeighbors`
(`src/service/fret-service.ts` ~1892). Seeding a bigger ring does **not** reach it: `ids` is the
S/P window from an *unfiltered* ring walk, while `expandCohort` asks the *live-member-scoped*
`assembleCohort` for `ids.length + fanOut` peers. When every seeded peer is a live member both
walks reach the same distance, the expansion is the window plus exactly `fanOut` more ids, and the
slice removes nothing — at any k, any count, any profile. That is why no prior rig touched it.

The lever is the asymmetry: a window peer marked `dead` occupies a slot in `ids` but is skipped by
the cohort walk, which therefore reaches further out.

Rig arithmetic (all of it load-bearing — get one number wrong and the case passes vacuously):

- `k: 15` (m = 8), 40 seeded peers, **edge** profile → `fanOut = 2`.
- Real, dialed (therefore connected, therefore dialable) receivers at **+1, +9, +10, +11**.
- Ghost peers at **+2 and +3** marked `dead` after rig construction, before the departure.
- `ids` = 16 unfiltered window ids (`{+1..+8}` ∪ `{+40..+33}`), so the cohort ask is 18,
  alternating 9 per side. Skipping +2/+3 pulls the clockwise reach to `{+1, +4..+11}`, so the
  non-`spSet` extras are +9, +10, +11 clockwise and +32 counter-clockwise. +32 is a ghost, so
  `isConnected` drops it: **three eligible connected extras against a cap of two.**

Assertions:

- Premise assertions first (m = 8; `fanOut` **read from the profile**, not written as `2`, so a
  profile retune fails the premise instead of silently emptying the case; three outside receivers
  seeded, asserted `> fanOut`).
- **The sum of notices across +9/+10/+11 equals `fanOut`** — deliberately not *which* two.
  Selection order is `expandCohort`'s alternating cohort order over `Array.from(base)`, an
  implementation detail; the clamp is the contract. Asserting the sum also fails loudly (sum below
  `fanOut`) if a future change shortens the cohort reach.
- Each of the three got at most one notice.
- +1 (a window peer) got exactly one — widening the extras did not double-notify a neighbour.

**The wait is deliberate and worth reviewing.** `send()` waits only on `realOffsets[0]`, so
`WINDOW_RECEIVER = 1` is listed first: it is reached by the S/P loop, which every outcome of the
clamp still runs — waiting on one of the capped extras would wait on the thing under test. The
case then does `waitFor(sum >= fanOut)` followed by a fixed `delay(100)` before asserting
equality, because all sends are awaited inside `send()` but the receiver handlers run on the far
side of the in-memory stream; without the settle, a *missing* clamp (three notices) could be read
mid-flight as two and pass. That 100 ms is the one wall-clock guess in the new code — reviewer
should decide whether it is worth replacing with something condition-shaped.

## Validation performed

From `packages/fret`:

- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/churn.leave.spec.ts" --timeout 30000`
  → 22 passing (10s), including both new cases.
- `npx tsc --noEmit` → clean.
- `yarn test` (full suite) → **1248 passing, 0 failing** (8m). No pre-existing failures surfaced;
  `tickets/.pre-existing-error.md` not written.

**Mutation check (the anti-vacuity proof).** With `.slice(0, fanOut)` temporarily removed from
`sendLeaveToNeighbors`, the new case fails with `expected 3 to equal 2` — i.e. all three eligible
extras were notified. The clamp was then restored and `git diff` re-checked: `fret-service.ts`
carries no change.

## Known gaps / things to poke at

- **The 100 ms settle** described above is the weakest part of the new case. It is not a
  convergence guess (all sends are already awaited) — only a handler-delivery settle — but it is
  still a fixed sleep in a file whose header comment is largely about having removed fixed sleeps.
- **Coupling to `expandCohort`'s reach.** The new case computes its offsets from the alternating
  9-per-side reach. That is asserted only indirectly: if the reach shortens, the sum drops below
  `fanOut` and the case fails loudly rather than passing — which is the designed failure mode, but
  it means the *reason* for a future failure will read as "the clamp broke" when it may be the
  reach that moved. The neighbouring `at the shipped k of 15` block carries a `NOTE:` conceding the
  same assumption at `OUTSIDE_RECEIVER = 9`; the new block states its arithmetic in a doc comment
  instead. Reviewer may judge that insufficient.
- **Nothing asserts the edge profile changed only `fanOut`.** Edge also moves announce fan-out,
  merge caps and stream caps. The new case's assertions are confined to leave notices precisely so
  an unrelated profile retune cannot break it, but that is a convention here, not an enforced one.
- **`replacements` is not asserted in the new rig**, on purpose: marking +2/+3 dead changes the
  replacement pool, and copying the neighbouring case's expectation would have been wrong. If a
  reviewer wants replacement coverage at the edge profile, the expected pool must be recomputed
  from scratch.
- **Interaction with `plan/23-fret-service-decomposition`** (its second new arm): that work
  corrects the target list `spSet` derives from at the shipped default `k`. Whichever lands second
  must re-check the other's expectations — changing `spSet` changes which peers count as outside
  the window and therefore which are eligible for this arm.
- `docs/fret.md` needed no change (test-only; the *Leave* section already states the fan-out and
  its bound), and nothing in `docs/` referenced the deleted test.
