description: When our own node runs out of network stream slots, seven different places in the service have to react the same way — count it, blame nobody. Only one of the seven is covered by a test, so the other six could quietly start blaming a healthy peer again without anything failing.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/outcome.ts, packages/fret/src/rpc/request.ts, packages/fret/test/dead-state.spec.ts
difficulty: medium
tradeoffs: The behaviour is correct today and all seven places now funnel through one small shared helper, so a maintainer could reasonably say the helper *is* the guarantee and a test per arm is ceremony — the counter-argument is that nothing forces a future eighth caller to use the helper.

## What is going on

An outbound network request can fail because *our own* node hit its per-connection limit on
open streams. libp2p raises that locally, before anything is sent. It is therefore evidence
about us, not about the peer we were about to talk to — so it must not count as the peer
being unreachable. Booking it as unreachable is what used to mark a perfectly healthy peer
dead after three of them.

Seven places in `fret-service.ts` observe the result of an outbound request and must handle
that case: the shared failure-bookkeeping seam (`noteRpcFailure`), the warm-up ping pass, the
iterative lookup walk, and three write-only senders (one announce, two leave fan-outs) that go
through `noteWriteOnlyOutcome`. All seven now reach a single owner, `countStreamLimit`, which
bumps a diagnostic counter and scores nothing.

Only the `noteRpcFailure` arm has a test (`dead-state.spec.ts`, "scores nothing at all for a
local stream-cap refusal"). It drives the seam directly, in isolation — no real call site is
exercised, and the other six arms are unpinned.

## Why this is worth a ticket rather than six point tests

The three write-only senders under-counted for the entire life of the feature and were only
found by reading the code during review. That is the shape of the defect: a call site that
observes a request outcome and silently omits one case. The shipped fix is a *convention*
("every outcome-observing site must reach `countStreamLimit`"), not a structural guarantee —
these are `switch` statements with a `default: return`, so a future caller that forgets the
case still compiles and still passes every test.

Two ways to close the class, in preference order:

**Move the count to where the case is decided.** The `local-limit` outcome is produced in
exactly one place — `classify` in `src/rpc/request.ts`. If the count happened there, no
observing call site could forget it and `countStreamLimit` would not need to exist. The
obstacle is that `rpcRequest` is a standalone exported helper with no access to the service's
diagnostics; giving it a counter sink is a public-API change and wants designing, not
patching.

**Or one generalized test over all arms.** A single test that, for each of the seven
outcome-observing arms, forces a stream-limit refusal at that arm's call site and asserts the
same three things: the peer's failure counters, relevance and membership are untouched; no
backoff was recorded; and the diagnostic counter went up by exactly one. Written as a table
over the arms rather than seven copies, so adding an eighth arm means adding a row.

Either is preferable to a test per arm. The second is cheaper; the first actually retires the
class.

## Out of scope

The mirror case — a *remote* peer refusing our stream at its own inbound limit — is a stated
and accepted residual, documented in `docs/fret.md` under *Stream management*. Not this ticket.

## Coverage update (review of stream-caps-local-limit-scoring-test, 2026-08-21)

Two new specs landed since this was filed, and they narrow the gap without closing it:

- `packages/fret/test/rpc.stream-caps-outbound.spec.ts` proves a real outbound ceiling surfaces
  as `local-limit` (memory transport and TCP + noise).
- `packages/fret/test/rpc.stream-caps-local-limit-scoring.spec.ts` drives that real refusal
  through two *actual call sites* of the failure-bookkeeping seam — the near-neighbour latency
  probe and the off-ring membership probe — and asserts no strike, no decay, no backoff, and the
  counter up by one per refusal. So the seam arm is now covered through real call sites rather
  than only by handing it a synthetic outcome.

Still unpinned: the warm-up ping pass, the iterative lookup walk, and the three write-only
senders (one announce, two leave fan-outs) that reach the counter via `noteWriteOnlyOutcome`.
The preference order above is unchanged — the generalized table test would absorb the two new
specs as rows rather than replacing them.

## Research findings (planning run, 2026-08-22 — incomplete, resume here)

This run enumerated the call sites and the test rig but did **not** finish resolving the design
choice, so the ticket stays in `plan/`. Everything below is verified against the tree at HEAD;
line numbers are approximate (grep the named symbol).

### The arms, exactly

`countStreamLimit` (`fret-service.ts` ~906) has **four** direct callers:

| # | Call site | Reaches counter via | Covered today? |
|---|---|---|---|
| 1 | `noteRpcFailure` `case 'local-limit'` (~886) | direct | yes — `rpc.stream-caps-local-limit-scoring.spec.ts` drives it through `probeNeighborLatency` and `probeMembership` |
| 2 | warm-up ping pass (~1699–1703) | direct | no |
| 3 | iterative lookup probe arm (~3347–3357) | direct | no |
| 4 | `noteWriteOnlyOutcome` (~918) | direct | no |

`noteWriteOnlyOutcome` in turn has **three** callers — announce (~1616), `sendLeave` (~1863),
`sendLeave` fan-out (~1881). Those three, plus arms 2 and 3, plus the seam itself, are the six
still-unpinned/pinned arms the ticket counts as seven places (the seam is one place with several
inheriting call sites).

Separately, four sites route a `local-limit` outcome *into* `noteRpcFailure` rather than counting
for themselves (~2472, ~2695, ~2754, ~3067, plus the activity-resend arm near ~3436). Those are
not extra arms — they inherit arm 1 — but a table test should still name them as rows so a future
edit that gives one of them its own `switch` arm is caught.

### The rig recipe already exists, and it is cheap

`test/rpc.stream-caps-local-limit-scoring.spec.ts` shows how to force a *real* refusal with no
concurrency at all: on the **dialing** node, register the protocol handler directly with
`{ maxOutboundStreams: 0 }` (libp2p reads the outbound cap off the dialer's own registrar entry,
and `newStream` counts the stream it is opening before comparing, so a cap of 0 refuses the very
first stream). The local service is deliberately **not** `start()`ed, so no live stabilization loop
makes diagnostics non-deterministic and each pass is driven explicitly by casting through
`svc as unknown as { … }`. Two rig details that make assertions non-vacuous and must be carried
into any new spec: rewind `lastContactFailureAt` to 0 between refusals (defeats the 500 ms
contact-failure spacing guard, which would otherwise let a broken implementation pass), and keep a
**control** case proving the same call answers over the same connection before the cap is
installed.

Note arms 2–4 span ping (warm-up), maybeAct (lookup) and neighbors/leave (write-only) — so a table
test needs the cap installed per protocol, not only on ping.

### The design call is still open — resolve it first, then emit `implement/`

Option 1 (count inside `classify`, retiring `countStreamLimit`) is the one that actually closes the
class. What was learned about its cost: `classify` is a module-private function in
`src/rpc/request.ts` (~79) and `RpcRequestOptions<T>` (~31) is the only channel a caller has into
`rpcRequest`. An **optional** `onLocalLimit?: () => void` on that options bag is additive — no
existing consumer breaks — but it is still public API on an exported helper, and it only closes the
class if *every* sender threads it, which is itself a convention of the same kind the ticket
complains about (the sender wrappers `sendPing` / `sendMaybeAct` / `fetchNeighbors` /
`announceNeighbors` / `sendLeave` in `src/rpc/*.ts` would each need to forward it). Not verified
this run: whether those five wrappers already take an options bag they could forward, or whether
each would need a new parameter. **Check that before choosing** — if they all forward an options
bag already, option 1 is small and should win; if it means five signature changes, option 2 (the
generalized table test) is the better value and option 1 should be parked in `backlog/` as a
`debt-` ticket.

### Remaining TODO for the next planning run

- Read the sender wrappers in `packages/fret/src/rpc/` (`ping.ts`, `maybe-act.ts`, `neighbors.ts`,
  `leave.ts`) and decide whether they can forward an options bag without new parameters.
- Pick option 1 or option 2 on that evidence and write the tradeoff into the implement ticket.
- Emit the `implement/` ticket with an `## Edge cases & interactions` section covering at minimum:
  the cap must be installed per protocol; a refusal on the write-only path must leave `ok`
  semantics ("written", not "received") unchanged; cancellation (`cancelled` / `skipped`) must stay
  distinguishable from `local-limit`; and the counter must increment exactly once per refusal
  across concurrent pooled tasks.
- Delete this plan ticket when the implement ticket is emitted.
