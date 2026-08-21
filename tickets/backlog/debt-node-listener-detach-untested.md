description: Nothing in the test suite proves the service actually unhooks its network event listeners when it shuts down, so a future rewrite of that bookkeeping could break shutdown silently.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/service-lifecycle.spec.ts
difficulty: easy
tradeoffs: The current implementation makes the failure it would catch impossible to express, so the test guards only against a future rewrite — a maintainer may reasonably judge that speculative.

The core service attaches four listeners to the libp2p node when it starts (`peer:connect`,
`peer:disconnect`, `peer:identify`, `peer:update`) and is supposed to detach all four when it
stops. Today nothing asserts that the detach actually happens.

The existing lifecycle specs get close but stop short:

- `double start() does not duplicate listeners or re-register protocols` reads the length of the
  service's own tracking array. Length says how many detach records exist, not whether calling
  them reaches libp2p.
- Every other start/stop spec passes even with detach fully broken, because each listener body
  begins with an `if (this.stopped) return;` guard. A leaked listener is therefore inert *and
  invisible* — it neither misbehaves nor shows up — until the node outlives the service, at which
  point the service is retained by the node for as long as the node lives.

What would close it: a spec that records every `addEventListener(type, handler)` the service makes
on the node, then after `stop()` asserts each recorded pair was passed to `removeEventListener`
with the *same* event name and the *same* handler object. Handler identity is the load-bearing
half — `removeEventListener` silently does nothing when handed a different function, so a rewrite
that reconstructs the handler instead of keeping the original would leak with no error anywhere.

Why this is a guard rather than a live bug: the implementation currently stores a removal closure
per listener, which captures the exact name and handler it registered with, so a mismatch is not
expressible. The value of the test is that it fails if someone reverts to storing the name and
handler separately — the shape this code had before, where the two could drift apart.
