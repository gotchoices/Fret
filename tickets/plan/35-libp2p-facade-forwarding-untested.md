description: The libp2p wrapper around the core networking service forwards every call by hand, and nothing checks that those calls actually arrive with the right arguments in the right order — a swapped pair of numbers would go unnoticed.
files: packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/libp2p-service-node-source.spec.ts
difficulty: easy
tradeoffs: Every method is a one-line forward that a reader can eyeball in seconds, so a maintainer may reasonably judge a whole test file too much ceremony for the size of the risk.
---
`Libp2pFretService` re-exposes all 21 members of the public `FretService` interface as
hand-written one-line pass-throughs to the core service. Since it now declares
`implements Startable, FretService`, the *compiler* guarantees the surface is complete and every
signature matches. What no check covers is whether each body forwards **the arguments it was
given, unchanged and in order**, and returns what the core returned.

That gap is not hypothetical for one shape in particular. `reportNetworkSize(estimate: number,
confidence: number, source?: string)` takes two adjacent numbers; a body that forwarded them
swapped would type-check perfectly and silently feed the size estimator a confidence value as a
population count. Nothing today would catch it — the existing wrapper spec
(`test/libp2p-service-node-source.spec.ts`) covers only where the node reference comes from.

## What to build

One table-driven test, not 21 hand-written ones. The point is to cover the *class* — a
pass-through added next year should be covered without anyone editing the test.

Suggested shape, stated as intent rather than as an implementation plan:

- Enumerate the wrapper's own prototype methods at runtime rather than hard-coding a name list, so
  a newly added pass-through is picked up automatically.
- Keep one short, explicit list of the methods that are deliberately **not** plain forwards
  (`start` and `stop` do extra work around the discovery loop; the constructor and the getters are
  not methods). A method added to that skip list is then a conscious act with a visible diff,
  which is the property a hard-coded inclusion list does not have.
- For each remaining method: call it on the wrapper with distinct sentinel arguments, and assert
  the core service received exactly those sentinels in that order, and that the wrapper returned
  the core's return value by identity.
- Worth folding in as a second cheap property while the rig is there: every pass-through routes
  through the same internal `ensure()` guard, so each should fail with the existing
  "libp2p node not injected" error when called before a node is available. That behavior is
  claimed in the wrapper's design but currently unverified anywhere.

Reaching the core instance from a test needs a narrow cast through the wrapper's private field;
prefer a single named cast in one helper over sprinkling `any`.
