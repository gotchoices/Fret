description: Fixed a rare, random test failure in two routing tests — the test setup could occasionally invent a fake starting position for the test node that accidentally broke its own premise, about 1-5% of the time depending on the test.
files: packages/fret/test/dialability.spec.ts, packages/fret/test/helpers/ring.ts (new), packages/fret/test/helpers/ring.spec.ts (new), tickets/.pre-existing-known.md
----

## What was wrong (recap)

`packages/fret/test/dialability.spec.ts` had two specs in `dialability guard on outbound RPC`
that failed at a low, load-independent rate (1.17% and 4.83% of runs — see the original ticket
body, still in git history, for the full derivation). Root cause was entirely in test code, not
`src/`:

1. The spec's `offsetCoord` helper placed its delta in the **most-significant** byte of a ring
   coordinate, so a "step" was 2^248 ring units — 1/128th of the ring's full span, not a nearby
   point. Candidates meant to be "near the key" were actually scattered across a 4% arc.
2. The spec seeded the test node's own position in the store at a fabricated coordinate
   (`oppositeCoord`), while the code under test (`routeAct`'s strict-improvement floor in
   `src/selector/next-hop.ts`) reads the node's *real* hashed peer id
   (`FretService.selfCoord()`), never the store entry. So the store and the selector disagreed
   about where "self" was.

Combined: roughly 1/64–1/26 of randomly generated test-node keypairs happened to hash to a ring
position that landed inside that scattered 4% arc, closer to the key than the intended hop —
silently defeating the test's own setup, with no forward ever attempted
(`diag.maybeActForwarded === 0`).

## What changed

All changes are test-only. No behavior change in `src/`.

- **New `packages/fret/test/helpers/ring.ts`**: `ringOffset(base, delta)` adds a signed delta to
  a 32-byte ring coordinate at the *least-significant* byte, with carry/borrow propagated across
  all 32 bytes (exact modulo 2^256). `oppositeCoord(base)` (top-bit flip, exact half-ring offset)
  moved here too.
- **New `packages/fret/test/helpers/ring.spec.ts`**: unit coverage for the helper — round-trips
  `+d` then `-d` back to the original coordinate for `ZERO`/`ALL_FF`/`MID` bases across
  `d ∈ {-5,-2,-1,0,1,2,5}` (48 cases), confirms `minDistance(ringOffset(c,d), c) === |d|`, and
  pins the carry-propagation behavior explicitly (decrement-from-zero borrows all 32 bytes to
  `0xff…ff`; increment-past-`0xff…ff` wraps to zero). All 47 assertions pass.
- **`dialability.spec.ts`**:
  - Deleted the local `offsetCoord` / `oppositeCoord`, now imported from the shared helper.
  - All seven `offsetCoord(...)` call sites across the file now call `ringOffset(...)` with the
    same delta literals (1, -1, 2, 5, -2) — these are already unit-scale values, so only the
    arithmetic under them changed, not the test's intent.
  - In every spec that seeds the test node's own store position, it's now seeded at
    `await hashPeerId(node.peerId)` — the real coordinate — instead of a fabricated one. Four
    call sites: the two flaky `routeAct` specs, and the two `iterativeLookup` specs (which were
    not flaky, since `iterativeLookup` excludes self by peer id via its `visited` set rather than
    by ring position — but seeding a fake self position there was still misleading test setup, so
    it's fixed for consistency per the ticket's instruction).
  - Added an explicit premise assertion in both `routeAct` specs, right before calling
    `routeAct`: asserts (via `minDistance` + `lexLess`) that the seeded hop really is nearer to
    the key than the (real) self coordinate. Turns a silent wrong-premise flake into a
    self-describing failure if the offsets are ever retuned.
  - Added a `NOTE:` comment above the first flaky spec recording the tripwire: the forward is a
    real request/response over two libp2p nodes bounded by `readAllBounded`'s 5s deadline
    (`src/rpc/protocols.ts`) with no retry — not observed to fail, not the cause here, but the
    assertion's one remaining dependency on wall-clock time.
- **`tickets/.pre-existing-known.md`**: removed both dialability.spec.ts entries (this ticket was
  their fix).

## Why this should hold up

- `neighborDistance`/`routeAct`'s in-cluster check (`fret-service.ts:1681`, via
  `assembleCohort`) *does* read the store's self entry — so seeding self at its real position
  there is not just cosmetic, it's what keeps the `inCluster` branch false the same way the old
  fabricated position did (a uniformly random real coordinate is essentially never among the
  key's two nearest members when candidates sit a handful of ring units away — probability
  ~5/2^255).
- `iterativeLookup` never reads the store's self entry for candidate selection — it excludes
  self by peer id via `visited` — confirmed by reading `fret-service.ts:1997-2066`. So changing
  those two specs' self-seed coordinate is safe and doesn't change their pass/fail behavior.

## Validation

- `cd packages/fret && npx tsc --noEmit` — clean.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/helpers/ring.spec.ts"` —
  47 passing.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/dialability.spec.ts"` — 11
  passing.
- Full suite: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts"`
  — **485 passing**, 0 failing. (Single run — doesn't itself prove the flake is gone, since the
  old failure rate was only 1-5%; the fix's soundness rests on the arithmetic argument above and
  in the original ticket body, not on this one green run.)

## Known gaps / things the reviewer should double-check

- I did **not** run the "grind until an unlucky key reproduces the old failure" throwaway
  harness the original ticket suggested as an optional validation step — the original ticket
  author already did this (documented in ticket history: ground key reproduced the exact
  reported failure signature pre-fix, and passed post-fix). I did not re-verify that specific
  claim independently; I relied on the static arithmetic argument (unit-scale offsets +
  exact-modulo carry propagation ⇒ the scattering bug is structurally gone, not just less
  likely) plus the unit tests on the new helper.
- I did not add a fast-check/property-based test generating many random self coordinates against
  the fixed setup to empirically confirm the failure rate dropped to ~0 — the helper's unit spec
  proves the arithmetic is exact, which is what the fix actually depends on, but there's no
  Monte-Carlo-style regression guard against a future change reintroducing MSB-scale offsets in
  this file. Low risk (nothing else in the file uses raw coordinate arithmetic anymore — it's
  all funneled through `ringOffset`/`oppositeCoord`), but worth a second look if the reviewer
  wants extra confidence.
- Did not touch `src/` at all, as scoped — this was purely a test-setup bug.
