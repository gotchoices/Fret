description: Property-based tests (fast-check) for FRET ring, cohort, and relevance invariants
dependencies: fast-check (already in devDependencies ^4.5.3), Digitree, ring/distance, store/relevance
files: packages/fret/test/ring.properties.spec.ts, packages/fret/test/cohort.properties.spec.ts, packages/fret/test/relevance.properties.spec.ts
----

Add comprehensive property-based tests using fast-check to verify FRET invariants hold across randomized inputs.  Create three test files covering ring arithmetic, cohort assembly, and relevance scoring.  Use the existing patterns from `digitree.neighbors.spec.ts` and `digitree.persistence.spec.ts` (Mocha + Chai + fast-check, `fc.assert(fc.property(...))` style).

### Generators

Shared arbitrary for a 256-bit ring coordinate:

```ts
const arbCoord = fc.uint8Array({ minLength: 32, maxLength: 32 });
```

For peer sets, generate arrays of unique `{ id, coord }` pairs using `fc.uniqueArray` keyed on `id`:

```ts
const arbPeer = fc.record({ id: fc.hexaString({ minLength: 4, maxLength: 8 }), coord: arbCoord });
const arbPeerSet = fc.uniqueArray(arbPeer, { selector: p => p.id, minLength: 1, maxLength: 100 });
```

### Test file 1: `ring.properties.spec.ts`

Properties for `xorDistance`, `clockwiseDistance`, `lexLess`:

- **XOR distance symmetry**: `xorDistance(a, b)` byte-equals `xorDistance(b, a)` for all coords a, b.
- **XOR self-distance is zero**: `xorDistance(a, a)` is all-zero bytes.
- **XOR triangle inequality**: `xorDistance(a, c) ≤ xorDistance(a, b) XOR xorDistance(b, c)` — this doesn't hold for XOR metric in general, so instead verify the weaker property that `xorDistance(a, b) = 0 ⟹ a byte-equals b` (identity of indiscernibles).
- **Clockwise distance complements**: `clockwiseDistance(a, b) + clockwiseDistance(b, a) = 2^256` for a ≠ b (modular arithmetic: the two directed distances sum to the full ring).  When a = b both should be zero.
- **Clockwise self-distance is zero**: `clockwiseDistance(a, a)` is all-zero.
- **lexLess strict total order**: irreflexive (`!lexLess(a, a)`), antisymmetric (if `lexLess(a, b)` then `!lexLess(b, a)`), and for distinct a, b exactly one of `lexLess(a, b)` or `lexLess(b, a)` is true.
- **Coordinate encoding round-trips**: `hexToCoord(coordToHex(c))` byte-equals `c`; same for base64url.

### Test file 2: `cohort.properties.spec.ts`

Test cohort assembly directly on DigitreeStore (no libp2p node needed — `assembleCohort` delegates to `store.neighborsRight/Left`):

Reimplement the alternating walk locally to test against the store, or instantiate the FretService minimally.  The simpler approach: test the store's `neighborsRight` and `neighborsLeft` properties, then test the cohort assembly algorithm independently.

**Store neighbor properties (strengthen existing)**:
- **Symmetric m predecessors/successors**: `|neighborsRight(c, m)| + |neighborsLeft(c, m)|` unique peers ≤ `min(2m, n)` and ≥ `min(m, n)` (at least one direction yields min(m, n)).
- **No duplicates in S/P individually**: `neighborsRight(c, m)` has no dupes; same for `neighborsLeft`.
- **Wrap-around correctness**: Insert peers at coord 0x00...01 and 0xFF...FE; query `neighborsRight(0xFF...F0, 4)` should include the 0x00...01 peer (wrap); similar for left.

**Cohort assembly properties** (build a local `assembleCohort` that mirrors the service's logic over a DigitreeStore):
- **No duplicates**: result has unique IDs.
- **Size = min(wants, n)**: result length equals `min(wants, storeSize)`.
- **Two-sided alternation**: even-indexed members come from `neighborsRight`, odd-indexed from `neighborsLeft` (until one side is exhausted).
- **Monotonic expansion**: for any wants₁ < wants₂, `assembleCohort(c, wants₁) ⊆ assembleCohort(c, wants₂)`.
- **Exclusion respected**: excluded IDs never appear in result.
- **Deterministic**: same store + coord + wants + exclude → same result.
- **n=1 edge case**: single peer always returned regardless of coord.
- **All peers equidistant**: when all peers share same coord, cohort still assembles without error and returns correct count.

### Test file 3: `relevance.properties.spec.ts`

Properties for scoring functions in `store/relevance.ts`:

- **Sparsity bonus bounded**: `sparsityBonus(model, x) ∈ [sMin, sMax]` for all x ∈ [0, 1].
- **Touch increases accessCount**: `touch(entry, x, model).accessCount = entry.accessCount + 1`.
- **recordSuccess increases successCount**: similarly for successCount.
- **recordFailure increases failureCount**: similarly.
- **Relevance non-negative**: `touch(entry, x, model).relevance ≥ 0`.
- **Failure degrades relevance**: `recordFailure(entry, x, model).relevance ≤ touch(entry, x, model).relevance` (given same entry state and time).
- **normalizedLogDistance range**: result ∈ [0, 1] for any two coords.
- **normalizedLogDistance self is zero**: `normalizedLogDistance(a, a) = 0`.
- **observeDistance updates occupancy**: after `observeDistance(model, x)`, at least one center's occupancy increases.

### Implementation notes

- Each test file is standalone; no libp2p nodes needed (work directly with DigitreeStore and pure functions).
- For cohort assembly, extract the alternation logic into a local helper that mirrors `fret-service.ts:assembleCohort` but takes a store instance directly — or cast the service to access `store` like the existing `cohort.assembly.spec.ts` does.
- Use `fc.assert(..., { numRuns: 200 })` for moderate coverage without slow CI.
- Set `this.timeout(30000)` on the describe blocks for property tests.

### TODO

- Create `test/ring.properties.spec.ts` with ring arithmetic property tests
- Create `test/cohort.properties.spec.ts` with cohort assembly property tests
- Create `test/relevance.properties.spec.ts` with relevance scoring property tests
- Verify all tests pass with `yarn test`
- Verify build passes with `yarn build`
