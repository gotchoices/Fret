---
description: Peers tell each other how big they think the network is, along with how sure they are. The "how sure" number is never checked to be a sensible percentage, so one peer sending a wildly out-of-range value can single-handedly overwrite everyone else's view of the network size.
files: packages/fret/src/rpc/validate.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/service/size-observer.ts
difficulty: easy
repro: static
severity: wrong-result
likelihood: contrived
tradeoffs: Requires a malicious or badly-broken peer to exploit, and the whole peer-reported-size channel is already documented as unauthenticated and pending Sybil-resistant redesign — a maintainer may reasonably want the range check to land as part of that work rather than on its own.
---
Found during review of `23.1-size-observer-extraction`; the code involved is pre-existing and was
carried across unchanged by that ticket, so this is not a regression it introduced.

## What is wrong

Two wire messages carry a `confidence` number that the design document defines as living in the
range 0 to 1:

- the neighbor snapshot (`NeighborSnapshotV1.confidence`)
- the ping reply (`parsePingResponse`)

The wire-shape parsers in `src/rpc/validate.ts` check only that the value is a finite number. They
do not check that it is between 0 and 1. Nothing downstream checks it either: the service's
`calibrateSizeFromSnapshot` gates on "greater than zero" for both fields and then hands the value
straight to the size-observation blender.

The blender weights every reported size by `recency x confidence`. So a peer that reports
`confidence: 1_000_000_000` alongside any size it likes contributes a weight that swamps every
honest observation, including this node's own locally-computed estimate. The blended size becomes
whatever that one peer said, and the reported confidence — clamped on output — reads as a fully
confident 1.0.

The network size estimate is not cosmetic: the cluster span and the routing "near radius" are both
derived from it, so a hijacked estimate changes which peers a node believes are in-cluster and how
it routes.

The same gap lets a negative confidence through, which subtracts weight rather than adding it.

## Root cause, and the shape of the fix

One site: the numeric vetting in `src/rpc/validate.ts`. Today it has a single helper that means
"finite number or drop it". There is no helper that means "a number inside a stated range or drop
it", so every range rule the wire formats state ends up either unenforced or restated at some
consumer far from the parser.

Prefer adding that range-checked helper at the parser seam over patching the size observer. The
parsers are documented as the one place every wire-shape rule lives, and a value that has passed
them should already be in range — that makes an out-of-range confidence unrepresentable past the
boundary instead of something each consumer has to remember to guard. The observer's own
non-finite refusal is the same idea and is a useful backstop, but it is one layer too late to be
the primary defence.

Worth reviewing at the same time whether `size_estimate`'s "greater than zero" rule belongs at the
parser too, rather than only at `calibrateSizeFromSnapshot`.

## Related

`tickets/backlog/debt-maybeact-activity-cap-no-edge-split` also names `validate.ts`, but for the
maybeAct activity byte cap — a different rule in the same module, not this one.

The wider "peer-reported sizes are unauthenticated" concern is already recorded in `docs/fret.md`
under *Network size estimation* and belongs to the planned size-consensus / bounded-gossip work.
This ticket is narrower: even a fully authenticated peer should not be able to state a confidence
outside the range its own wire format defines.
