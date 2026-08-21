description: Review a multi-part change that gives each rejected inbound RPC its own diagnostic counter instead of lumping them together, and fixes a bug where certain malformed maybeAct messages were dropped with no counter incrementing at all.
files: src/service/fret-service.ts, src/rpc/maybe-act.ts, src/rpc/validate.ts, docs/fret.md, test/rpc.codec-properties.spec.ts, test/inflight-concurrency.spec.ts, test/payload-bounds-ttl.spec.ts, test/profile.behavior.spec.ts, test/rpc.handler-fuzz.spec.ts
---

**This is the combined review ticket for the whole `rejection-diagnostics-conflated` change —
five implement/fix commits split across five prior tickets, each stopped by a budget kill.
Review them together; none is a coherent unit alone.**

Commits, in order:
- `2a71574` ticket(implement): rejection-diagnostics-test-sites
- `db2732b` ticket(review): rejection-diagnostics-test-sites
- `6081a8f` ticket(implement): rejection-diagnostics-codec-properties
- `6429356` ticket(review): rejection-diagnostics-codec-properties
- `3dbc106` ticket(fix): rejection-counter-split-test-callsites
- `9285e95` ticket(implement): maybeact-undecodable-body-drops
- `5e5209c` ticket(implement): rejection-diagnostics-docs-gate

Five budget kills total across the series (four before the final continuation, `31.8`, plus the
continuation itself) — this ticket's own gate run is the only work `31.8` still had to do; all doc
content was already correct at HEAD when `31.8` checked it (see below).

## What changed (architecture)

1. **`diag.rejected.rateLimited` split from one counter into a per-protocol record.**
   Was a single number; is now `{neighbors, ping, maybeAct, leave, announce}`, each incremented at
   its own bucket-rejection site in `src/service/fret-service.ts` (lines ~1293, 1301, 1384, 1841,
   2002). Lets a caller tell which protocol's rate limiter is firing instead of one undifferentiated
   count.
2. **New sibling field `diag.rejected.concurrencyLimited`.** The inbound maybeAct inflight cap
   (Core 16 / Edge 4, see *Operating profiles* in `docs/fret.md`) used to share the rate-limited
   counter with the token-bucket rejection; it now increments its own field, so a bucket rejection
   and an inflight-cap rejection are distinguishable in diagnostics without depending on
   `retry_after_ms`.
3. **`maybe-act.ts` undecodable-body fix.** Previously, an undecodable maybeAct body thrown from
   inside the handler propagated out of `registerRpcHandler` and aborted the stream with **no
   diagnostic counted at all** — the rejection was invisible. Now the decode failure is caught in
   the handler body (same two-tier body-vs-frame split every other handler on the
   `registerJsonHandler` seam already follows — see *Stream management → registerJsonHandler* in
   `docs/fret.md`), logged, counted, and the stream closed normally rather than aborted.
4. **Test-site updates** (siblings `31`/test-sites and `31.5`/codec-properties): every test
   asserting against the old bare `diag.rejected.rateLimited` counter was updated to assert against
   the correct keyed field (`.leave`, `.maybeAct`, etc.) — see the grep below for the full set.
5. **Docs** (`docs/fret.md`): three passages updated to describe the keyed shape — the leave
   rate-limit note (~line 373), the concurrency-cap operating-profile bullet (~line 356-359)
   explaining the `maybeAct` vs `concurrencyLimited` distinction, and the security/abuse
   rate-limiting bullet (~line 373 area) spelling out the per-protocol record shape. **Confirmed
   correct at HEAD by `31.8`** — these had already landed via the incidental doc touch in
   `3dbc106`/`9285e95`; `31.8` re-checked all three against the ticket's stated line contents and
   found no drift. Reviewer: no doc action needed unless a later commit regresses these lines.

## Gate run (this ticket, `31.8`)

```
cd packages/fret && npx tsc --noEmit   # clean, no errors
cd packages/fret && yarn test          # 1223 passing, 0 failing (~6m)
```

Confirmed every `rejected.rateLimited` reference in `src` and `test` uses the keyed shape
(`.leave`, `.maybeAct`, `.ping`, `.neighbors`, `.announce`) or the destructured record — none is a
bare unindexed counter:

```
grep -rn "rejected\.rateLimited" src test
```

No pre-existing failures encountered.

## Known gaps / things a reviewer should check

- **No test pins the new `undefined`-decode-drop path (item 3) end to end against a real busy
  reply race** — coverage there is whatever the prior `maybeact-undecodable-body-drops` implement
  step wrote; re-verify it actually drives an undecodable body through `handleMaybeAct` and asserts
  the counter increments and the stream closes (not aborts). Grep `test/` for the new counter name
  used at that site.
- **This reviewer has not read the actual diffs of `2a71574`, `6081a8f`, `3dbc106`, `9285e95`** —
  each prior implement/fix ticket's own handoff (now consumed/deleted) was the only account of its
  diff. Treat the "what changed" list above as a synthesis from ticket history and doc content, not
  as independently re-derived from the commits. A full diff read (`git show <sha>`) is recommended
  before signing off, especially for `9285e95` (the behavior fix, highest risk of the five).
- **Five-way split itself is a process smell worth noting**, not fixing: five budget kills on what
  is conceptually one focused change suggests either the change was under-scoped at signature time
  or the budget per ticket was too tight for it. No action needed now: purely a retrospective note
  for whoever tunes ticket sizing.

## Suggested review approach

Given the fragmentation, review by diffing the whole span rather than commit-by-commit:

```
git diff db2732b~1..5e5209c -- src/service/fret-service.ts src/rpc/maybe-act.ts src/rpc/validate.ts
```

(`db2732b~1` is the parent of the first commit in the series, i.e. immediately before
`2a71574`.) Cross-check against `docs/fret.md`'s current *Operating profiles* and *Cheap-guard
rejections* sections for behavior claims the diff should match.
