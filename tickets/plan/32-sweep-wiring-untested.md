----
description: The service keeps two small bookkeeping tables tidy by cleaning them out on a timer; nothing in the test suite checks that the cleanup is actually hooked up to that timer, so it could be disconnected without any test noticing.
files: packages/fret/src/service/fret-service.ts (`sweepBoundedMaps`, called from `stabilizeOnce`), packages/fret/test/profile.behavior.spec.ts (the `Bounded internal map capacities` block is where this belongs)
difficulty: easy
tradeoffs: The behavior being pinned is a single method call that is unlikely to be deleted by accident, and the underlying cleanup logic is already well covered on its own — so a maintainer may reasonably judge this a low-value test that costs a fake-clock fixture and a real service start.
----

## What is untested

The service holds two small internal tables that must not grow without bound: one tracking how long
to wait before re-probing a peer, one debouncing repeated departure announcements. Both are bounded
two ways — a hard size cap, and a cleanup pass that drops stale entries. The cap is now covered by
tests (`map-capacity-bounds-tests`), and the cleanup logic itself is covered in isolation
(`test/expiring-map.spec.ts`, plus a direct test of the "drop entries for peers no longer in the
routing table" pass).

What no test covers is the **wiring**: that the periodic maintenance tick actually invokes the
cleanup. Without it the tables would only ever shrink when the size cap forced an eviction, so a
stale entry could occupy a slot indefinitely — the exact failure mode the cleanup exists to prevent,
and one that no existing test would catch.

## What a test would need to do

Both real lifetimes (2 seconds and 5 minutes) are too long or too awkward to wait out, so the test
needs to swap in tables driven by a caller-controlled clock — the same technique
`test/ring-membership.spec.ts` already uses for the retention-expiry spec. Then: seed one expired
entry in each table plus one entry that should *survive*, drive a single maintenance tick, and
assert the stale entries are gone and the live one is not. Including a surviving entry is the point;
asserting only that things disappear would also pass if the tick simply cleared everything.

Belongs in the existing `Bounded internal map capacities` block in `test/profile.behavior.spec.ts`,
next to the capacity assertions it completes.
