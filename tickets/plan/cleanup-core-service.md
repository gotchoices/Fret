----
description: A batch of low-risk housekeeping cleanups in the core service file — removing dead code, routing logs through the real logger, deduplicating near-identical blocks, tightening loose types, and fixing a promised-but-empty startup gate and some broken indentation.
files: packages/fret/src/service/fret-service.ts
difficulty: easy
----
Mechanical cleanups in `fret-service.ts`, none behavior-critical but each worth doing while the file is open:

- Delete the dead private `nextSuccessor`/`nextPredecessor` methods (zero callers, and O(n) anyway).
- Route the roughly ten `console.warn`/`console.error` sites through the structured logger the rest of the service uses.
- `preconnectNeighbors` near-duplicates the active-loop tick body — factor out the shared logic.
- There are two separate `peer:connect` listeners — consolidate into one.
- Tighten type laziness: `(res as any).busy`, `(evt: any)` handlers (libp2p exports typed event maps — use them), `Record<string, any>` metadata, and the inline `import()` type (~113).
- `ready()` is an empty stub even though the design doc promises a ready gate; `firstStabilizeDone` already exists, so resolve `ready()` on it.
- Fix the broken indentation blocks (~34-42 and ~563-567).

These can be split across the implement pass if convenient, but they are one coherent cleanup of a single file. No functional change intended except `ready()` gaining real behavior.

References: fret-service.ts dead `nextSuccessor`/`nextPredecessor` (~1115-1122), console logging sites, `preconnectNeighbors`, the two `peer:connect` listeners, type-laziness sites (incl. inline import at ~113), `ready()`/`firstStabilizeDone`, indentation (~34-42, ~563-567). Review "Core service" cleanup finding (mechanical cleanups).
