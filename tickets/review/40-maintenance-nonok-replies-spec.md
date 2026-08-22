description: A test file was added that checks the network code handles peers replying "I'm busy" or with garbage; the review of that test file has been cut short by a budget limit twice and still needs finishing.
files: packages/fret/test/maintenance-nonok-replies.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/test/helpers/backoff.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/service/probe-backoff.ts, packages/fret/test/fetch-snapshot-failure-arms.spec.ts, docs/fret.md
difficulty: medium
---

<!-- resume-note -->
Two prior review runs were cut off by `BUDGET_WARNING`. **No code has been changed, no findings
filed, and no validation run.** The whole review is still owed. Read *Budget discipline* below
before doing anything else — the cheap-first ordering there is what the two lost runs got wrong.

## The diff under review

One commit, `1b85381`, **test-only**: it adds `packages/fret/test/maintenance-nonok-replies.spec.ts`
(197 lines) and moves the ticket file. No production source changed. The `Behavior` widening in
`test/helpers/maintenance-rig.ts` (`busy` / `not-ok` / `undecodable`, per-(peer, protocol)
overrides) landed earlier on this branch in `9b7c410` under a different ticket — context, not work
to review here. Do not re-read the git history; that is all of it.

## Budget discipline (why two runs died)

Both lost runs spent their budget on reading. Order the work so a third cut-off still leaves
something banked:

- Run `npx tsc --noEmit` and `yarn test` **first** — they cost wall-clock, not context, and a green
  gate is the one deliverable that cannot be inferred later.
- Then read only the line ranges named below. They were located by grep in run two and are
  accurate as of `1b85381`; grep the symbol if a range looks off rather than reading around it.
- The `Bash` tool's working directory **persists between calls**. After one `cd packages/fret`, a
  later `cd packages/fret` fails with "No such file or directory". Use absolute paths.

## Where the production arms live (`packages/fret/src/service/fret-service.ts`)

Located already — do not re-discover:

| Symbol | Lines |
|---|---|
| `noteAnsweredOnProtocol` | ~816–830 |
| `noteRpcFailure` | ~858–900 |
| `nearProbeTargets` | ~2383–2400 |
| `probeAndFetch` | ~2400–2412 |
| `probeNeighborLatency` | ~2428–2480 |
| `fetchAndMergeSnapshot` | ~2725–2770 |

`ProbeBackoff` is its own module: `packages/fret/src/service/probe-backoff.ts`.

## Observations recorded but NOT dispositioned

Candidate findings from reading the spec and the rig alone. **None has been checked against the
production code.** Not a verdict — each still needs the "is this real" pass before it is fixed,
filed, or dropped.

- **`expectAnsweredNotStruck` asserts `membership === 'member'` against a peer seeded as `member`.**
  That can only ever catch a *demotion*; it never confirms the promotion the spec's headline claims
  ("an answer on our protocol confirms membership"). Seeding `unknown` on one arm would make it
  load-bearing — but the near list is live-member-gated (`nearProbeTargets`), so an `unknown` peer
  very likely is not selected by the near pass at all, in which case the assertion is as strong as
  this rig can make it and the *comment* overstates what it proves. Read `nearProbeTargets`, decide
  which, and either strengthen the arm or soften the comment.
- **Case 3 (`undecodable`) drops the `pingsOk` delta assertion** that cases 1 and 2 both carry.
  Almost certainly an oversight; one line restores symmetry.
- **`backoffOf(...).factor(id)` semantics are assumed, not confirmed.** Three arms depend on them
  (`> 0` on busy, `=== 0` on the two decay arms). `test/helpers/backoff.ts` was read in run two and
  is a thin private-field accessor — it settles nothing. Confirm in `probe-backoff.ts` that
  `factor()` returns `0` (not `undefined`, not a throw) for a peer with **no** backoff entry, or
  the two `=== 0` assertions may be passing by coincidence.
- **Overlap with `fetch-snapshot-failure-arms.spec.ts` is asserted by the implementer, not
  verified.** The handoff invites deleting case 4 if a reviewer disagrees it is distinct. Read that
  spec and make the call.
- **Every assertion is untested against the production arms.** The spec's claims about which arm
  moves which counter are plausible and internally consistent, but a review that never read the
  code under test has verified nothing. This is the core of the remaining work.

## The finding the implementer deliberately escalated

`getDiagnostics()` returns the live `diag` object rather than a copy
(`packages/fret/src/service/fret-service.ts:511`), so **any** spec that captures it as an object and
diffs later reads zero deltas and passes vacuously. This spec avoids the trap by reading scalars.
Two things are owed, neither done:

- **The audit.** Grep the other specs for the object-snapshot pattern. A spec with the hole is
  passing vacuously *today* — a real defect, not a tripwire.
- **The disposition.** A frozen shallow copy would make the bad pattern unrepresentable, at a
  per-call allocation cost, and it is a production change. Climb *Architecture first* before filing
  anything: this is a types/representation fix if it is worth doing at all. If declined, it needs an
  accepted-tradeoff `NOTE:` at the `getDiagnostics` site — the trap is currently documented only in
  one spec's header, which is the wrong home for a class-level concern.

## Validation still owed

Nothing has been run.

- `cd packages/fret && npx tsc --noEmit`
- `cd packages/fret && yarn test` (~8 min; foreground, no redirection — see the runner rules)

There is no lint step in this repo; `yarn check` (typecheck + build + test) is the gate, and
`yarn format` / `yarn format:check` must **not** be run (see AGENTS.md).

## Docs

`docs/fret.md` line 79 forward-references `test/maintenance-nonok-replies.spec.ts` twice. The
implementer says both were verified against the landed filename; not re-checked. Confirm it, and
check whether any *other* doc claim the spec touches (the `busy`-records-backoff arm, the
`fetchAndMergeSnapshot` silent arm) is stated in the document but unpinned or misstated.

## Handoff being reviewed

The implement-stage handoff claimed: four cases, all passing; `tsc --noEmit` clean; `yarn test`
1264 passing / 0 failing; no `.pre-existing-error.md` written. It was honest about its gaps —
coarse backoff assertion (factor `> 0` only, arithmetic left to `debt-backoff-map-test-surface`),
core profile only, one peer per case, no negative-pong arm on the fetch side (the rig rejects it
loudly and a neighbors reply has no `ok` field), and no comparative case proving a bad answer
scores *lower* than a good one. Treat those as the floor the review should push on, not as settled
scope.
