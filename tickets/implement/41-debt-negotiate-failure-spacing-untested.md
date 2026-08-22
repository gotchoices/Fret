description: Add a missing test proving that several failed handshakes with the same peer, arriving back-to-back with no time gap, count as one strike instead of three — otherwise a future change could silently delete that protection and nothing would fail.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/dead-state.spec.ts
difficulty: easy
----

## Design (resolved)

The rule under test lives in `FretService.applyMembershipSignal` (`packages/fret/src/service/fret-service.ts:978`),
`negotiate-failure` arm at lines 996–1012:

```ts
case 'negotiate-failure': {
	const now = Date.now();
	if (now - e.lastNegotiateFailureAt < FretService.NEGOTIATE_FAILURE_MIN_SPACING_MS) return;
	const failures = Math.min(e.negotiateFailures + 1, FretService.NEGOTIATE_FAILURE_THRESHOLD);
	const patch: PeerPatch = { negotiateFailures: failures, lastNegotiateFailureAt: now };
	if (failures >= FretService.NEGOTIATE_FAILURE_THRESHOLD && e.membership !== 'foreign') {
		patch.membership = 'foreign';
	}
	this.store.update(id, patch);
	return;
}
```

`NEGOTIATE_FAILURE_MIN_SPACING_MS` is 500ms (see `docs/fret.md`, "Why the run must be spread over
time"). Its exact twin already exists for the *contact*-failure counter and is pinned in
`packages/fret/test/dead-state.spec.ts` around lines 111–155:

```ts
/** Rewind the spacing timestamp so the next strike counts as an independent observation. */
function unspace(id: string): void {
	store.update(id, { lastContactFailureAt: 0 })
}

it('counts failures inside the spacing window as one observation', async () => {
	const id = seedPeer('peer-c')
	await strike(id)
	await strike(id)
	await strike(id)

	expect(store.getById(id)?.contactFailures).to.equal(1)
	expect(store.getById(id)?.state).to.not.equal('dead')
})
```

Mirror that shape for the negotiate-failure counter. The new test belongs beside the existing
membership-labelling tests in `packages/fret/test/ring-membership.spec.ts` (that file already has
`as any` casts reaching `applyMembershipSignal` per the NOTE at `fret-service.ts:965`), not in
`dead-state.spec.ts` — this ticket's `files:` lists both only as reference material for the pattern
and the field names.

Do not rewind `lastNegotiateFailureAt` between calls (contrast with the existing tests at
`ring-membership.spec.ts` / `dead-state.spec.ts` that *do* rewind it, e.g. `dead-state.spec.ts:165`,
which is exactly why none of the current tests would catch the 500ms check being deleted).

## Edge cases & interactions

- Fire three (or more) `negotiate-failure` signals against the same peer with **no** clock
  manipulation and no rewinding of `lastNegotiateFailureAt`. Assert `negotiateFailures` ends at 1,
  not 3, and `membership` is **not** `'foreign'` (threshold is 3; one counted strike must stay well
  below it).
- Access the private method the same way the existing specs do: `(svc as any).applyMembershipSignal(id, 'negotiate-failure')`
  (see the `as any` casts already in `ring-membership.spec.ts`), or via whatever public seam those
  tests use to drive a negotiate-failure signal if one already exists in that file — check the file
  first rather than assuming the private-cast style is the only option.
- Do not assert on wall-clock timing directly (no `sinon` fake timers needed) — three synchronous
  calls in a row are already "the same instant" for the 500ms window, exactly as the contact-failure
  twin test does.
- Nothing about shipped behavior changes; this is a pure test addition. Run
  `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/ring-membership.spec.ts" --timeout 30000`
  to confirm the new test passes, then run the full suite (`yarn test` from `packages/fret/`) before
  handoff.

## TODO

- Add the spacing test to `packages/fret/test/ring-membership.spec.ts`, mirroring
  `dead-state.spec.ts`'s "counts failures inside the spacing window as one observation" but against
  `negotiateFailures` / `lastNegotiateFailureAt` / the `negotiate-failure` signal instead of the
  contact-failure counter.
- Run the full `packages/fret` test suite and `npx tsc --noEmit` to confirm no regressions.
