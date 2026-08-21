description: Add a test proving the service actually detaches its four network event listeners from the libp2p node when it shuts down, not just that it thinks it did.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/service-lifecycle.spec.ts

## What was done

Added one spec to `test/service-lifecycle.spec.ts`, `'detaches every listener it registered
from the real node on stop(), by handler identity'`, inserted right after the existing
`'double start() does not duplicate listeners or re-register protocols'` test (which already
uses the file's `listenerCount(svc)` helper).

The new spec:
- Wraps `node.addEventListener` / `node.removeEventListener` before `svc.start()`, recording
  every `(type, handler)` pair passed to each — same interception style already used in this
  file for `node.dialProtocol` (see `hangGhostDials`).
- Calls `svc.start()` then `svc.stop()`.
- Asserts the four expected event names (`peer:connect`, `peer:disconnect`, `peer:identify`,
  `peer:update`) all appear among the recorded adds.
- Asserts every recorded add has a matching remove with the **same handler function object**
  (`===`), not just the same event name — this is the load-bearing half per the ticket: a
  future rewrite that reconstructs the handler instead of reusing the captured closure would
  fail this assertion (name-only matching would not catch it).
- Restores the original `addEventListener`/`removeEventListener` in a `finally`, matching the
  `hangGhostDials`/`dials.restore()` convention already in the file.

No production code touched — `fret-service.ts`'s `addNodeListener`/`removeNodeListeners`
(lines ~1203-1215) were already correct per the ticket's own investigation; this was purely a
test-coverage gap.

## Known gap — MUST be first thing reviewer does

**The new spec has not been run.** One compile error surfaced via the editor's inline
TypeScript diagnostics right after writing it (`originalAdd`/`originalRemove`, bound straight
off `node.addEventListener`/`removeEventListener`, kept libp2p's strict `keyof
Libp2pEvents<ServiceMap>` overload and rejected the generic `string` type passed through the
wrapper) — fixed by casting `originalAdd`/`originalRemove` to a loose `(type: string, handler,
opts?) => void` signature via `as unknown as`. That fix is applied in the file already, but has
only been checked by the editor's live diagnostics, not by an actual `tsc --noEmit` run or a
mocha run. A BUDGET_WARNING landed immediately after the edit, and per
the workflow rules I stopped without executing any further tools, including the test run and
`tsc --noEmit`. This is a straightforward, mechanically-written spec that closely mirrors
existing patterns in the same file (`hangGhostDials`'s interception style, `listenerCount`'s
"prove tracking, not a hardcoded count" philosophy), but it is unverified. Treat it as a draft,
not a finished floor.

Before anything else, from `packages/fret`:
```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/service-lifecycle.spec.ts" --timeout 30000
npx tsc --noEmit
```

Things worth double-checking while verifying, since they were reasoned about but not compiler-
or runtime-checked:
- The cast pattern `(node as unknown as { addEventListener: unknown }).addEventListener = ...`
  compiles cleanly under this file's existing conventions (same shape used for `dialProtocol`
  interception), but the replacement function signature (`(type: string, handler: Handler,
  opts?: unknown) => ...`) needs to actually satisfy whatever `node.addEventListener`/
  `removeEventListener` return type libp2p's `Libp2p` type expects when called elsewhere in
  the test (i.e. `originalAdd(type, handler, opts as never)` — confirm this doesn't throw at
  runtime due to a libp2p-internal check on `opts`).
- Confirm the four expected event names are indeed the complete set FretService registers via
  `addNodeListener` during `start()` — the ticket states this, and `fret-service.ts:1203-1215`
  was read to confirm the wrapper mechanics, but the actual call sites that invoke
  `addNodeListener('peer:connect', ...)` etc. were not individually re-verified in this pass
  (they were taken from the ticket body, which cites them from a prior investigation).
- If the spec fails, likely causes: (a) libp2p's internal listener registration for its own
  purposes also flows through the same `addEventListener` — if so `added`/`removed` will
  contain non-FRET entries too, which is fine for the "every add has a matching remove" loop
  (it still holds for everyone) but could break the "four expected types are in `added`" check
  if event names collide unexpectedly — unlikely but unconfirmed; (b) opts mismatch between
  add and remove (e.g. `once: true` semantics) could make libp2p's real `removeEventListener`
  not actually detach even though the recorded pair matches by identity — the spec as written
  only checks that the *service's* removal call matches identity, which is what the ticket
  asked for, but doesn't independently verify the real underlying detach if libp2p's own
  add/remove options handling has surprises.

## Test coverage note (from the ticket)

Every other lifecycle spec passes even with detach fully broken, because each listener body
opens with `if (this.stopped) return;` — a leaked listener is inert and invisible until the
node outlives the service. This new spec is what closes that blind spot.
