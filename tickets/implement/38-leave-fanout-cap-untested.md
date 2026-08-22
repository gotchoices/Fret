description: When a peer shuts down it also says goodbye to a couple of peers just outside its immediate neighborhood, and that courtesy list is supposed to stop at a fixed number. Nothing checks that limit, and one test is named after this step but cannot actually watch it happen.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/churn.leave.spec.ts
difficulty: medium
----

### What the plan pass found (read this before starting — the source ticket was partly stale)

The planning ticket claimed the whole beyond-S/P fan-out arm
(`sendLeaveToNeighbors`, `fret-service.ts` ~1882-1898) was untested. That is no longer true.
`test/churn.leave.spec.ts` → `Leave notice replacements (sender side)` → `at the shipped k of 15`
already covers the arm's *existence*:

- `makeSenderRig(k, count, realOffsets)` seeds a departing node's store by hand and stands up a
  real, dialed (therefore connected and dialable) receiver at each offset in `realOffsets`.
- `OUTSIDE_RECEIVER = 9` is such a receiver, at ring offset +9 — outside the S/P window
  (`{+1..+8}` ∪ `{+40..+33}` at m = 8).
- The case `sends each peer exactly one notice, S/P and beyond-S/P together` asserts it received
  exactly one notice. Nothing but the beyond-S/P arm can have sent it.

That case also already covers the "a ring neighbor is not notified twice" arm the plan asked for:
it asserts each of the three real receivers — one per side of the window, one outside it — got
exactly one notice.

The plan's claim that this needs `createIdentifyNode` is also wrong. The rig dials each receiver
directly, which makes it connected, and `isConnected` already implies dialable. No new helper is
needed.

**What is genuinely uncovered is the clamp: `.slice(0, fanOut)`.** Every existing rig has exactly
`fanOut` eligible extras or fewer, so the slice has never removed anything. Producing more than
`fanOut` eligible extras is not merely a matter of seeding more peers — see the arithmetic below,
which is the whole difficulty of this ticket.

### Why the clamp is hard to reach, and the one lever that reaches it

```ts
const fanOut = this.cfg.profile === 'core' ? 4 : 2;
const expanded = this.expandCohort(ids, selfCoord, fanOut, new Set([selfStr]));
const extra = expanded.filter((id) => !spSet.has(id) && this.isConnected(id)).slice(0, fanOut);
```

`ids` is the S/P window from an **unfiltered** ring walk. `expandCohort` asks
`assembleCohort` for `ids.length + fanOut` peers, and that walk **is** live-member-scoped. So when
every seeded peer is a live member, the expanded cohort is the window plus exactly `fanOut` more
ids, the filter yields exactly `fanOut` extras, and the slice is structurally a no-op — at any `k`,
any `count`, any profile. Seeding a bigger ring does not help.

The lever is the asymmetry between the two walks: a peer that is inside the unfiltered window but
is `foreign` or `dead` occupies a slot in `ids` yet is skipped by the cohort walk, which therefore
reaches *further out* and surfaces more non-`spSet` ids than `fanOut`. Marking window peers dead is
what makes the slice bite.

### The spec to add

Add one new `describe` beside `at the shipped k of 15` (it needs its own rig, because it runs the
**edge** profile — fanOut 2 rather than 4, so it needs one fewer real node to outrun). Give
`makeSenderRig` an optional profile argument; it currently hardcodes `profile: 'core'`.

Suggested shape, with the arithmetic that makes it non-vacuous:

- `k: 15` (m = 8), `count: 40`, `profile: 'edge'` → `fanOut = 2`.
- Real, dialed receivers at offsets **+9, +10, +11** — all outside the window `{+1..+8}`.
- Mark the ghost peers at **+2 and +3** `dead` (they are ghosts, so no notice is lost by it).
- Cohort ask is `ids.length + fanOut` = 16 + 2 = 18, alternating 9 per side. Skipping +2 and +3
  pulls the clockwise reach to `{+1, +4..+11}`, so the non-`spSet` extras are +9, +10, +11
  clockwise and +32 counter-clockwise. +32 is a ghost, so `isConnected` drops it: **three eligible
  connected extras against a cap of two.**

Assertions:

- Premise: three real outside-window receivers were seeded, and `fanOut` for the edge profile is 2
  — read `fanOut` from the profile rather than writing `2`, so a profile retune fails the premise
  rather than silently making the case vacuous.
- **The sum of notices across +9, +10, +11 equals `fanOut`** — not which specific ones. The
  selection order is `expandCohort`'s alternating cohort order, which is an implementation detail;
  the clamp is the contract. Asserting the count also fails loudly (sum < fanOut) if a future
  change shortens the cohort reach, rather than passing vacuously.
- Each window receiver seeded in this rig still got exactly one notice, so widening the extras did
  not double-notify a neighbor.

### The misnamed test

`fan-out notifies peers beyond immediate S/P` (`churn.leave.spec.ts` ~line 102) uses a star
topology in which the departing node holds exactly one connection, to the hub — which is a ring
neighbor, so `spSet` covers it and `extra` is always empty. Its own in-file comment concedes it
asserts only that the survivors kept running.

**Delete it.** Its name promises coverage the rig cannot deliver, which is worse than no test
because a grep for fan-out coverage finds it and stops; and the coverage it claims now genuinely
exists in the sender-side block above, while its actual assertion (a graceful stop does not take
the ring down) duplicates `a graceful stop sends leave notices to its neighbors without throwing`
at ~line 75. Do not try to repair it — repairing it means rebuilding `makeSenderRig`, which
already exists.

### Edge cases & interactions

- **Vacuity is the main failure mode of this ticket.** If the cohort reach falls short, the sum of
  notices is below `fanOut` and the case must fail rather than pass. Assert the premise (three
  seeded receivers, `fanOut` read from config) explicitly.
- **Order is not the contract.** Do not assert *which* of +9/+10/+11 was notified. `expandCohort`
  returns `Array.from(base)` over a `Set` seeded with `ids`, so extras appear in alternating cohort
  order — stable today, not a promise.
- **`isDoomedDial` skips ghosts as targets** but they remain live members and replacement
  candidates. Marking +2/+3 `dead` changes the replacement pool for this rig too; if the new case
  asserts anything about `replacements`, recompute the expected pool rather than copying the
  neighboring case's expectation.
- **Edge vs core profile**: only `fanOut` should differ for this path, but the profile also moves
  announce fan-out, merge caps and stream caps. Keep the new rig's assertions to the leave notice
  so an unrelated profile retune cannot break it.
- **`before`-shared departure**: `sendLeaveToNeighbors` is once-per-lifetime per service, so the
  new describe needs its own rig and its own `before`/`after`, not a second `send()` on the
  existing one.
- **Deleting the star test** removes a user of the mesh setup in that file — check whether
  `buildMesh` / `Mesh` (and any other) imports become unused and drop them if so.
- **Interaction with `plan/23-fret-service-decomposition`** (its second new arm on (a)): that work
  corrects the target list `spSet` is derived from at the shipped default `k`. Whichever lands
  second must re-check the other's expectations, since changing `spSet` changes which peers count
  as "outside the window" and therefore which are eligible here.

### TODO

- Add an optional profile argument to `makeSenderRig` in `test/churn.leave.spec.ts`, defaulting to
  `'core'` so the existing rigs are unchanged.
- Add the edge-profile `describe` with the +9/+10/+11 receivers and the +2/+3 dead-window seeds,
  asserting the notice count across those three equals `fanOut`, plus the premise assertions.
- Delete `fan-out notifies peers beyond immediate S/P` and any imports it orphans.
- Run `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/churn.leave.spec.ts" --timeout 30000`
  from `packages/fret`, then `npx tsc --noEmit`, then the full `yarn test`.
- Confirm the new case is not vacuous by temporarily removing `.slice(0, fanOut)` from
  `sendLeaveToNeighbors` and checking the case fails; restore it.
- `docs/fret.md` needs no change — this is test-only and the *Leave* section already states the
  fan-out and its bound. If the deleted test is referenced anywhere in docs, fix that reference.

---

## Progress (run interrupted by budget warning — no code changed)

**Working tree is untouched.** No edits were made to any source or test file; the run ended
during the read pass. Nothing to unwind, nothing half-applied.

What the read pass established, so the next agent does not repeat it:

- `test/churn.leave.spec.ts` is 794 lines. The ticket's description of it is accurate — all three
  target sites were confirmed by reading, not inferred.
- `makeSenderRig` is at ~line 620. The hardcoded profile is the line
  `const svc = new CoreFretService(departing, { profile: 'core', k })` inside it. That is the one
  line the optional profile argument has to reach; the rest of the helper is profile-agnostic.
- The misnamed star test `fan-out notifies peers beyond immediate S/P` occupies roughly lines
  102–130 (from the `it(` line through its closing `})`).
- **Deleting it orphans no imports.** This was the one TODO bullet that needed checking and the
  answer is "nothing to remove": `buildMesh` / `Mesh` are still used by
  `a graceful stop sends leave notices to its neighbors without throwing` (`buildMesh(4)`) and by
  `oversized replacements array is truncated` (`buildMesh(3)`); `waitFor`, `expect`, the
  `allConverged` / `anyProgressed` helpers and the `alreadyStopped` array all still have a user in
  the first of those tests. So the deletion is a plain excision of the `it(...)` block plus its
  leading comment — no import list edit, no helper removal.
- The existing `describe('at the shipped k of 15', ...)` starts at ~line 709 and ends at the file's
  end. The new edge-profile `describe` goes beside it, inside the same
  `Leave notice replacements (sender side)` parent, with its own `before` / `after` (the parent
  block's `before` already spends the shared rig's once-per-lifetime `sendLeaveToNeighbors`).
- That existing block already carries a `NOTE:` at `OUTSIDE_RECEIVER = 9` conceding it *assumes*
  `expandCohort`'s reach rather than asserting it. The new case must not repeat that shape — its
  premise assertions are what keep it from going vacuous, per the spec above.

Everything under **The spec to add**, **Edge cases & interactions** and **TODO** above still stands
unchanged and is the work remaining. Start at `makeSenderRig`.
