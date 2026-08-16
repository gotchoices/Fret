description: Fixed a rare, random test failure in two routing tests — the test setup could occasionally invent a fake starting position for the test node that accidentally broke its own premise, about 1-5% of the time depending on the test.
files: packages/fret/test/dialability.spec.ts, packages/fret/test/helpers/ring.ts, packages/fret/test/helpers/ring.spec.ts, packages/fret/test/ring.properties.spec.ts, packages/fret/test/ring-wrap-distance.spec.ts, tickets/.pre-existing-known.md, tickets/plan/20-cleanup-tests.md
----

## What was wrong

Two specs in `dialability guard on outbound RPC` (`packages/fret/test/dialability.spec.ts`)
failed at a low, load-independent rate (1.17% and 4.83% of runs). Both causes were in test code:

1. The spec's `offsetCoord` helper put its delta in the **most-significant** byte, so one "step"
   was 2^248 ring units — 1/128th of the ring, not a nearby point. Candidates meant to sit
   beside the key were scattered across a wide arc.
2. The spec seeded the test node's own store position at a fabricated coordinate, while the code
   under test reads the node's *real* hashed peer id. Store and selector disagreed about where
   "self" was.

Together, a randomly generated test keypair could hash into that scattered arc, closer to the key
than the intended hop — silently defeating the spec's own setup.

## What was done (implement stage)

Test-only; no `src/` change.

- New `test/helpers/ring.ts`: `ringOffset(base, delta)` adds a signed delta at the
  *least-significant* byte with carry/borrow across all 32 bytes (exact mod 2^256), plus
  `oppositeCoord`.
- New `test/helpers/ring.spec.ts` covering the helper.
- `dialability.spec.ts`: all seven offset call sites moved to `ringOffset`; every spec that seeds
  the node's own store position now seeds it at `await hashPeerId(node.peerId)`; both formerly
  flaky specs gained an explicit premise assertion (the seeded hop really is nearer to the key
  than self) so a retuned offset fails loudly instead of silently.
- Both entries removed from `tickets/.pre-existing-known.md`.

## Review findings

### Verified, not taken on trust

Read the implement diff before the handoff summary, then checked its three load-bearing claims
against `src/`:

- **`selfCoord()` is the real hashed peer id, never the store** (`fret-service.ts:300`). Confirms
  the store/selector disagreement the ticket describes, and confirms the new premise assertions
  measure the right thing.
- **`iterativeLookup` excludes self by peer id, not ring position** — `visited` is seeded with
  `selfId` (`fret-service.ts:2021`) and passed *into* the candidate walk (`:2045`), so the store's
  self coordinate cannot affect those two specs. The claim that changing them is cosmetic holds.
- **`routeAct`'s in-cluster test *does* read the store's self entry** —
  `neighborDistance` → `assembleCohort` (`fret-service.ts:1566,1681`). So seeding self at its real
  coordinate there is load-bearing, not cosmetic, exactly as the handoff says. With `want_k: 2` the
  cohort is the key's two nearest members; a uniformly random self coordinate is essentially never
  among them when candidates sit 1–5 ring units out, and the premise assertion catches it if it
  ever is.

Also confirmed the implementer's claim about the *old* comment being wrong: the deleted
`oppositeCoord` docstring claimed the fabricated position kept `shouldIncludePayload` false, but
that function reads the real self coordinate too (`fret-service.ts:2027`), so the fabricated
position never influenced it. Removing that comment was correct.

### Fixed in this pass (minor)

- **Dangling documentation reference.** A comment in `dialability.spec.ts` pointed readers at a
  "dialability self-position note" in `docs/fret.md`. No such note exists — grepping the docs for
  it returns only unrelated `selfCoord` text about size estimation. Replaced the pointer with the
  actual explanation and the two real source sites, so the comment stands on its own.
- **`toBigInt` duplicated three ways.** The new helper spec added a third hand-written copy of the
  big-endian bigint conversion (alongside `ring.properties.spec.ts` and `ring-wrap-distance.spec.ts`).
  Moved it into `test/helpers/ring.ts` and imported it in all three. This does not weaken
  `ring.properties.spec.ts`'s independent-oracle guarantee — that comment promises the oracle shares
  no code with `src/ring/distance.ts`, and a test helper is not `src`.
- **Pointless re-export.** `test/helpers/ring.ts` imported `COORD_BYTES` purely to re-export it.
  Dropped; the spec imports it from `src/ring/hash.js` directly, like every other spec does.
- **Test-name typo.** The generated round-trip names read "through +-5 then --5" for negative
  deltas. Reworded.

### Test gaps closed (the implementer's stated gaps)

The handoff was honest that it had run no empirical validation and added no generalized test.
Both addressed:

- **Property test over arbitrary base and delta.** `toBigInt(ringOffset(base, delta))` must equal
  the exact 256-bit sum, checked with `fast-check` (already a dependency) over 500 random
  coordinate/delta pairs. This is the rung above the hand-picked cases the implementer wrote: a
  carry dropped at any byte, or a delta applied at the wrong byte, fails here. It retires the class
  rather than the instance, which is what the original bug asks for.
- **Non-mutation.** `ringOffset` and `oppositeCoord` must not edit their input. This is load-bearing
  and was untested: `dialability.spec.ts` derives up to five seeded positions from one hashed key,
  so an in-place edit would corrupt every offset after the first — and would do so quietly, seeding
  peers somewhere other than where the spec says they are.
- **Empirical grind.** Ran `test/dialability.spec.ts` 15 consecutive times: 0 failures. Stated
  honestly: at the old combined per-run failure rate of ~6%, 15 runs had roughly a 60% chance of
  reproducing the flake, so this is corroboration, not proof. The proof remains the arithmetic —
  exact carry propagation at unit scale — now pinned by the property test above.

### Filed as an arm on an existing ticket (major-ish, not fixed here)

`tickets/plan/20-cleanup-tests.md` already owns "the same setup is copy-pasted across many specs;
consolidate into shared helpers", so this is an arm on it rather than a new ticket. The new helper
module fixed two instances of hand-rolled ring arithmetic but left five: the bigint-to-coordinate
conversion is written out five times under four different names, and `pick-anchors.spec.ts:51`
(`shiftCoord`) duplicates `ringOffset` outright, differing only in taking a bigint delta. Unifying
those two means widening the helper's parameter type, which is a change to a spec outside this
ticket's scope and belongs with the rest of the consolidation. All five sites are correct today —
this is prevention of the exact failure mode this ticket just fixed, not a live bug.

### Tripwires (conditional; deliberately not tickets)

- The implementer left a `NOTE:` above the first formerly-flaky spec recording that its forward is a
  real two-node request/response bounded by `readAllBounded`'s 5 s deadline with no retry — a
  wall-clock dependency, never observed to fail. Reviewed and kept as written; it is correctly
  scoped as "fine now, matters only if the suite runs somewhere much slower".
- Added a `NOTE:` on `oppositeCoord` in the helper. It has no caller now that the specs stopped
  using it, so the obvious move is deletion — but hand-rolled coordinate arithmetic in a spec is
  precisely what caused this ticket, and a correct tested "half the ring away" is worth more than a
  smaller export surface. Recorded the reasoning at the site so the next reviewer does not re-open it.

### Checked and clean (explicitly, with reason)

- **`src/` behavior**: untouched by the diff and untouched by this review. Correct — the defect was
  entirely in test setup.
- **`docs/fret.md`**: read the sections the change touches on (Dialability, next-hop strict
  improvement, size estimation). No update needed: every statement there describes `src/` behavior,
  none of which changed, and none of it referenced the test helpers. The one doc-shaped problem was
  the spec's dangling pointer *into* the docs, fixed above.
- **`test/README.md`**: does not enumerate helpers, so the new module needs no entry. It is stale in
  other ways, but that is already an existing arm of `tickets/plan/20-cleanup-tests.md`; not
  re-reported.
- **Source hygiene**: `dialability.spec.ts` 375 lines, `helpers/ring.ts` 48, `helpers/ring.spec.ts`
  92 — all small. `ringOffset` is ten lines with a sixteen-line docstring, which looks
  comment-heavy; read it and kept it. The two paragraphs say different things (carry correctness,
  then why least-significant-byte scale) and the historical detail is what stops the bug recurring.
- **Resource cleanup / error handling / type safety**: no findings. The helper is a pure function
  over a `Uint8Array` with no I/O, no `any`, and no allocation beyond its return value; the specs
  keep the file's existing `try/finally` node-teardown pattern.
- **Remaining flake sources in the two specs**: looked for others and found none beyond the recorded
  tripwire. `svcA` is deliberately never started in these specs, so no stabilization loop races the
  setup; `svcB` is started but node A registers no FRET handlers, so B's background traffic cannot
  reach into A's store.

### Validation

- `npx tsc --noEmit` — clean.
- Full suite, `test/**/*.spec.ts` — **488 passing, 0 failing** (485 before, plus the three tests
  added above).
- `test/dialability.spec.ts` × 15 consecutive runs — 0 failures.
- No lint step exists in this repo (`yarn check` = typecheck + build + test is the gate, per
  `AGENTS.md`); `yarn format:check` is knowingly broken repo-wide for unrelated reasons and was not
  run.
- No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
