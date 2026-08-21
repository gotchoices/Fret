description: Finish reviewing a change that gives each kind of rejected inbound message its own diagnostic counter, and that fixes a case where certain malformed messages were dropped silently. A first review pass ran out of budget partway through; this ticket carries the corrected list of what to look at and what is still unchecked.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.handler-fuzz.wire.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts, packages/fret/test/helpers/rate-limited.ts, docs/fret.md
difficulty: medium
---

<!-- resume-note -->
Prior review run was budget-killed after reading the source diffs but **before running the
gate**. No log file was written. What that run established, and what it did not, is below.
Partial change in the working tree: one comment edit in `fret-service.ts` (see *Fixed inline*).
Nothing else was touched.

## Correction to the prior ticket's commit list — read this first

The review ticket this replaces named seven commits and gave a suggested diff range of
`db2732b~1..5e5209c`. **That range contains no source changes at all.** Verified:

```
git show --stat 2a71574 6081a8f 5e5209c    # each touches only tickets/*.md
```

The commit that actually made the change is **`71be306`** (`ticket(implement):
rejection-diagnostics-conflated`), which the prior ticket does not mention. It is ~53 commits
back from HEAD, and it is the only commit that touches `src/service/fret-service.ts`:

```
git log --oneline -S'concurrencyLimited' -- packages/fret/src   # -> 71be306, sole hit
```

The prior ticket's "what changed" section was written from consumed ticket history rather than
from the commits, and its own handoff says so. Its *description of the resulting behavior* is
accurate — the counter split and the `maybe-act.ts` fix are real and are at HEAD, confirmed by
reading `git show 71be306 -- packages/fret/src` and `git show 9285e95 -- packages/fret/src/rpc/maybe-act.ts`.
What was wrong was only the provenance. Do not re-derive the list; use this one.

**Real span, source and docs only:**

```
git log --oneline 71be306~1..HEAD -- packages/fret/src packages/fret/test docs/fret.md
```

which yields, oldest first — `71be306`, `64bbda5`, `c28c70e`, `d6b7727`, `3dbc106`, `c04b73b`,
`8191df7`, `9285e95`, `7a229e9`, `234c62f`, `5461cf3`, `16617d8`, `c9db85e`, `6429356`. Note
several of those belong to **other** tickets (`sweep-wiring-untested`,
`fetch-snapshot-failure-arms-*`, `sim-placement-guards-no-control`) and are out of scope here —
filter to the four files-of-interest rather than reading the span whole.

## What the change actually is (re-derived from the commits, not from ticket history)

- `71be306` — the whole source change. `diag.rejected.rateLimited` goes from a bare number to
  `{neighbors, ping, maybeAct, leave, announce}`, with each of the five bucket-rejection sites
  incrementing its own field. New sibling `diag.rejected.concurrencyLimited` takes over the
  maybeAct inflight-cap rejection, which previously shared `rateLimited`. `registerMaybeAct`
  gains an `onMalformed` callback and a `try/catch` around `decodeJson`.
- `9285e95` — the behavior fix proper. `71be306`'s catch still replied with a static empty
  `NearAnchor`; this commit deletes that `sendFramed` so the undecodable-body path drops
  silently instead, on the stated ground that `decodeJson` runs *upstream* of the maybeAct token
  bucket, so replying there would be an unmetered reply-per-message amplification path.
  Metered → answer, unmetered → drop.
- `3dbc106`, `6429356` — test call-site updates and a deleted `test/helpers/rate-limited.ts`.
- Docs touched incidentally by `3dbc106` (11 lines) and `9285e95` (1 line).

## Verified so far

- Every `rejected.rateLimited` reference in `src/` uses a keyed field; none is a bare unindexed
  counter. Counted at `fret-service.ts` lines 1293, 1301, 1384, 1841, 2002 — one per protocol,
  matching the five bucket sites, no site left unconverted and no double-increment.
- `concurrencyLimited` has exactly one increment site (line 1424), on the inflight arm, and the
  bucket arm above it no longer shares it.
- `9285e95`'s deletion of the static reply is the whole of that commit's source change; the
  reasoning is recorded as a comment at the site.

## Still unchecked — this is the bulk of the remaining work

- **The gate was never run by this reviewer.** `npx tsc --noEmit` and `yarn test` from
  `packages/fret/`. The prior ticket claims 1223 passing at HEAD, but that claim predates the
  comment edit now in the tree (comment-only, so it cannot change behavior — still, run it).
- **Test diffs unread.** `git show 3dbc106 -- packages/fret/test` and
  `git show 6429356 -- packages/fret/test`. In particular: `test/helpers/rate-limited.ts` was
  **deleted** in `6429356` — confirm nothing still imports it and that whatever it provided is
  genuinely obsolete rather than inlined into one caller and dropped from the others.
- **The undecodable-body path's end-to-end coverage.** The prior ticket flagged this and it is
  still the highest-risk item: confirm some test drives a genuinely undecodable body through the
  real maybeAct handler and asserts *both* that `malformed` increments *and* that the stream
  **closes** rather than aborts. `git show 9285e95 -- packages/fret/test` touched
  `rpc.handler-fuzz.spec.ts` and `rpc.handler-fuzz.wire.spec.ts`; read what those assert. A test
  that only asserts the counter would not catch a regression to the abort tier.
- **Docs.** The prior ticket asserts all three `docs/fret.md` passages are correct at HEAD and
  that no doc action is needed. That claim was made by a run that also mis-stated the commit
  list, so it is worth one direct read rather than inheriting. Check the *Operating profiles*
  concurrency-cap bullet, the leave rate-limit note, and the security/abuse rate-limiting bullet
  against the actual keyed shape.
- **Whether `diag` has a declared type.** The counter shape is written as an object literal at
  the field initializer; if there is no explicit interface for `diag.rejected`, the record shape
  is structural-only and a consumer reading `diag.rejected.rateLimited` as a number would fail at
  its own call site rather than here. Worth one look at how `getDiagnostics`' return type is
  declared, and at whether any consumer outside `src/` reads these fields.

## Fixed inline (already in the working tree)

- `fret-service.ts` — the `malformed` field's doc comment read *"Inbound maybeAct messages that
  failed `parseRouteAndMaybeAct` (structure/type)"*, which has been stale since `71be306` wired
  `registerMaybeAct`'s `onMalformed` into the same counter, and was already stale before that for
  the three `registerJsonHandler` seam call sites (lines 1229, 1244, 1257) that also increment it.
  One counter, four handlers, two tiers, and a comment naming one of them — the exact conflation
  this ticket series exists to remove, left behind in the field next door to the one that was
  split. Replaced with a comment that names all the increment sources, plus a `NOTE:` recording
  that keeping it as a single counter is deliberate (no caller has needed decode-vs-parse or
  per-protocol resolution) with the revisit condition stated. Comment text only — no behavior
  change, so it cannot move the test count.

## Process note, not work

Six budget kills across what is conceptually one focused change, and a handoff whose commit list
did not survive contact with `git log`. Retrospective material for whoever tunes ticket sizing;
nothing to fix in the code. Do not file a ticket for this.
