----
description: Review the replay-hardening work — messages must now be no older than the duplicate-request cache remembers them, request identifiers are unguessable, and the cache is sized to the node's role.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/service/dedup-cache.ts, packages/fret/src/index.ts, packages/fret/test/replay-hardening.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts, packages/fret/test/README.md, docs/fret.md, docs/threat-analysis.md, docs/threat-rir-mitigated.md
----
Three arms landed. All 335 tests pass; `npx tsc --noEmit` and `yarn build` clean.

### What changed

**1. Freshness window narrowed to the dedup TTL.** `validateTimestamp`'s default `maxDriftMs`
went 300_000 → 30_000 (`protocols.ts`). The constant it must match, `DEDUP_TTL_MS = 30_000`, is
now exported from `service/dedup-cache.ts` (and re-exported from `src/index.ts`) and is the
`DedupCache` constructor's own default, so the two numbers have one home instead of two literals
that can drift apart. `validateTimestamp` does **not** import it — that would point the rpc layer
at a service-layer module — so the alignment is held by comment on both sides, not by the type
system. All three call sites (maybeAct handler, leave, neighbor snapshot) use the default, so
none changed.

**2. Correlation IDs from the WebCrypto RNG.** New module-level, non-exported `randomToken()` in
`fret-service.ts`: `globalThis.crypto.randomUUID()`, falling back to `getRandomValues` (16 bytes,
hex) where `randomUUID` is missing, and throwing when neither exists rather than degrading to a
guessable id. `newCorrelationId(phase)` keeps its shape — `<selfId>-<timestamp>-<random>-<phase>`
— and keeps the per-phase minting introduced by `dedup-defeats-resend`; only the random segment
changed. No reuse of one id across phases was reintroduced.

**3. Dedup capacity derived from the profile.** `dedupCache` moved from a field initializer to a
constructor assignment (a field initializer runs before `this.cfg` exists), sized 2048 for Core /
512 for Edge. FIFO eviction untouched — `tickets/fix/15-dedup-cache-eviction.md` owns that code
and was deliberately not disturbed beyond adding the exported TTL constant.

### Use cases to test / validate

- **Replay of a captured maybeAct.** Send a valid activity-bearing message, wait past 30s, resend
  it. Before: it passed the timestamp check with an expired dedup entry and the work re-ran.
  Now: `validateTimestamp` rejects it and `diag.rejected.timestampBounds` increments. Inside 30s
  it still hits a live cache entry and returns the stored certificate.
- **Clock skew.** A peer whose clock is off by more than 30s can no longer talk to the ring on
  defaults. This is the real behavioral risk of the change and it is not covered by a test —
  see gaps.
- **Correlation-id unpredictability.** `test/replay-hardening.spec.ts` pins `Math.random` to a
  constant and asserts 32 minted ids still have 32 distinct random segments; also asserts the
  id shape, ≥128 bits of randomness, and the `getRandomValues` fallback (by swapping
  `globalThis.crypto` for a shim with no `randomUUID`, restored in `finally`).
- **Profile-tuned capacity.** Same spec asserts Core 2048 / Edge 512 / default Core.
- **End-to-end find-then-act still works.** `test/maybeact-dedup-phases.spec.ts` (from the
  prereq ticket) passes unchanged — the id change did not disturb phase separation.

### Known gaps — treat as a starting point

- **The capacity test reads a private field** (`(svc as any).dedupCache.maxSize`). Proving 2048
  slots behaviorally means driving 2049 inbound RPCs, which is minutes of wall clock for a
  constant; the test as written proves the profile is *wired*, not that eviction happens at that
  count. A reviewer may judge that too white-box.
- **No test covers the "neither randomUUID nor getRandomValues" throw.** Faking that means
  deleting `globalThis.crypto` entirely, which other libp2p machinery in the same process uses.
  The branch is read-only-verified.
- **No test asserts a >30s replay is rejected end to end.** `payload-bounds-ttl.spec.ts` covers
  `validateTimestamp` directly and covers a 10-minute-stale message reaching `handleMaybeAct`,
  but nothing exercises "cached, expired, resent" as one flow against a live service.
- **The 30s window is now the tightest constraint on clock skew in the system**, and nothing
  surfaces skew as a diagnosis: a badly-skewed peer just sees every RPC rejected with
  `timestampBounds`. Whether that deserves a distinct signal is a judgment call for the reviewer.
- **`docs/threat-analysis.md` was stale beyond this ticket's arms** (e.g. §3.4 still says the
  inbound announce handler has zero rate limiting, which is no longer true). Only the three
  findings this ticket closes were annotated with a `Status` line; the rest was left alone as
  out of scope, but the file as a whole should not be read as current.
- **Leave-notice replay is untouched** — no correlation id, no dedup — and remains owned by the
  leave-authentication work. `docs/fret.md`'s planned list still carries that arm.

### Docs updated

`docs/fret.md` current-state bullets (±30s bound with the reason for the alignment, profile-tuned
dedup capacity, WebCrypto correlation ids) and the planned list trimmed to just the leave-notice
arm. `docs/threat-analysis.md` §3.2/§3.3/§5.4/§5.6 annotated. `docs/threat-rir-mitigated.md` §5.4
re-rated to "Residual: None (fixed in FRET)". `packages/fret/test/README.md` gained the new spec
and the corrected `validateTimestamp` line.
