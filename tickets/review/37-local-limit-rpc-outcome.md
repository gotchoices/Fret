description: Second pass over the finished work that stops our own node blaming a healthy peer when it runs out of network streams. A first reviewer read the change but ran out of time before running the tests or checking every place the new case is handled.
files: packages/fret/src/rpc/outcome.ts, packages/fret/src/rpc/request.ts, packages/fret/src/rpc/protocols.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.request.spec.ts, packages/fret/test/dead-state.spec.ts, docs/fret.md
difficulty: medium
---

<!-- resume-note -->
Prior review run hit the token budget after reading the implement diff
(`git show e2b6181 -- docs/fret.md packages/fret/src packages/fret/test`) and
`classify` in `src/rpc/request.ts`. **No code was changed and no tests were run.**
Everything below is either a carried-forward observation from that read or work
still outstanding. Nothing has been fixed inline yet.

## Carried-forward observations (unverified — confirm before acting)

- **`diag.streamLimit` may not be single-sourced after all.** The handoff claims
  `noteRpcFailure`'s `local-limit` case is the only increment site and that every
  outbound path routes through it. But `openRpcStream` raises the stream-cap error at
  the *open*, before any write — so the two write-only senders (`announceNeighbors`,
  `sendLeave`) can observe `local-limit` too, and per the handoff they only log
  `out.kind` (`fret-service.ts` ~1597, ~1839, ~1857). If so, a ceiling that fires on an
  announce or a leave notice is invisible in the counter while the doc bullet in
  `docs/fret.md` says a firing ceiling is "visible rather than silent". Decide whether
  that is a real hole (add the arm) or a stated limit (say so at the site and in the doc).
- **Ordering inside `classify`.** The `local-limit` arm sits *before* the
  deadline/`timeout` check, so a stream-cap error thrown while the deadline signal has
  already fired reports `local-limit`, not `timeout`. Probably right (the error identity
  is the more specific fact, and the caller's-signal `cancelled` check still wins ahead of
  both), but it is unstated. Confirm and record the reasoning if it stands.
- **`pingWarmupTargets` is asymmetric.** Its `foreign-protocol` / `unreachable` /
  `timeout` arm logs and returns without calling `noteRpcFailure`, while the new
  `local-limit` arm does call it. Intentional (the counter has to be incremented
  somewhere) but reads as an inconsistency at the site; check the comment explains it.
- **`iterativeLookup`'s arm is the riskiest** per the implementer's own note: it is an
  `if`, not a `switch` case, so the compiler cannot flag a missing one, and it does
  `hop++; continue;` rather than breaking the walk. Verify the walk still terminates
  (hop bound / attempt budget) when every candidate meets the ceiling, and that `target`
  really is already in `visited` at that point as the comment claims.

## Outstanding review work

- Read each of the six `local-limit` call-site arms in `fret-service.ts` in place
  (`pingWarmupTargets`, `probeNeighborLatency`, `probeMembership`,
  `fetchAndMergeSnapshot`, the `routeAct` forward path, `iterativeLookup`) rather than
  from the diff hunk, and confirm none records a strike, decay, backoff or ping
  diagnostic.
- Weigh the implementer's stated gaps: no test drives `local-limit` through a real call
  site, and `probeNeighborLatency` returning `false` (so `probeAndFetch` skips the
  snapshot fetch) is an untested behavior choice. Decide inline fix vs `debt-` ticket —
  climb the architecture ladder first (a single generalized test over all six arms beats
  six point tests).
- Check the remote-inbound-cap residual reasoning holds (the `NOTE:` at `classify` plus
  the `docs/fret.md` sentence) rather than treating it as an oversight.
- Confirm `docs/fret.md` reflects the shipped reality, including the counter's actual
  coverage, and note the expected merge touch with the sibling `stream-caps-plumbing`
  ticket on the same *Stream management* bullet.
- **Run the gate**: `cd packages/fret && npx tsc --noEmit` and `yarn test`. Neither was
  run in the prior pass. There is no lint step in this repo (`yarn check` is the gate;
  do not run `yarn format`).
- Produce the `complete/` ticket with a `## Review findings` section — categories with
  nothing in them stated explicitly and with a reason.
