----
description: Peer health scoring can now tell "we measured this peer at zero milliseconds" apart from "we never measured this peer", and forwarding a message no longer records a fake zero-millisecond timing, so fast peers are no longer scored worse than slow ones.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/store/relevance.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/relevance.properties.spec.ts, packages/fret/test/digitree.persistence.spec.ts, packages/fret/test/digitree.invariants.spec.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/service.table-persistence.spec.ts, docs/fret.md, packages/fret/README.md
----

## What shipped

One representation change plus the two call-site corrections it enables.
`PeerEntry.avgLatencyMs` is `number | null`; `null` means no round trip to that peer has ever
been timed, so `0` now means exactly one thing — a peer measured at 0 ms.

- **Store** (`src/store/digitree-store.ts`) — `PeerEntry.avgLatencyMs` and
  `SerializedPeerEntry.avgLatencyMs` are `number | null`; `upsert` defaults a brand-new entry to
  `null`; `importEntries` maps an absent field to `null` (`s.avgLatencyMs ?? null`). A
  pre-nullable snapshot that wrote `0` for "never measured" reads back as a genuine 0 ms —
  deliberate, since coercing `0 → null` would discard real 0 ms measurements and the next ping
  overwrites it either way.
- **Scoring** (`src/store/relevance.ts`) — `healthScore` tests `avgLatencyMs === null` (was
  `> 0`) and is now exported so a property test can pin the rule directly. A new private
  `blendLatency(avg, sample)` holds the EMA rule once: no sample → average untouched; `null`
  average → first sample seeds it; otherwise α = 0.2 EMA, so a measured 0 ms blends like any
  other value instead of hard-resetting. `recordSuccess`'s `latencyMs` is `number | undefined`.
- **Service** (`src/service/fret-service.ts`) — `applySuccess(id, coord, latencyMs?)`, and its
  `store.update` patch omits `avgLatencyMs` entirely when no sample was supplied. The
  successful-forward call site in `routeAct` (was `applySuccess(next, nextCoord, 0)`) supplies
  none, with a comment explaining that a forwarded `sendMaybeAct` returns only once the whole
  downstream route completes, so its wall time is the subtree's cost and not the link's. The two
  ping call sites still pass a real one-hop `res.rttMs`.
- **Docs** — `docs/fret.md` (relevance-score notes + `SerializedPeerEntry` under *Wire formats*)
  and `packages/fret/README.md:126`.

Behavior after: a 0 ms peer outranks a 300 ms peer; an unmeasured peer sits strictly between
them at the neutral midpoint; twenty latency-less forwards leave a 200 ms average at 200 (it
used to decay to 2.3).

## Review findings

### Checked

- Read the implement diff (`7c45716`) before the handoff summary, then the current state of every
  file it touched.
- **Every reader and writer of `avgLatencyMs` swept repo-wide.** Only `healthScore` and
  `blendLatency` do arithmetic on it. `linkQuality` (`fret-service.ts`) confirmed to score on
  success/failure counts only. The simulation harness constructs no `PeerEntry` literals, so it
  is unaffected.
- **All three `applySuccess` call sites.** Both ping paths (`probeNeighborsLatency`,
  `probeMembership` via `reprobeForeignPeers`) pass `res.rttMs` only inside a `res.ok` guard, so
  a failed or busy ping never contributes a sample. The forward path passes none. No fabricated
  latency remains anywhere.
- **`upsert`'s preserve-on-hit path** does not reset `avgLatencyMs` on a re-seed, so a
  peer:connect or peerStore re-seed cannot erase a measurement.
- **Public API surface.** `PeerEntry` and `SerializedPeerEntry` *are* exported from
  `src/index.ts`, so the nullable is a breaking type change for consumers — correct under
  AGENTS.md ("don't worry about backwards compatibility yet"), and both `docs/fret.md` and
  `README.md` were updated to match, which is what makes it discoverable.
- Import behavior for the three distinguishable cases (`null`, measured `0`, field absent), and
  that the all-or-nothing snapshot rejection is unaffected.
- `docs/fret.md`, `packages/fret/README.md`, `docs/review.html` read in full at the relevant
  sections; no other doc mentions latency scoring.
- Typecheck clean, `yarn build` clean, `yarn test` **408 passing / 0 failing** (~5m).

### Fixed in this pass (minor)

- `test/digitree.persistence.spec.ts` — the export/import round-trip **property** generated only
  `Math.random() * 500` and so never exercised `null`; the two new unit tests covered it but the
  property (the part that guards the whole field set against future edits) did not. Generator now
  emits `null` about a quarter of the time. This was the implementer's own listed gap.
- Same file — dropped an unused `entry` local at that site (`const entry = store.upsert(...)`),
  per AGENTS.md's unused-binding rule.

### Major

None. The fix sits at the representation rung: "no measurement" is no longer writable as a
number, so both the reader bug and the writer bug are unrepresentable rather than merely
corrected at their sites.

### Tripwire (recorded, not ticketed)

- `applySuccess` reads the entry, `await`s `selfCoord()`, then writes a patch derived from the
  stale read — as do its siblings `applyTouch` / `applyFailure`. Two chains scoring the same peer
  across that await both derive `successCount + 1` from the same base, so one increment is lost.
  Harmless while the counters only feed a relevance score recomputed on every call. `NOTE:` at
  `fret-service.ts` `applySuccess`. Pre-existing, and the new conditional spread actually narrows
  it — with no sample, `avgLatencyMs` is now omitted from the patch and so cannot be clobbered.

### Considered and declined (no ticket)

- **No end-to-end test drives `routeAct`'s forward path**; the regression is pinned at the
  `recordSuccess` seam. Not filed. Per *Architecture first*, the guard already sits two rungs
  higher: the type forbids writing "unknown" as a number, and the `healthScore` monotonicity
  property covers the whole sentinel class rather than one point. An end-to-end test would pin
  one call site and nothing more. The residual — a future caller deliberately timing the forward
  and passing a *wrong* measurement — is addressed by the doc comment at that exact site, which
  is where such a caller would be looking.
- **`docs/review.html:259,369` still describe both arms in the present tense.** Confirmed the
  implementer's reading: the file is a dated artifact (`<title>FRET Code Review — 2026-07-03</title>`)
  that also still describes other since-fixed findings (e.g. the cohort under-fill) in the present
  tense. Editing one finding would make the report internally inconsistent about which point in
  time it describes. Left untouched.
- **Pre-nullable snapshots that wrote `0` import as a genuine 0 ms.** Deliberate, documented at
  the code site and in `docs/fret.md`, and consistent with AGENTS.md. Correct as decided.
- **`healthScore` being made public.** `relevance.ts` is not re-exported from `src/index.ts`, so
  the export widens the *module* surface only — it is not package API, and it sits alongside the
  already-module-exported `sparsityBonus` / `normalizedLogDistance`. The implementer's stated
  concern does not hold.

### Pre-existing failures

None surfaced.
