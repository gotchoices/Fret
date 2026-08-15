----
description: The libp2p wrapper around the core service has a dead constructor input, a pair of redundant methods, and loose typing that forces unsafe casts, all of which can be cleaned up.
files: packages/fret/src/service/libp2p-fret-service.ts
difficulty: easy
----
`Libp2pFretService` carries dead wiring and a duplicated surface.

- The constructor stores `components` but never reads it. As a result the `fretService()` factory builds a service that throws "libp2p node not injected" unless `setLibp2p()` is called separately, out of band — yet the factory's parameter type already requires the component. The libp2p node should be consumed from `components.libp2p` in the constructor so the out-of-band injection is unnecessary.
- `getNeighborsForKey` and `assembleCohortForKey` duplicate `getNeighbors` and `assembleCohort`. One pair should be removed.
- `getDiagnostics` is typed as returning `unknown` and reaches through `as any`, even though the concrete inner class exposes a typed diagnostics method. Typing the inner field as the concrete class makes both casts disappear.

Expected outcome: the constructor wires the node from its components (no `setLibp2p` dance required for normal use), the redundant `ForKey` methods are gone, and the inner field is typed concretely so the diagnostics cast is removed.

References: review "Discovery & libp2p glue" minor finding (`Libp2pFretService` dead wiring and duplicate surface). libp2p-fret-service.ts constructor/components (~8-16), the `ForKey` duplicate methods (~72-98), diagnostics cast (~84-86, 138-140).
