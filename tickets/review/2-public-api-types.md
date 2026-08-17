description: The package's main public entry point uses loose catch-all types where precise ones are available, weakening type safety at the surface most users touch.
files: packages/fret/src/index.ts
difficulty: easy
---
Tightened three type-safety gaps in `packages/fret/src/index.ts`:

- `createFret(node: any, ...)` → `createFret(node: Libp2p, ...)`. `Libp2p` imported from `libp2p` (same source `fret-service.ts` already uses for its `node` field).
- All `Record<string, any>` metadata typings → `Record<string, unknown>`: `NeighborSnapshotV1.metadata`, `FretService.setMetadata`, `FretService.getMetadata`, `FretService.listPeers`.
- Duplicate `FretService` import/re-export (`export { FretService as FretServiceImpl } from './service/fret-service.js'` + separate `import { FretService as FretServiceClass } from ...` for `createFret`) collapsed to one aliased import (`FretServiceClass`) used both to build `createFret`'s return value and to re-export as `FretServiceImpl`.

No consumers elsewhere in the package construct via `any`-typed metadata literals that would break under `unknown` — verified by full typecheck/build/test pass below.

## Verification
- `npx tsc --noEmit` — clean
- `yarn build` — clean
- `yarn test` — 657 passing, 0 failing

## Review findings
(none yet — implementation pass only)
