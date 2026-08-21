description: Final verification pass for the ring-walker cleanup — the four old fixes were confirmed still in place, the whole project builds and tests clean, and one leftover untyped cast found during review was fixed.
files: packages/fret/src/service/libp2p-fret-service.ts, docs/fret.md, packages/fret/src/store/digitree-store.ts, packages/fret/src/store/relevance.ts, packages/fret/src/ring/distance.ts, packages/fret/src/ring/hash.ts
----
Follow-on to `cleanup-store-ring-walker`. The implement stage made no code changes; review
re-ran every check independently, found one type-safety leftover the ticket's own grep pattern
could not see, and fixed it inline.

## What the implement stage did

Nothing to the code. `git show 0e3b551 --stat` is two ticket files and no source, which matches
its own claim — so review re-derived every assertion from the tree rather than reading the
handoff.

## Verification (re-run at review, not trusted from the handoff)

All four grep-confirm items still hold:

- **coord-to-hex duplication** — `coordToHex` is defined once (`ring/hash.ts:41`) and imported by
  exactly one file, `store/digitree-store.ts` (5 call sites, all inside the store's own
  key-building and ring-walk code). No second implementation.
- **lexicographic-less padding** — `lexLess` is defined once (`ring/distance.ts:10`) and used by
  `ring/distance.ts` itself, `selector/next-hop.ts`, and re-exported from `index.ts`. No duplicate
  comparator. (The public re-export is expected; it is named in the package's exported surface.)
- **metadata `Record<string, any>`** — zero live matches. The single grep hit
  (`service/libp2p-fret-service.ts:15`) is prose inside a doc comment describing a *past* bug, not
  a type.
- **mirrored-index xor loop** — no such comparator anywhere. Both `xor` hits are prose explaining
  why XOR is *not* used as the ring metric.

Spot-checked the handoff's side claim that `relevance.ts` was already cleaned: `withCounters` is
gone and no dead clamp remains. The one surviving `halfLifeMs` is the live 1-minute recency-decay
constant (`relevance.ts:65`), not the removed clamp.

## Build / test gate

- `npx tsc --noEmit` — clean.
- `yarn build` — clean, including declaration emit (checked the emitted
  `dist/src/service/libp2p-fret-service.d.ts` signature directly, since `--noEmit` cannot catch a
  private-name leak in a `.d.ts`).
- `yarn test` — **1125 passing, 0 failing** (~4 min). No skips, no pre-existing failures.

## Review findings

**Minor — fixed in this pass.**

- `service/libp2p-fret-service.ts:147` was `return (this.ensure() as any).getDiagnostics?.()`
  returning `unknown`. The ticket's third grep item searched for `: any` and so could not see the
  cast form. This is the *same* untied-facade-drift bug the file's own header comment warns about,
  wearing different clothes: the cast compiles whether or not the core still has the method, and
  the optional call silently returns `undefined` if it ever loses it. It was also unnecessary —
  `ensure()` already returns the concrete `FretService` class, which declares
  `getDiagnostics()` public. Now a plain call with return type
  `ReturnType<CoreFretService['getDiagnostics']>`, so facade callers get the real diagnostics type
  and a core-side removal is a compile error.
- Same file, two redundant casts removed alongside it: the `inner` field was typed as the
  *interface* and then cast back to the class on every `ensure()`. Typed as the class, the cast
  goes away. No behavior change; `tsc`, build and the full suite all pass after.
- `docs/fret.md` (libp2p integration, facade bullet) claimed the `Pick<FretService, …>` tie covers
  the facade. It does not cover `getDiagnostics`, which is absent from the public `FretService`
  interface entirely — a reader following the doc would have concluded the `as any` was structurally
  impossible. Bullet now states how that one method is tied instead.

**Major — none.** The only code site this ticket could reach was the one above, and it resolves at
that site with a one-line type fix; there is no class of defect behind it to raise an invariant
against. The `Pick` tie is already the boundary invariant for the rest of the facade.

**Conditional / speculative — none recorded.** Nothing found here is of the "fine now, breaks if X
grows" shape; the single finding was wrong at HEAD and is fixed, not deferred. No `NOTE:` added.

**Considered-and-declined — none encountered.** No accepted-tradeoff `NOTE:` sits at any site this
review touched.

**Source hygiene.** Files in scope are all comfortably sized (`wc -l`: digitree-store 612,
relevance 181, libp2p-fret-service 202, distance 80, hash 70). The ring-walker extraction itself
was reviewed and landed under `cleanup-store-ring-walker` (commit `6a82e3e`) and was deliberately
not re-reviewed here.
