description: A connected peer labelled foreign (a relay that runs no FRET, or a node on another FRET network) is re-probed every backoff window for as long as it stays connected, each re-probe fails negotiation, and because a non-empty phase-2 selection marks the pass pending it restarts the idle back-off, so a ring with a relay connection settles near one pass every ~6–9 s instead of the 60 s cap.
architecture: docs/fret.md#ring-membership-same-network-vs-foreign
files: packages/fret/src/service/fret-service.ts (`phaseTwoTargets`, `reprobeExcludedTargets`, the NOTE on permanently off-ring peers before `this.idle.notePending()`), packages/fret/src/service/idle-backoff.ts, packages/fret/src/service/probe-backoff.ts
----
# Foreign peers are not re-probed by the idle loop

GitHub [#3](https://github.com/gotchoices/Fret/issues/3), from sereus's message accounting (gotchoices/sereus#50). Related, closed: #2.

## What happens

- `phaseTwoTargets` runs `reprobeExcludedTargets` while any `foreign`, `unknown` or `dead` entry exists. A foreign peer is selected again whenever its `ProbeBackoff` window (1 s doubling to 32 s) has passed.
- A non-empty selection calls `this.idle.notePending()`, so the `IdleBackoff` ladder restarts at 1.5 s. The NOTE there already predicts the result ("settles at about five passes per window (~9 s apart) rather than at the cap") and proposes holding pending for the classify arm only.
- On sereus every node keeps a relay connection, so this is a phone's normal state, not an edge case.

## Measured

sereus `message-cost-accounting` scenario (2026-10-19, FRET 1.1.0 `48cb6b5`, unchanged in 1.2.0), two relay-only parties, one strand, idle 60 s: 10 `fret/ping` each way between the two strand nodes (a stable two-member ring), and failed `fret/ping` negotiations to the relay (2 per node per minute) and between two connected control nodes of different FRET networks (2 each way). Each goes through the relay on a phone.

## Direction (to settle in planning)

1. Hold pending for the classify arm only, as the NOTE proposes: a foreign or dead re-probe's outcome lands within the pass.
2. Do not re-probe a peer labelled foreign by identify (`identify-foreign`) until a `peer:update` changes its protocols.
3. Optional: an embedder-supplied set of peers never to probe (its relays).

Keep the documented invariant that a large foreign population must not starve dead recovery.

## TODO

- Plan 1–2; name the test that pins "a ring whose only off-ring peer is foreign backs off to the cap".
