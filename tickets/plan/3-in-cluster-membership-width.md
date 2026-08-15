----
description: The rule that decides whether this node is close enough to act on a request is stricter than the design promises, so nodes that should act instead forward the request, adding hops the sender did not budget for.
files: packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
----
The in-cluster membership test used to decide whether to act on a received request is narrower than the design document describes.

The doc's membership test is "self is within the first k (or wants) cohort entries." The implementation instead acts only when self is one of the two key-adjacent anchors — the distance index into the neighbor set must be at most one. Consequently a node sitting at, say, cohort index three that receives a message which already includes an activity payload forwards it onward instead of acting. Those are extra hops the payload-inclusion heuristic never budgeted for (the payload was sent because the sender judged the message "near enough"), and it contradicts the economics the doc describes.

Resolution for this ticket: widen the acting condition toward `want_k` so membership matches the doc's "within the first k/wants cohort entries" test — the cohort and threshold-signature story reads more naturally with the wider test. Then update docs/fret.md so code and doc agree.

This is a design pass — the plan agent should settle exactly how wide the acting window becomes (full `want_k`/`wants`, and how that interacts with the payload heuristic and cohort assembly), confirm no double-acting or amplification is introduced, and specify the doc edits before handing to implement.

References: review "Core service"/design note "In-cluster test is narrower than the doc promises". fret-service.ts membership test in `routeAct` — the distance-index computation and the `distIdx <= 1` gate (~1210-1211); `handleMaybeAct` is the entry point. docs/fret.md "Determining cluster membership" and the RouteAndMaybeAct routing rule.
