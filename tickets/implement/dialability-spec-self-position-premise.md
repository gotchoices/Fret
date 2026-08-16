----
description: Two routing tests fail every so often for a reason unrelated to the code they exercise — each run invents a random network identity for the test node, and a few percent of those identities land somewhere that quietly invalidates the test's own setup.
files: packages/fret/test/dialability.spec.ts, packages/fret/test/helpers/ring.ts (new), packages/fret/src/selector/next-hop.ts, packages/fret/src/service/fret-service.ts, tickets/.pre-existing-known.md
difficulty: easy
repro: verified
----

## What actually fails

`packages/fret/test/dialability.spec.ts`, two specs in `dialability guard on outbound RPC`:

- `routeAct forwards to the reachable candidate when nearer ones are undialable` (spec at
  `dialability.spec.ts:195`, assertion at `:222`) — **1.17 %** of runs.
- `routeAct still finds a hop when unreachable peers fill the whole cohort width`
  (spec at `:237`, assertion at `:259`) — **4.83 %** of runs.

Both are load-independent. The failure rate is a property of the random keypair each run
generates, so a full-suite run is no more likely to trip it than an isolated one — full-suite
runs are simply run far more often, which is where the "only under load" impression came from.

## Root cause

One site: **the spec fabricates the test node's own ring position, and the code under test
never reads it.**

`FretService.routeAct` forwards through `chooseNextHop`, which applies a *strict-improvement
floor* (`src/selector/next-hop.ts:232`): a candidate is eligible only if it is strictly closer
to the key than the caller is. `routeAct` supplies the caller's position as
`await this.selfCoord()` (`src/service/fret-service.ts:1709`), and `selfCoord`
(`fret-service.ts:300`) is the SHA-256 of the node's real peer id — **not** the store entry for
self.

The spec establishes "we are far from the key" by seeding a store entry instead:

```ts
seedMember(svcA, idA, oppositeCoord(coord))   // dialability.spec.ts:212
```

Nothing reads that entry for this purpose. The coordinate the floor actually uses is
`hashPeerId(nodeA.peerId)`, and `createMemNode` mints a fresh Ed25519 key per run, so that
coordinate is uniformly random on the ring.

The second half of the cause is the *scale* of the seeded candidates. `offsetCoord`
(`dialability.spec.ts:51`) carries its delta in the **most-significant** byte:

```ts
c[0] = (c[0] + delta) & 0xff
```

so one "step" is 2^248 ring units. Ring distance maxes out at 2^255 (it is the shorter of the
two arcs), so a step is 1/128 of the whole scale — the candidates are not near the key, they are
scattered across a 4 % arc of the ring.

Put together, the floor discards the only reachable hop whenever

```
minDistance(hashPeerId(nodeA.peerId), keyCoord)  ≤  delta · 2^248
```

which happens with probability `delta / 128`: **1.6 % at delta 2** (the `route-key` spec) and
**3.9 % at delta 5** (the `crowded-key` spec).

### Measured

600 freshly generated Ed25519 peer ids per row, comparing the real hashed self coordinate
against the intended hop's distance:

| spec | hop offset | hop excluded by the floor | predicted |
|---|---|---|---|
| `route-key` (`:222`) | +2 | 7/600 = **1.17 %** | 1.56 % |
| `crowded-key` (`:259`) | +5 | 29/600 = **4.83 %** | 3.91 % |

### Verified repro

Grinding a peer key until its hash lands inside that window (31 tries) and running the
`route-key` scenario with it reproduces the reported failure exactly:

```
line 220  'anchors' in res              : true    (expected true)     PASS
line 221  dials                         : 0       (expected 0)        PASS
line 222  successCount(idB)             : 0       (expected > 0)      FAIL
line 225  negotiateFailures(ghostSucc)  : 0       (expected 0)        PASS
line 226  membership(ghostSucc)         : member  (expected member)   PASS
          diag.maybeActForwarded        : 0
```

That matches the reported signature line for line — including the detail that only `:222`
failed while everything around it passed.

`diag.maybeActForwarded` is **0**: no forward was ever attempted. The RPC was never sent, so
nothing waited on a stream deadline. The previous ticket's hypothesis (a healthy forward
missing `readAllBounded`'s 5 s read deadline on a starved machine) is therefore **not
supported**, and the seams it proposed — an injectable transport on `FretService`, or asserting
on `diag.maybeActForwarded` plus B's inbound handler — are not needed. Nothing in `src/` is
defective; the whole defect is in the spec's setup.

## The fix

Three arms, all in test code. Validated end to end: re-running the ground "unlucky" key against
the fixed setup yields `successCount(idB) = 1`, `maybeActForwarded = 1`, and every sibling
assertion still passing.

### 1. Exact ring arithmetic at a scale randomness cannot reach

Replace `offsetCoord` with a helper that adds a signed delta to a 32-byte coordinate **modulo
2^256, propagating carry and borrow across all 32 bytes**, and express candidate offsets at
least-significant-byte scale (±1, ±2, +5 ring units rather than ±2^248).

The carry propagation is the load-bearing part, and it is why the current helper puts the
offset in byte 0 in the first place: wrapping the *top* byte is exact modulo 2^256, because no
carry can escape it. A naive least-significant version is silently **wrong** at the wrap —
`c[31] = (0 - 1) & 0xff` is 255, which changes the coordinate by +255, not −1. A round-trip
test pins this (see below).

At unit scale the probability that a random self coordinate lands inside the candidate window is
5/2^255, i.e. gone rather than merely reduced.

Put the helper in a shared `packages/fret/test/helpers/ring.ts` so the next spec that needs a
seeded ring position does not re-invent the most-significant-byte trap. `oppositeCoord` is a
genuine half-ring offset and stays exact as a top-bit flip; keep it, expressed through the same
helper or as-is.

### 2. One source of truth for the node's own ring position

Seed self at its **real** coordinate — `await hashPeerId(nodeA.peerId)` — instead of a
fabricated one, in every spec in the file that seeds self at all. The store entry and the
selector then agree by construction, and no future reader can believe the seeded value steers
routing.

Safe by the same arithmetic: with candidates within a handful of ring units of the key, a random
self coordinate is essentially never among the key's two nearest members, so the `inCluster` arm
of `routeAct` stays false exactly as before.

While there: the doc comment on `oppositeCoord` (`dialability.spec.ts:57-64`) claims the seeded
position keeps `shouldIncludePayload` false. It does not — that heuristic is fed
`minDistance(await this.selfCoord(), coord)` (`fret-service.ts:2027`), the real coordinate — so
the seeded value never influenced it either. Correct the comment rather than leaving a second
statement of the same misunderstanding in the file.

### 3. Assert the premise instead of assuming it

In both `routeAct` specs, assert *before* calling `routeAct` that the node really is farther
from the key than the intended hop. One line each. It costs nothing and turns a silent
1-in-64 wrong premise into a self-describing failure if anyone retunes the offsets later.

### Scope note on the other five `offsetCoord` uses

The remaining uses in the file (`sendLeaveToNeighbors`, the two `iterativeLookup` specs) are on
paths that never pass a self coordinate to the selector — an originating lookup deliberately
omits it (`buildNextHopOptions`, `fret-service.ts:1778`), and the leave fan-out does not select
a hop at all — so they are not flaky today. Convert them to the shared helper anyway so the file
uses one scale throughout and the trap has nowhere to survive.

`offsetCoord` / `oppositeCoord` appear in **no other spec** (grepped across
`packages/fret/test`), so the blast radius is this one file plus the new helper.

## Validation

A plain green run of the spec proves very little at a 1-in-64 rate — it was green at HEAD when
this was investigated. The meaningful checks are:

- The unit test on the new helper (round-trip and wrap behavior), which is what keeps the class
  dead rather than this instance.
- Optionally, a throwaway grind harness during implementation: generate keys until one lands
  inside the *old* failure window, then run the scenario with it and watch it pass. Do not
  commit it, and delete it before handing off — the two used for this investigation were
  removed.

## Tripwire to record in code (not a ticket)

The forward in these specs is still a real request/response over two libp2p nodes, bounded by
`readAllBounded`'s 5 s overall read deadline (`src/rpc/protocols.ts:136`) with no retry. That is
not the cause here and has never been observed to fail, but it is the assertion's remaining
dependence on wall-clock time. Record it as a `NOTE:` at the spec — do not file it.

## Cross-cutting obligations

None. Test-only change: no behavior change, no determinism edition bump, no wire format, no
golden fixture, no `docs/fret.md` update.

## TODO

- Add `packages/fret/test/helpers/ring.ts` exporting a `ringOffset(base, delta)` that adds a
  signed delta modulo 2^256 with carry/borrow across all 32 bytes, plus `oppositeCoord`.
  Document at the seam why the offset is unit-scale and why carry propagation is required.
- Add a unit spec for the helper: `ringOffset(c, d)` then `ringOffset(·, -d)` round-trips for
  coordinates straddling the wrap point (all-zero, all-`0xff`), and
  `minDistance(ringOffset(c, d), c)` equals `|d|` including across the wrap.
- Point `packages/fret/test/dialability.spec.ts` at the shared helper; delete its local
  `offsetCoord` / `oppositeCoord`; restate candidate offsets at unit scale.
- Seed self at `await hashPeerId(node.peerId)` in every spec in the file that seeds self, and
  correct the stale `shouldIncludePayload` claim in the surrounding comment.
- Add the explicit premise assertion (self farther from the key than the intended hop) to both
  `routeAct` specs.
- Add the `NOTE:` tripwire about the forward's remaining 5 s stream-deadline dependence.
- Run `cd packages/fret && npx tsc --noEmit` and `yarn test`.
- Remove the `dialability.spec.ts:222` line from `tickets/.pre-existing-known.md` — this ticket
  is that entry's fix.
