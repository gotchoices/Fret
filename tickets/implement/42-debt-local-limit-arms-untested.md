description: When our own node runs out of network stream slots, several places in the service must react the same way — count it, blame nobody. Only one of those places is covered by a test, so the rest could quietly start blaming a healthy peer again without anything failing. Add one table-driven test covering all of them.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/request.ts, packages/fret/test/rpc.stream-caps-local-limit-scoring.spec.ts, packages/fret/test/rpc.stream-caps-outbound.spec.ts, docs/fret.md
difficulty: medium

## Background

An outbound request can fail because *our own* node hit its per-connection limit on open
streams. libp2p raises that locally, before anything is sent, so it is evidence about us, not
about the peer. Booking it as the peer being unreachable is what used to mark a healthy peer
dead after three of them.

The shipped fix routes every outcome-observing site through one owner,
`FretService.countStreamLimit` (`fret-service.ts` ~906), which bumps `diag.streamLimit` and
scores nothing. Only one arm is pinned by a test today.

## The design call, resolved

The plan ticket weighed two options. **Option 2 (one generalized table test) is chosen.**

Option 1 was "count inside `classify` (`src/rpc/request.ts` ~79), retiring `countStreamLimit`".
Rejected on evidence gathered during planning:

- All five sender wrappers (`sendPing`, `sendMaybeAct`, `fetchNeighbors`, `announceNeighbors`,
  `sendLeave`) already take an options bag, so an optional `onLocalLimit?: () => void` on
  `RpcRequestOptions` would need no new positional parameters — the cheap part is cheap.
- But it does **not** close the class. `rpcRequest` is a standalone exported helper with no
  access to service diagnostics, so the callback has to be threaded from the service at every
  *call site*. There are ~12 of those against 4 direct `countStreamLimit` callers, so the
  convention ("don't forget to pass it") would apply in more places than the convention it
  replaces. Only a module-level counter sink inside `classify` would truly close it, and that
  is process-global mutable state — wrong when one process hosts several FRET services.

So the helper stays and the test becomes the guarantee.

## What to build

One table-driven spec, `packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts`, with a row
per outcome-observing arm. Each row forces a **real** stream-limit refusal at that arm's own call
site and asserts the same four things:

- the peer's failure counters (`contactFailures`, `failureCount`) are unchanged
- the peer's `relevance`, `membership` and `state` are unchanged
- no backoff was recorded for the peer (`ProbeBackoff`)
- `diag.streamLimit` went up by exactly one per refusal

Adding an eighth arm later means adding a row, not copying a test.

### The arms (verified against HEAD; grep the named symbol, line numbers approximate)

`countStreamLimit` has four direct callers:

| # | Call site | Covered today? |
|---|---|---|
| 1 | `noteRpcFailure` `case 'local-limit'` (~886) | yes — `rpc.stream-caps-local-limit-scoring.spec.ts`, via `probeNeighborLatency` and `probeMembership` |
| 2 | warm-up ping pass (~1699–1703) | no |
| 3 | iterative lookup probe arm (~3347–3357) | no |
| 4 | `noteWriteOnlyOutcome` (~918) | no |

`noteWriteOnlyOutcome` has three callers of its own: announce (~1616), `sendLeave` (~1863),
`sendLeave` fan-out (~1881).

Four further sites route a `local-limit` outcome *into* `noteRpcFailure` rather than counting for
themselves (~2464/2470/2477, ~2692/2698, ~2756, ~3071, plus the activity-resend arm near ~3436).
These inherit arm 1 and are not separate arms — but include them as rows anyway, so a future edit
that gives one of them its own `switch` arm is caught by an existing row rather than by nobody.

### The rig recipe (already proven — reuse it)

`test/rpc.stream-caps-local-limit-scoring.spec.ts` shows how to force a real refusal with no
concurrency: on the **dialing** node, register the protocol handler directly with
`{ maxOutboundStreams: 0 }` — libp2p reads the outbound cap off the dialer's own registrar entry,
and `newStream` counts the stream it is opening before comparing, so a cap of 0 refuses the first
stream. Carry these rig details across or the assertions go vacuous:

- Do **not** `start()` the local service — no live stabilization loop, so diagnostics stay
  deterministic; drive each pass explicitly by casting through `svc as unknown as { … }`.
- Rewind `lastContactFailureAt` to 0 between refusals. Without it the 500 ms contact-failure
  spacing guard lets a broken implementation pass.
- Keep a **control** case per arm proving the same call answers over the same connection before
  the cap is installed.
- Install the cap **per protocol**. Arms 2–4 span ping (warm-up), maybeAct (lookup) and
  neighbors/leave (write-only), so a cap on ping alone pins nothing for arms 3 and 4.

## Edge cases & interactions

- **Per-protocol cap installation.** A row whose arm uses maybeAct or neighbors must cap that
  protocol; a row that caps the wrong protocol passes vacuously (the call simply succeeds). Assert
  the control case first so a mis-capped row is loud rather than green.
- **Write-only `ok` semantics must not change.** `announceNeighbors` / `sendLeave` pass no
  `decode`, so their `ok` means "written", not "received". A refusal on those paths must surface as
  `local-limit` and must not be reinterpreted as `ok` or as `unreachable`.
- **`cancelled` and `skipped` must stay distinguishable from `local-limit`.** `classify` checks the
  caller's signal first, so a refusal landing during a `stop()` classifies `cancelled`, not
  `local-limit` — and then `diag.streamLimit` does **not** increment. Include a row for that: it is
  the case where a naive "count it wherever we see a stream error" implementation over-counts.
  Likewise `skipped` (dial mode forbade dialing) never reaches the counter.
- **Exactly once per refusal under concurrency.** The pooled passes (warm-up, stabilization tick)
  can refuse several tasks at once. Assert the counter equals the number of refusals, not merely
  that it is non-zero — a shared-increment bug reads as "went up" either way.
- **Contact-failure spacing must not mask a strike.** Rewinding `lastContactFailureAt` is what
  makes "no strike" a real assertion; a row that skips the rewind proves nothing.
- **The mirror case stays out of scope.** A *remote* peer refusing our stream at its own inbound
  limit is a stated, accepted residual (`docs/fret.md`, *Stream management*) — it surfaces as
  `decode-error`, not `local-limit`. Do not add a row asserting otherwise.
- **The two existing specs are absorbed as rows, not replaced.**
  `rpc.stream-caps-outbound.spec.ts` (a real ceiling surfaces as `local-limit`, memory and
  TCP+noise) and `rpc.stream-caps-local-limit-scoring.spec.ts` (arm 1 through two real call sites)
  both stay where they are; the new table adds the uncovered arms and re-covers arm 1 as a row for
  uniformity.

## TODO

- Write `packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts` as a table over the arms
  above, reusing the `maxOutboundStreams: 0` rig from
  `rpc.stream-caps-local-limit-scoring.spec.ts`.
- Cover arms 2, 3 and all three `noteWriteOnlyOutcome` callers; add rows for arm 1 and for the four
  inherit-arm-1 sites.
- Add the `cancelled` / `skipped` non-counting rows.
- Add a `NOTE:` at `FretService.countStreamLimit` recording the accepted tradeoff: counting inside
  `classify` was weighed and declined because it would spread the convention across more call
  sites than it removes, and a module-global counter sink is wrong for multi-service processes;
  revisit if `rpcRequest` ever gains a per-service context object.
- Update `docs/fret.md` *Stream management* — that paragraph currently names only the two existing
  specs; say the arms are pinned as a table and name the new spec.
- Run `cd packages/fret && npx tsc --noEmit` and
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.stream-caps*.spec.ts" --timeout 30000`,
  then the full `yarn test` before handing off.
