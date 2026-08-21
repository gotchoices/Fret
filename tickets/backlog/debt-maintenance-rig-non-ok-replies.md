description: Our test harness for simulating a peer during background maintenance work can only make that fake peer say "yes" or go silent — it can't make the peer say "I'm busy" or send back garbage — so we can't write a test proving our code handles those replies correctly.
files: packages/fret/test/helpers/maintenance-rig.ts, packages/fret/src/service/fret-service.ts
tradeoffs: Real-world impact is test-coverage only — nothing user-visible breaks by deferring this — and the busy/decode-error reactions are short, readable code, so a maintainer may reasonably decide reading them is cheaper than extending the harness. Revisit once a second maintenance-path arm needs the same capability (already true for two: the ping busy arm and the fetchAndMergeSnapshot busy arm), since duplicated one-off workarounds cost more than the harness fix.
----

`packages/fret/test/helpers/maintenance-rig.ts` stubs a peer's replies to maintenance-protocol RPCs
(ping, neighbor-snapshot fetch) during stabilization-tick tests. Its `Behavior` type is exactly
`'answers' | 'hangs'` (line ~26), and the `'answers'` reply builder hard-codes `{ok: true, ts:
Date.now()}` for ping (line ~127) — there is no way today to make a rigged peer answer `busy`, or
reply with bytes that fail to decode, on any maintenance-path RPC.

Two known sites this blocks:

- The ping `busy` arm — a peer answering busy on `probeNeighborLatency` records backoff instead of a
  contact strike (see docs/fret.md, "Failure detection and recovery" — the `busy` exception). Not
  covered by any test today for exactly this reason.
- The `fetchAndMergeSnapshot` `busy` arm (`fret-service.ts`, `fetchAndMergeSnapshot`) — same "answered
  badly, treat as alive, no strike" reaction, also untested for the same reason.

## Expected shape of the fix

Extend `Behavior` (or add a parallel mechanism) so a test can configure a rigged peer to reply with an
arbitrary JSON body (to express `busy`) or with bytes that fail to decode (to express a decode error),
per protocol, the same way `protocolBehavior` already lets a peer's behavior vary by protocol
(`answers ping, hangs neighbors`, etc.). Both maintenance-path `busy` arms above become testable once
this lands — no other design work should be needed on this ticket beyond widening the rig.
