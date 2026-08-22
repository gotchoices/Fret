description: When several things fail to talk to the same peer at the same instant, our code is supposed to treat that as one piece of evidence rather than three — that rule is written down and relied on, but nothing tests it, so a change that removed it would go unnoticed.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/dead-state.spec.ts
difficulty: easy
tradeoffs: The rule is simple and stable, and its twin (the contact-failure side) is already tested, so a maintainer could reasonably judge the risk of it silently disappearing to be low and spend the effort elsewhere.
----

## What is unprotected

FRET marks a peer as belonging to a different network only after **three** failed protocol
negotiations, and only when those three failures are **spread out in time**. The spreading rule is
what makes three failures three independent observations rather than one bad moment observed three
times: several callers hitting the same restarting peer in the same instant all fail together, and
that must count once.

The rule lives in one place — the `negotiate-failure` arm of `applyMembershipSignal` in
`packages/fret/src/service/fret-service.ts` (around line 979) — which ignores any failure landing
within 500 ms of the last counted one.

## Why this is a gap rather than an opinion

The matching rule on the *other* counter — failures to reach a peer at all — **is** tested:
`packages/fret/test/dead-state.spec.ts` has "counts failures inside the spacing window as one
observation".

For the negotiation counter there is no equivalent. Every test that touches it does the opposite:
it rewinds the timestamp so that strikes *do* count (`dead-state.spec.ts:164`,
`failure-recovery.spec.ts:71` and `:431`). So the tests all depend on the timestamp field existing,
and none of them would fail if the 500 ms check itself were deleted — a peer would then be written
off as foreign on a single momentary blip, which is exactly the failure the check exists to prevent.

## What "done" looks like

One test that fires several negotiation failures against the same peer back-to-back, with no clock
rewinding, and asserts the counter moved by one rather than by the number of failures. It belongs
beside the existing membership-labelling tests, not in the snapshot-fetch specs — those exercise the
call sites, while this rule lives at the counter.

Nothing about the shipped behaviour needs to change; this is test coverage for a rule that is
already correct.
