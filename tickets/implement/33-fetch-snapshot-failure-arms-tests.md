description: Add tests proving that when this node asks a peer for its neighbour list and the request fails, each of the different ways it can fail is handled the way the code intends — so a future change that breaks one of those reactions gets caught instead of shipping silently.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.snapshot-merge-cap.spec.ts, packages/fret/test/dead-state.spec.ts, packages/fret/test/rpc.stream-errors.spec.ts, packages/fret/test/helpers/maintenance-rig.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
----

<!-- resume-note -->
Prior run hit the session's soft token budget during discovery, before any test code was
written or any file edited. No partial implementation exists — this is a straight re-issue of
the original ticket (`33-fetch-snapshot-failure-arms-tests`) with two corrections learned during
that run, so the next agent does not repeat the same dead-end lookups:

1. **The ticket's claim that `ok`-arm coverage lives in `packages/fret/test/rpc.handler-fuzz.spec.ts`
   is wrong.** A repo-wide grep for `fetchAndMergeSnapshot` / `probeAndFetch` /
   `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` across `packages/fret/test/` does **not** match
   `rpc.handler-fuzz.spec.ts` at all. It matches (among others) `rpc.snapshot-merge-cap.spec.ts`,
   `dead-state.spec.ts`, `rpc.stream-errors.spec.ts`, `failure-recovery.spec.ts`,
   `stabilize-concurrency.spec.ts`, `stabilize-budget-invariants.spec.ts`, `seed-new-peers.spec.ts`,
   `profile.behavior.spec.ts`. Read `rpc.snapshot-merge-cap.spec.ts` first — it counts
   `store.upsert` calls on the fetch path and is the most likely home for the existing `ok`-arm
   scaffolding (stubbed connection + stubbed reply) this ticket is meant to reuse. Confirm before
   assuming shape.
2. Confirmed still accurate: `fetchAndMergeSnapshot` is a private method on `FretService` at
   `fret-service.ts:2637-2681` (`packages/fret/src/service/fret-service.ts`), a `switch (out.kind)`
   over `RpcOutcome<NeighborSnapshotV1>` (`packages/fret/src/rpc/outcome.ts`) with arms `skipped`,
   `cancelled`, `busy`/`decode-error` (shared log line, same "score nothing" handling),
   `foreign-protocol`/`unreachable`/`timeout` (all route through `noteRpcFailure`), `ok`. Public
   call path reaches it via `probeAndFetch` at `fret-service.ts:2324-2336`, itself called from
   `stabilizeOnce`'s phase-1 pool. `RpcOutcome` variant doc-comments (in `outcome.ts`) state exactly
   what each proves about the peer — read those before writing assertions, they're the spec.

Everything below this note is the original ticket body, unchanged. No other progress was made;
proceed as if starting fresh, using the two corrections above to skip the dead-end search.

## Where this is

`packages/fret/src/service/fret-service.ts`, `fetchAndMergeSnapshot` (~line 2637) — a `switch (out.kind)`
over `RpcOutcome<NeighborSnapshotV1>` with 8 arms (`skipped`, `cancelled`, `busy`, `decode-error`,
`foreign-protocol`, `unreachable`, `timeout`, `ok`). `RpcOutcome` is defined in `src/rpc/outcome.ts`.

## What's already covered vs not

- **`ok`** — covered thoroughly by a real two-node fetch-path test (see resume-note above for which
  file — verify before assuming `rpc.handler-fuzz.spec.ts`), which drives a real reply through this
  method over a real transport and checks exactly which peers get stored.
- **`cancelled` / "nothing attempted"** — covered *indirectly* today, via the broader rule asserted in
  `packages/fret/test/dead-state.spec.ts` ("our own cancellation never counts against a peer"). Not
  asserted directly against `fetchAndMergeSnapshot`'s own bookkeeping.
- **`skipped`, `busy`, `decode-error`, `foreign-protocol`, `unreachable`, `timeout`** — not covered at all.

## Scope of this ticket: 6 of the 7 non-success arms

Write one test per arm for: `skipped`, `cancelled`, `decode-error`, `foreign-protocol`, `unreachable`,
`timeout`. Each test should drive `fetchAndMergeSnapshot` (or the public path that reaches it — see
existing call site at `fret-service.ts:2335` inside `probeAndFetch`) against a rigged outcome of that
kind, then assert:

- **`skipped`** (no connection attempted): no connection stub / undialable peer → `announced` returns
  empty, no `noteRpcFailure` bookkeeping fires (no `contactFailures` increment, no relevance decay).
  Can be driven directly — no rig change needed, just omit the stubbed connection.
- **`cancelled`** (our own abort): pass an already-aborted `AbortSignal` → same "score nothing" assertion
  as `skipped`, distinctly from `dead-state.spec.ts`'s broader/indirect coverage. This closes the "not
  directly tested against this method" gap noted above.
- **`decode-error`** (peer answered with something unreadable): stub a stream that replies with bytes
  that fail to decode as `NeighborSnapshotV1` JSON (pattern already used in
  `packages/fret/test/rpc.stream-errors.spec.ts` for other RPCs — reuse that stubbing approach rather
  than extending `maintenance-rig.ts`, since the rig's behavior abstraction doesn't need to grow for
  this). Assert: peer's membership signal raised toward `member` / contact-failure run cleared (this
  arm is proof-of-life — the peer answered on our namespaced protocol), relevance decayed, but **no**
  contact-failure strike recorded. This is the arm docs/fret.md calls out by name as the one most worth
  pinning ("Evidence strength" / "Our own cancellation is not evidence" sections).
- **`foreign-protocol`** (peer belongs to a different network): drive over a real two-node setup (like
  the existing `ok`-arm test does) where the second node never registers this network's
  `/fret/1.0.0/neighbors` handler — protocol negotiation fails. Assert `noteRpcFailure` routes this
  through `applyMembershipSignal(id, 'negotiate-failure')`, i.e. one negotiate-failure strike, not a
  contact-failure strike (see `applyMembershipSignal`, `fret-service.ts:936`).
  - Existing test may need repeats (3x) to observe the `foreign` demotion threshold, or assert the
    single-call increment of `negotiateFailures` directly rather than driving to full demotion — either
    is fine, pick whichever is less test code.
- **`unreachable`**: stub a peer with no dialable address / a dial that rejects. Assert one contact
  failure strike via `noteRpcFailure` (`applyContactFailure` path), no relevance credit.
- **`timeout`**: use `maintenance-rig.ts`'s existing `'hangs'` behavior (`hangsUntilAbort`, already
  present at `maintenance-rig.ts:35`) with a short timeout so the tick's own deadline fires. Assert same
  contact-failure strike as `unreachable` — both are "could not reach it at all" evidence per
  docs/fret.md's evidence-strength table.

Prefer one test file (either extend the file identified above next to the existing `ok`-arm test, or a
new `fetch-snapshot-failure-arms.spec.ts` alongside it) over scattering across files — the existing
fetch-path test already builds most of the scaffolding (stub reply, stubbed connection), so reuse it.

## Out of scope: the `busy` arm

The `busy` arm ("the peer said it was too busy") is **not** in scope for this ticket. Driving it needs
`maintenance-rig.ts` to answer a maintenance-protocol RPC with a non-`ok` reply shape; today the rig's
`Behavior` type is exactly `'answers' | 'hangs'` and its reply builder hard-codes `{ok: true}`
(`maintenance-rig.ts:26,127`) — there is no way to make a rigged peer answer `busy` on any maintenance
RPC today, ping included (docs/fret.md already documents the ping-side gap as untested for the same
reason). See `tickets/backlog/debt-maintenance-rig-non-ok-replies.md` for the harness-side fix; once
that lands, add the 7th test here as a small follow-up. Leaving it out now is consistent with the
original ticket's own stated tradeoff (bookkeeping-only, cheap to read instead of test) and with the
precedent already accepted for the ping-side `busy` arm.

## Expected outcome

Each of `skipped`, `cancelled`, `decode-error`, `foreign-protocol`, `unreachable`, `timeout` has a test
pinning both what bookkeeping it does and what it deliberately does not (no contact strike for
`decode-error`; no strike at all for `skipped`/`cancelled`; negotiate- not contact-strike for
`foreign-protocol`). `yarn test` (from `packages/fret/`) green.

## Edge cases & interactions

- **`decode-error` vs `foreign-protocol` vs `unreachable`/`timeout` must land on visibly different
  counters** — asserting only "no exception thrown" for all three would pass even if a future edit
  collapsed them onto the same bookkeeping path (exactly the kind of drift `docs/fret.md`'s "Evidence
  strength" table exists to prevent). Assert the specific field each is documented to touch:
  `contactFailures` (unreachable/timeout only), `negotiateFailures` (foreign-protocol only), relevance
  decay (decode-error, and unreachable/timeout), membership signal (decode-error only, via
  `noteAnsweredOnProtocol`).
- **`cancelled` test must not accidentally exercise `skipped`'s path** (e.g. by also having no stubbed
  connection) — keep the two tests' setups minimal and distinct so a regression in one doesn't
  silently pass because the other's assertion is what's really firing.
- **Timeout test must not flake on real wall-clock timing** — use the rig's configurable timeout/short
  deadline rather than depending on `MAINTENANCE_SNAPSHOT_TIMEOUT_MS`'s real 1000ms value directly if
  the existing test infra supports overriding it (check how other maintenance-rig specs already do
  this before inventing a new mechanism).

## TODO

- Confirm which existing spec file holds the `ok`-arm fetch-path test (see resume-note — not
  `rpc.handler-fuzz.spec.ts`; `rpc.snapshot-merge-cap.spec.ts` is the leading candidate) and reuse its
  scaffolding
- Add `skipped` arm test
- Add `cancelled` arm test (direct against `fetchAndMergeSnapshot`, distinct from `dead-state.spec.ts`'s indirect coverage)
- Add `decode-error` arm test
- Add `foreign-protocol` arm test
- Add `unreachable` arm test
- Add `timeout` arm test
- Run `yarn test` from `packages/fret/` and confirm green
- Leave `busy` arm out of scope; confirm `tickets/backlog/debt-maintenance-rig-non-ok-replies.md` still describes it

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
