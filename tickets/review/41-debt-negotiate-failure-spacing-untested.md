description: Verify the missing regression test for the negotiate-failure spacing rule — proving several failed handshakes with the same peer, arriving with no time gap, count as one strike instead of three — and confirm it actually exists and passes.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/ring-membership.spec.ts
difficulty: easy
----

## What this ticket found

The test this ticket asked for **already exists** at `packages/fret/test/ring-membership.spec.ts:640-663`:

```ts
it('counts a burst of simultaneous negotiation failures as one observation', async () => {
	...
	for (let i = 0; i < 5; i++) signal.applyMembershipSignal('burst-peer', 'negotiate-failure')
	expect(negotiateFailures(svcA, 'burst-peer')).to.equal(1, 'a burst is one observation, not five')
	expect(store.getById('burst-peer')?.membership).to.equal('member', 'a burst must not demote a member')

	// Spaced-out failures still accumulate and still demote — the run is delayed, not disabled.
	for (let i = 0; i < 2; i++) {
		await new Promise((r) => setTimeout(r, 600))
		signal.applyMembershipSignal('burst-peer', 'negotiate-failure')
	}
	expect(negotiateFailures(svcA, 'burst-peer')).to.equal(3)
	expect(store.getById('burst-peer')?.membership).to.equal('foreign', 'a genuine run must still demote')
})
```

This is a direct hit against the ticket's acceptance criteria: fires multiple `negotiate-failure`
signals back-to-back with **no** clock manipulation and **no** rewinding of
`lastNegotiateFailureAt` (the exact gap the ticket flagged — existing tests all rewind the spacing
timestamp between calls, which is why none of them would catch `NEGOTIATE_FAILURE_MIN_SPACING_MS`
being deleted). It asserts `negotiateFailures` stays at 1 (not 5) and `membership` stays `'member'`
(threshold is 3), then goes further than the ticket asked by also proving spaced-out failures still
accumulate and do eventually demote to `'foreign'` — the twin positive-and-negative case.

It reaches the private method the same way the ticket's design section anticipated: `(svcA as
unknown as { applyMembershipSignal: ... }).applyMembershipSignal(id, 'negotiate-failure')`.

`git log --oneline -- packages/fret/test/ring-membership.spec.ts` shows this test predates the
current HEAD (49669a5) that filed this ticket — it landed in an earlier commit, and the plan/backlog
gardening pass that filed this ticket did not notice it was already covered.

## Verification performed

Ran the target spec in isolation:

```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/ring-membership.spec.ts" --timeout 30000
```

Result: **33 passing**, including the burst-spacing test (1207ms) — no failures, no skips.

No code changes were made; nothing needed one. Did not re-run the full `packages/fret` suite or
`tsc --noEmit` beyond this — budget-constrained handoff, see Review findings below for what a
reviewer should still spot-check if being thorough (a full `yarn test` run costs ~a few minutes and
was not repeated here since this file's own spec run is the only thing this ticket touches).

## Review findings

- The negotiate-failure spacing regression test requested by this ticket already exists at
  `ring-membership.spec.ts:640-663` ("counts a burst of simultaneous negotiation failures as one
  observation"), added before this ticket was filed. Verified it passes in isolation (33/33 in that
  spec file). No new test was written — writing a second, near-duplicate test would violate DRY for
  no coverage gain. Ticket closed as already-satisfied rather than worked.
