----
description: A node sharing a transport with other networks keeps pinging genuinely-foreign peers at a steady low rate forever, instead of backing off to almost never — the throttle that was supposed to taper off doesn't.
prereq:
files:
  - packages/fret/src/service/fret-service.ts (probeMembership confirmed-foreign branch; reprobeForeignPeers; recordBackoff / getBackoffPenalty / clearBackoff)
  - packages/fret/test/ring-membership.spec.ts (add a unit test asserting the backoff grows)
  - docs/fret.md (Ring membership → "Foreign re-probe pass" bullet)
difficulty: easy
----

# Foreign re-probe backoff never actually grows

## Background

When several FRET control networks share one libp2p transport, a peer that belongs
only to *another* network is labelled `foreign` and excluded from this network's ring.
A small "foreign re-probe" pass (`FretService.reprobeForeignPeers`, run each
stabilization tick) re-pings a couple of foreign peers so that a same-network peer that
was *mislabelled* `foreign` (e.g. an `identify` race) gets re-admitted to `member`.

To avoid hammering peers that really are foreign, the confirmed-foreign branch of
`probeMembership` records an exponential backoff via `recordBackoff(id)`. The intent
(stated in `docs/fret.md` and the original code comment) was that a genuinely-foreign
peer would be re-probed "at most about once per backoff window, not every tick", with
the window growing toward the 32× cap so probing tapers toward zero.

## The defect

The backoff never grows. The factor is pinned at 1 (a fixed ~1s window) forever, because
two pieces interact:

- `reprobeForeignPeers` only selects peers where `getBackoffPenalty(id) === 0` (off
  backoff).
- `getBackoffPenalty` **deletes** the backoff record the moment it expires (the
  `bo.until < Date.now()` branch) and returns 0.

So at the instant a confirmed-foreign peer becomes eligible again, its previous backoff
record has already been deleted. `recordBackoff` then sees no existing entry and re-seeds
`factor = 1`. The exponential growth in `recordBackoff` (`existing ? existing.factor * 2
: 1`) is never reached on this path.

Net effect: a genuinely-foreign peer is re-probed at a fixed low rate (bounded by the
per-tick budget — 2 for core, 1 for edge — and the ~1s window), not at a tapering rate.
In **passive** mode, where the stabilization tick (1–3s) is ≥ the 1s window, this is
effectively "every tick that the budget reaches it". This is a steady-state chatter
source (a wasted namespaced dial that fails with `UnsupportedProtocolError`) that the
design explicitly intended to taper away, conflicting with FRET's low-chatter goal. It
only manifests in multi-network shared-transport deployments; single-network deployments
have no foreign peers and the pass is a no-op.

This is not a correctness bug — re-admission of a mislabelled peer still works, and the
per-tick budget caps the cost — which is why it is `debt-` rather than `bug-`.

## What "done" looks like

A genuinely-foreign peer should be re-probed at a rate that *decreases* the longer it
stays confirmed-foreign (toward the existing 32× cap, i.e. ~once per 32s), while a
mislabelled same-network peer is still re-admitted promptly on its first off-backoff
probe.

## Approach notes (not prescriptive)

The fix touches shared backoff infrastructure (`recordBackoff` / `getBackoffPenalty` /
`clearBackoff`), which is also consumed by `classifyUnknownPeers` (same `=== 0`
eligibility filter, same non-growth quirk on the timeout path) and by the next-hop cost
function (`buildNextHopOptions` → `backoffPenalty`). So vet those two call sites when
changing it. Candidate directions:

- Stop deleting the record in `getBackoffPenalty`'s expiry branch — return 0 but retain
  the entry so `recordBackoff` can grow `factor`. This makes the unknown-probe path taper
  too (arguably an improvement). Downside: the map no longer self-prunes, so add an
  explicit prune (records are cleared on success via `clearBackoff`; genuinely-foreign
  peers that never succeed would otherwise linger — bounded by table capacity C=2048 and
  the capped factor, but worth pruning).
- Or track a separate "confirmed-foreign re-probe schedule" decoupled from the generic
  RPC backoff map, so routing/unknown semantics are untouched.

Add a unit test that drives two confirmed-foreign probes across an elapsed window and
asserts the second backoff window is strictly longer than the first.
