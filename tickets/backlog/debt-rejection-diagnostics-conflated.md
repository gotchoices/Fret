----
description: When the service turns a request away for being over a limit, every different reason for turning it away is added to one shared tally, so an operator watching a node cannot tell which limit was hit, or even which kind of request hit it.
files: packages/fret/src/service/fret-service.ts (the `diag.rejected` object ~350; the six `rejected.rateLimited++` sites at ~1048, ~1056, ~1139, ~1175, ~1532, ~1691), packages/fret/test/profile.behavior.spec.ts, packages/fret/test/inflight-concurrency.spec.ts, docs/fret.md
difficulty: easy
tradeoffs: The distinguishing information already reaches the *sender* (each refusal carries a different retry-after value), and splitting one counter into several changes the shape of a public diagnostics object that callers and several specs already read — so a maintainer may reasonably judge the churn not worth it until someone actually needs to diagnose a live node.
----

## What is wrong

The service reports why it refused inbound work through a small object of counters. Most reasons
get their own counter — message too large, clock too far off, hop budget used up, message did not
parse, sender claimed to be someone else. One counter, the "over a limit" one, is shared by
**six different refusals**:

- four are "this kind of request is arriving too fast" — one each for the routing/act request, the
  neighbor-list request, the liveness ping, and the departure notice;
- one is "too many announcements are arriving at once";
- one is a **different mechanism entirely**: the routing/act request was refused not because it
  arrived too fast, but because the service is already working on as many of them as it allows at
  once (Core 16 / Edge 4).

So a node whose shared counter is climbing could be under a flood on any of five request types, or
saturated on concurrent work, and nothing local distinguishes them. The last case is the sharpest,
because it is the one an operator would act on differently: a flood is someone else's behavior, and
saturation is a sizing decision about this node.

Two places in the existing design notes lean on this counter as if it were specific, which is how
the conflation stays invisible:

- the departure-notice path documents that a rate-limited notice is indistinguishable from an
  accepted one on the wire and that "the only local signal" is this counter — a signal it shares
  with five other causes;
- the concurrency-cap notes state that a too-fast refusal and a too-busy refusal both land in this
  counter and "differ only in retry-after", which is true but is a statement about what the
  *sender* sees, not what the operator sees.

## What good would look like

The point is not to add one more ad-hoc field for the concurrency case — that leaves the remaining
five conflated and invites the same ticket again for the next one. The reason this happened is the
shape: a flat object of hand-named counters has no place to put "which protocol" or "which
mechanism", so every new refusal reason either invents a field or reuses a neighbor's.

The shape worth reaching for is one where a refusal is *recorded with its cause and its protocol*
rather than mapped by hand onto a name — so a refusal reason added later cannot quietly land in
someone else's bucket, and so the counters read out per protocol without a naming convention
holding it together. Whether that is a keyed record, a small tagged enum, or something else is the
design question this ticket exists to settle.

Whatever shape is chosen, it needs to cover:

- distinguishing *too fast* from *too busy* for the routing/act request;
- distinguishing which protocol a too-fast refusal came from;
- keeping the read-out cheap enough that `getDiagnostics()` stays a plain synchronous snapshot.

## Notes for whoever picks this up

- The diagnostics object is public and several specs read it directly (the profile-behavior suite
  and the inflight-concurrency suite both assert on the shared counter), so the change is a small
  API break inside the repo — worth doing in one pass rather than adding a parallel field.
- The concurrency-cap spec currently relies on the shared counter being *unambiguous by
  construction*: it sizes each fan-out to stay inside the token bucket so that no too-fast refusal
  can be mixed into the tally it asserts on. If the counters separate, that constraint relaxes and
  the comment in that spec explaining it should go with it.
- The design notes (`docs/fret.md`) name this counter in three places — the departure-notice
  section, the concurrency-cap bullet under operating profiles, and the security section's rate
  limiting bullet. All three need updating together.

## Second arm: one protocol reports nothing at all for an undecodable body

Found while reviewing `15.325-rpc-json-handler-counter-tests`. Same site — the `diag.rejected`
object and the handlers that write to it.

The counters are not only conflated, they are also **not applied evenly across protocols**. A
departure notice or an announcement whose body is not valid JSON is dropped and tallied under
"did not parse". The routing/act request is not on the same shared handler seam: an undecodable
body there makes the handler throw, the connection's stream is torn down, and **no counter moves
at all**. So an operator watching a node being fed garbage sees a rising tally for two of the
message kinds and complete silence for the third — the busiest one.

Whoever splits the shared counter should settle this at the same time, since both are decisions
about what the `diag.rejected` object promises. Nothing is broken today; the tally is simply
blind to one case.

Since `15.32-rpc-json-handler-seam` landed, `diag.rejected.malformed` also gets writes from the
leave and neighbors-announce handlers via the shared `registerJsonHandler` seam's `onMalformed`
hook (`'decode'` for an undecodable body, `'parse'` for a parser rejection) — more evidence for the
same conflated-counter theme above, not a new writer class to design around.
