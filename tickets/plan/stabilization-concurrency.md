----
description: The periodic maintenance cycle contacts each neighbor one at a time with no cancellation, so a single slow or dead peer can stall the whole cycle for tens of seconds.
files: packages/fret/src/service/fret-service.ts
difficulty: medium
----
`stabilizeOnce` issues roughly fourteen pings and snapshot fetches strictly serially. Worse, the outbound RPC path `sendPing → openRpcStream → dialProtocol` carries no AbortSignal — only the read side has a 5 s cap — so a peer that accepts a dial but never responds (or is slow to dial) blocks the entire tick. With serial execution, one bad peer stalls maintenance for tens of seconds.

Expected behavior: a maintenance tick completes in bounded time regardless of individual slow/dead peers; slow peers are abandoned via timeout rather than blocking others.

Design direction:
- Run the tick's pings/fetches through a bounded-concurrency pool (e.g. `Promise.allSettled` over a capped worker set), profile-tuned for Edge vs Core concurrency.
- Thread a per-RPC timeout/AbortSignal through the dial + stream-open path, not just the read, so a stalled dial is cancelled.

The plan agent should settle the concurrency bound per profile and the abort/timeout plumbing (which layers need the signal), and enumerate the affected RPC entry points.

References: fret-service.ts `stabilizeOnce` (~881-920) and the `sendPing`/`openRpcStream`/`dialProtocol` path. Review "Core service" major finding (stabilization runs ~14 RPCs strictly serially with no abort). Related RPC-layer finding notes no AbortSignal anywhere.
