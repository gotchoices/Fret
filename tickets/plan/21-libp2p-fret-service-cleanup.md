----
description: The libp2p wrapper around the core service has a dead constructor input, a pair of redundant methods, and loose typing that forces unsafe casts, all of which can be cleaned up.
files: packages/fret/src/service/libp2p-fret-service.ts
difficulty: easy
----
`Libp2pFretService` carries dead wiring and a duplicated surface.

- The constructor stores `components` but never reads it. As a result the `fretService()` factory builds a service that throws "libp2p node not injected" unless `setLibp2p()` is called separately, out of band — yet the factory's parameter type already requires the component. The libp2p node should be consumed from `components.libp2p` in the constructor so the out-of-band injection is unnecessary.
- `getNeighborsForKey` and `assembleCohortForKey` duplicate `getNeighbors` and `assembleCohort`. One pair should be removed.
- `getDiagnostics` is typed as returning `unknown` and reaches through `as any`, even though the concrete inner class exposes a typed diagnostics method. Typing the inner field as the concrete class makes both casts disappear.
- **The class does not declare that it implements the service interface, and its surface has silently fallen behind it.** `Libp2pFretService` is declared `implements Startable` only, so nothing checks that its hand-written pass-throughs actually cover the public `FretService` interface. Adding `implements FretService` today fails to compile with six missing members: `reportNetworkSize`, `getNetworkSizeEstimate`, `getNetworkChurn`, `detectPartition`, `setActivityHandler`, `iterativeLookup`. So an application that reaches FRET through the libp2p wrapper cannot use size estimation, partition detection, the activity handler, or iterative lookup at all, even though the core service provides all of them.

  This is also the invariant that would have caught a whole class of maintenance slips rather than one instance of it: when the `importTable` signature changed from `number` to `Promise<number>` (ticket `enforcecapacity-null-selfcoord`), the wrapper had to be updated by hand and nothing but human attention stood between that and a silent mismatch. Declaring the interface makes every future drift a build error. Decide per missing member whether it is genuinely meant to be wrapper-visible or whether the interface is too wide — either add the pass-through or narrow the interface, but end with the class declaring what it implements.

Expected outcome: the constructor wires the node from its components (no `setLibp2p` dance required for normal use), the redundant `ForKey` methods are gone, the inner field is typed concretely so the diagnostics cast is removed, and the class declares `implements FretService` with a surface that satisfies it.

References: review "Discovery & libp2p glue" minor finding (`Libp2pFretService` dead wiring and duplicate surface). libp2p-fret-service.ts constructor/components (~8-16), the `ForKey` duplicate methods (~72-98), diagnostics cast (~84-86, 138-140), class declaration (~10) and the `FretService` interface in `src/index.ts` (~90-120) for the parity arm.
