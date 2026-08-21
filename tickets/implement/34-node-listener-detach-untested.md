description: Add a test proving the service actually detaches its four network event listeners from the libp2p node when it shuts down, not just that it thinks it did.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/service-lifecycle.spec.ts
difficulty: easy

## Background

`FretService.addNodeListener` (fret-service.ts:1203-1209) wraps `node.addEventListener(type, handler)`
and pushes `() => this.node.removeEventListener(type, handler)` onto `this.nodeListeners`.
`removeNodeListeners()` (fret-service.ts:1211-1215) runs every pushed closure on `stop()`.

Four listeners get registered this way during `start()`: `peer:connect`, `peer:disconnect`,
`peer:identify`, `peer:update`.

`test/service-lifecycle.spec.ts` has a `listenerCount(svc)` helper (line 39-41) that reads
`nodeListeners.length` — it only proves the tracking array's size, not that `removeEventListener`
was actually called on the real node with the right arguments. Every other lifecycle spec passes
even with detach fully broken, because each listener body opens with `if (this.stopped) return;` —
a leaked listener is inert and invisible until the node outlives the service.

## What to build

Add a spec to `test/service-lifecycle.spec.ts` (alongside the existing `addNodeListener` /
`removeNodeListeners` coverage) that:

1. Wraps `node.addEventListener` and `node.removeEventListener` before `svc.start()` (same pattern
   already used in this file for `node.dialProtocol` — see `hangGhostDials`), recording every
   `(type, handler)` pair passed to each.
2. Calls `svc.start()`, then `svc.stop()`.
3. Asserts every `(type, handler)` pair recorded on `addEventListener` was passed to
   `removeEventListener` with the *same* handler function object (`===`), not merely the same
   event name. Handler identity is the load-bearing half: `removeEventListener` silently no-ops
   when handed a different function, so this must fail if a future rewrite reconstructs the
   handler instead of reusing the captured one.
4. Asserts the four expected event names (`peer:connect`, `peer:disconnect`, `peer:identify`,
   `peer:update`) all appear among the recorded adds — so the test also catches a listener quietly
   dropped from registration, not only a leaked one.

Restore the original `addEventListener`/`removeEventListener` in a `finally` (or rely on `afterEach`
recreating `node` — check which the file already does for its other node-method wraps) so the spy
doesn't leak into later tests.

## Edge cases & interactions

- Must assert handler **identity** (`===`), not just event-name match — a name-only check would
  pass even if the code regressed to reconstructing a fresh closure per detach call (the exact
  historical bug shape this ticket exists to catch, per the design doc's `docs/fret.md` note on
  `accessCount`-style drift... N/A here, but same "two copies of one rule drift apart" class).
- Don't assert an exact call count beyond "every add has a matching remove" — the test should not
  need updating if a fifth listener type is added later; it should still catch that fifth listener
  leaking on detach.
- Restarting (`start()` → `stop()` → `start()`) is out of scope for this ticket; the existing
  `double start()` and restart specs already cover re-registration counts. Keep this spec to one
  start/stop cycle.
- Run `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/service-lifecycle.spec.ts" --timeout 30000` to verify, then `cd packages/fret && npx tsc --noEmit`.

TODO:
- Add the add/remove-listener spy spec to `test/service-lifecycle.spec.ts` as described above.
- Run the lifecycle spec file and `tsc --noEmit` to confirm green.
