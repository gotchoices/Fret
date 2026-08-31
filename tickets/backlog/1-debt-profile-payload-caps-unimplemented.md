description: The design document describes two behaviours the code does not actually have — smaller work-payload limits on lightweight nodes, and an automatic exit from "active" mode once nothing needs it. Before calling this 1.0, each one should either be built or removed from the document.
files:
  - docs/fret.md (*Operating profiles*, and *Active vs passive state*)
  - packages/fret/src/service/fret-service.ts (`handleMaybeAct` activity-size check; `setMode` ~1249; `activePreconnectTick` ~1770)
  - packages/fret/src/rpc/validate.ts (`parseRouteAndMaybeAct`)
difficulty: easy
tradeoffs: Both arms are cheap to resolve in the "delete the claim" direction and moderate in the "build it" direction, so the cost is really the decision, not the code. A maintainer who only ever runs server-grade nodes, and whose embedder manages FRET's mode explicitly, would reasonably delete both claims and move on.
----

# Two places where `docs/fret.md` describes behaviour the code does not have

These are one ticket because they are one unsettled question — *is the relevant section of
`docs/fret.md` describing intent or describing the implementation?* — with the same two-way
resolution in each arm: **build it, or delete the claim.** They are not one code site, and the
arms can be resolved in opposite directions if that is the honest answer.

This matters now rather than later because 1.0 is the point at which the document stops being a
design sketch and starts being a contract a consumer reads before adopting the library.

## Arm A — profile-dependent payload caps

`docs/fret.md` (*Operating profiles*) states two postures:

- Edge: "Stricter payload caps; prefer digest-only until confidently near-cluster"
- Core: "Larger payload caps; earlier inclusion of activity to reduce RTTs"

Only the *wire byte cap* was ever profile-split, and `15.4-rpc-byte-cap-tightening` (complete)
removed that split deliberately — an inbound byte cap bounds what a *peer* may legally send, and
Edge and Core nodes talk to each other, so it must admit the largest emission of any profile. The
cap that actually decides whether a payload is accepted is `handleMaybeAct`'s activity-size check,
a fixed 128 KiB on both profiles. So the two profiles accept identical activity payloads and the
documented difference is implemented nowhere.

Two honest resolutions:

1. **Build it** — make the activity cap profile-derived (e.g. Core 128 KiB / Edge 32 KiB). The
   constant is not the work; the interaction with `shouldIncludePayload` is. A sender whose
   payload-inclusion heuristic said "near enough, attach the activity" can now be refused by an
   Edge cluster member and must fall back to a digest probe plus a resend elsewhere. That fallback
   has to actually work, or an Edge-hosted cluster silently drops activities.
2. **Delete the claim** — remove the "stricter / larger payload caps" halves of those two bullets
   and state that payload size is profile-independent, with the cross-profile reasoning above as
   the *why*.

Note the "prefer digest-only until confidently near-cluster" half of the Edge bullet is a
**separate** claim, about `shouldIncludePayload`'s confidence threshold. Check whether that half is
implemented before editing the bullet in either direction — it may be true while its neighbour is
false.

## Arm B — "refcount-based" active mode

`docs/fret.md` (*Active vs passive state*) says:

> Active (connection warm-up; refcount-based): when an operation starts, enter active mode …
> Exit active when all refcounts drop to zero; revert to passive.

There is no refcount. `setMode(mode)` (`fret-service.ts:1249`) is a plain flag setter: it assigns
`this.mode` and, for `'active'`, arms the preconnect loop. Nothing counts outstanding operations
and nothing returns the service to passive on its own — the loop's own tick exits when it observes
`this.mode !== 'active'`, which only happens because a caller set it back.

Everything *else* in that section is implemented and should not be re-specified: the pooled
per-second warm-up pass (`activePreconnectTick`, Core 6 / Edge 3, pooled at
`maintenanceConcurrency`), the one-shot pass at `start()` (`preconnectNeighbors`), the generation
guard, and the timer teardown on `stop()`. This arm is *only* about the refcount claim.

Two honest resolutions:

1. **Build it** — an `acquireActive()` / `release()` pair (or a counted `setMode`) that flips back
   to passive at zero. Needs a decision on what happens to a caller that leaks a reference, since a
   leaked one pins the node in active mode and its per-second dial budget forever.
2. **Delete the claim** — state that mode is set explicitly by the embedder and that refcounting,
   if wanted, belongs to the embedder. This is arguably the more honest description of a library
   whose host already knows when its own operations start and finish.

## Also fold in

The former `debt-maybeact-activity-cap-no-edge-split` ticket was a duplicate of Arm A — same
claim, same site, same decision — and is deleted rather than kept alongside.

The former `plan/3-active-preconnect` ticket asked for the warm-up pass that has since shipped.
Its one genuinely unbuilt arm besides the refcount was "back off on dial failures with exponential
backoff and jitter", which is **deliberately declined**, not missing: `docs/fret.md` records that
the warm-up passes score nothing against a peer at all (`pingsSent` counts only a completed ping, a
task failing under an aborted run logs nothing). Do not reintroduce it as part of this ticket.

## TODO

- [ ] Arm A: decide build-vs-delete for the profile payload caps; if building, cover the
      `shouldIncludePayload` fallback path, not just the constant
- [ ] Arm A: check whether "prefer digest-only until confidently near-cluster" is implemented
      before editing that bullet either way
- [ ] Arm B: decide build-vs-delete for refcount-based active mode
- [ ] Whichever way each arm goes, leave `docs/fret.md` and the code agreeing
