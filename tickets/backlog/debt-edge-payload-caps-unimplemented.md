description: The design says small, battery-powered nodes should accept smaller work payloads than server-grade ones, but in practice both accept exactly the same size. Either implement the smaller limit for small nodes or drop the claim from the design document.
files: packages/fret/src/service/fret-service.ts, docs/fret.md
tradeoffs: A smaller limit on lightweight nodes means an activity that a server-grade node would happily perform is refused by a lightweight one, which pushes work back onto the routing layer for no benefit unless someone is actually running FRET on constrained hardware — so a maintainer with only server deployments would reasonably defer this indefinitely.
----

`docs/fret.md` (*Operating profiles*) states two payload postures:

- Edge: "Stricter payload caps; prefer digest-only until confidently near-cluster"
- Core: "Larger payload caps; earlier inclusion of activity to reduce RTTs"

Only the *wire byte cap* was ever profile-split, and `15.4-rpc-byte-cap-tightening` removes that
split because it was cosmetic — the cap that actually decides whether a payload is accepted is
`handleMaybeAct`'s activity check, which is a fixed 128 KiB on both profiles. So after `15.4` the
two profiles accept identical activity payloads and the documented difference is not implemented
anywhere.

This is the same shape as `debt-inbound-stream-caps-unimplemented`: stated design intent with no
code behind it. Two honest resolutions, and a human should pick:

1. **Implement it** — make the activity cap profile-derived (e.g. Core 128 KiB / Edge 32 KiB), with
   the wire cap following it as `15.4` sets up. This changes what an Edge-hosted cluster will
   accept, so a sender whose payload-inclusion heuristic said "near enough, attach the activity"
   can now be refused by an Edge member and must fall back to a digest probe plus a resend
   elsewhere. That interaction with `shouldIncludePayload` is the real work; the constant is not.
2. **Drop the claim** — delete the "stricter/larger payload caps" bullets from *Operating profiles*
   and state that payload size is profile-independent.

The "prefer digest-only until confidently near-cluster" half of the Edge bullet is a *separate*
claim about `shouldIncludePayload`'s confidence threshold and is not covered here — check whether
that half is implemented before editing the bullet either way.
