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
