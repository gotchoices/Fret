description: Checked whether the requested regression test for the negotiate-failure spacing rule was missing — it already existed, passes, and genuinely catches the rule being deleted, so no new test was written.
files: packages/fret/test/ring-membership.spec.ts, docs/fret.md
----

## Outcome

The test this ticket asked for already existed before the ticket was filed. It lives in
`packages/fret/test/ring-membership.spec.ts` as "counts a burst of simultaneous negotiation
failures as one observation": it fires five `negotiate-failure` signals back-to-back with no clock
manipulation and no rewinding of `lastNegotiateFailureAt`, asserts the strike count stays at 1 and
the peer stays a `member`, then sleeps past the spacing window twice and asserts the count reaches
3 and the peer demotes to `foreign`.

Provenance confirmed: the test landed in commit 46b5c85 (`ticket(review):
membership-classification-strength`), which `git merge-base --is-ancestor` confirms is an ancestor
of 49669a5, the plan commit that filed this ticket. The gardening pass that filed it did not see the
existing coverage.

No production code changed in this ticket's whole lifecycle — the implement stage's commit (ea4866c)
moved the ticket file and nothing else.

## Review findings

**Checked**

- The implement-stage diff (ea4866c), read before its handoff summary: it is a ticket-file move
  only, no source or test changes. Its central claim — "the test already exists" — is accurate.
- Whether the existing test actually *bites*, rather than merely passing. It does: with the 500 ms
  spacing check removed, five back-to-back signals would take the count to
  `min(5, NEGOTIATE_FAILURE_THRESHOLD) = 3` and flip membership to `foreign`, failing both of the
  first-phase assertions. This is arithmetic over the guard, not a mutation run — the guard was not
  edited to prove it, since the working tree is shared with concurrent ticket runs.
- Whether a second test should be written anyway. No: it would be a near-duplicate of an existing
  test at the same seam, and the existing one covers strictly more (it pins the positive
  spaced-out-failures-still-demote arm the ticket did not ask for).
- Test quality of the existing test beyond the ticket's ask: it drives the private guard through a
  typed cast rather than `as any`, seeds its peer directly in the store, and asserts with messages.
  No cleanup gap — the service is registered in the spec's `services` array.
- Docs: `docs/fret.md` "Why the run must be spread over time" described the rule correctly but,
  unlike its neighbours, named no pinning spec.

**Found and fixed inline (minor)**

- `docs/fret.md`: added the pin citation to the spacing paragraph, naming the spec and stating why
  it is the only one that would catch the check being deleted (every other spec rewinds
  `lastNegotiateFailureAt` between strikes).
- `packages/fret/test/ring-membership.spec.ts`: added a `NOTE:` beside the 600 ms sleep recording
  that it is sized against the 500 ms constant, that a late timer only widens the gap so it cannot
  flake, and that the sleep must rise if the constant does.

**Major findings**

None. There is no implementation to find defects in — the diff under review contains no code.

**Tripwires**

One, parked as the `NOTE:` above rather than as a ticket: the test's sleep duration is coupled to
`NEGOTIATE_FAILURE_MIN_SPACING_MS`. It is fine at today's 500 ms / 600 ms values and only becomes
work if that constant is raised.

**Accepted tradeoffs encountered**

None at the sites touched.

## Verification

- `npx tsc --noEmit` from `packages/fret` — clean.
- `yarn test` from `packages/fret` — **1264 passing**, no failures, no skips (the implement stage
  had deferred this full run on budget grounds; it is done now).
- `test/ring-membership.spec.ts` re-run after the comment edit — 33 passing.

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
