description: A peer that genuinely belongs to this network could be wrongly labelled an outsider by one failed connection handshake or one out-of-date notification, and was then shut out of routing until a slow retry rescued it. Weak or stale evidence can no longer override strong, recent evidence.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/membership-identify.spec.ts, packages/fret/test/relevance.properties.spec.ts, docs/fret.md
difficulty: medium

Implements the evidence-strength ordering for ring-membership labelling. All three arms of the
implement ticket landed, plus the recovery-ordering mitigation.

## What changed

**One guard owns the ordering.** `FretService.applyMembershipSignal(id, signal)`
(`fret-service.ts:~300`) is now the single site that writes `membership`. `markMember` /
`markForeign` are gone; `applySuccess`, `classifyByProtocols`, and all three
`isUnsupportedProtocolError` call sites route through it. The rule it enforces:

| Signal | Strength | May set |
|---|---|---|
| `rpc-success` (completed outbound namespaced RPC) | strong | `member` |
| `rpc-inbound` (authenticated inbound namespaced RPC) | strong | `member` |
| `identify-member` (protocol list contains one of ours) | strong | `member` |
| `identify-foreign` (list non-empty, none of ours) | weak | `foreign`, **only from `unknown`** |
| `negotiate-failure` (could not negotiate) | weak | `foreign` **only at 3 consecutive** |

Promotions always apply and reset the consecutive-failure run to 0.

**Store.** `PeerEntry.negotiateFailures: number` — defaults 0 on insert, preserved by `upsert`
like the other counters, clamped at the threshold so it stays bounded. Exported in
`SerializedPeerEntry` (optional) for diagnostics but **reset to 0 by `importEntries`**, same
reasoning as `state: 'disconnected'`. The store still never branches on it.

**Inbound promotion (arm 3).** `registerPing` and `registerNeighbors` gained an
`onInbound?: (from: string) => void` parameter fed from `connection.remotePeer`;
`registerMaybeAct` already threaded `from` (it was being discarded as `_from`);
`mergeAnnounceSnapshot` uses its already-verified `from`. All four call
`FretService.noteInboundRpc`, which upserts if needed and applies `rpc-inbound`.

**Recovery ordering (phase 4).** `reprobeForeignPeers` now sorts candidates within each
reachability group by ascending backoff factor, so a freshly-demoted peer is probed before a
long-confirmed foreign one.

**Docs.** The *Ring membership* section of `docs/fret.md` replaces its flat transition list with
the strength table + the "only set by positive proof, only cleared by repeated proof of absence"
rule; the foreign re-probe paragraph documents the new ordering and the saturation arithmetic;
`SerializedPeerEntry` gains the new field.

## Validation

`npx tsc --noEmit` clean; `yarn test` from `packages/fret`: **310 passing, 0 failing** (~4 min).
No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

New tests (all verified failing against the pre-change behaviour per the source ticket's repro):

- `ring-membership.spec.ts` — `negotiateFailures` defaults/preserve-on-upsert; import resets it
  to 0 while preserving `membership`.
- `ring-membership.spec.ts` — **arm 1a**: two `createMemNode` net-a peers, wait for `member`,
  `await svcC.stop()` (unhandles all five protocols while the connection stays up, so the next
  ping fails to *negotiate* rather than timing out). Asserts C is still `member` and still in
  `getNeighbors` once the first failure is recorded.
- `ring-membership.spec.ts` — **arm 1b**: same setup, then `svcC.start()`; asserts the failure
  run resets to 0 and C stays `member`.
- `ring-membership.spec.ts` — **arm 3**, two variants: a `foreign`-tagged peer sends an inbound
  net-a ping / an inbound neighbors request; asserts promotion to `member` with
  `getDiagnostics().pingsSent === 0` (probing stubbed out, so inbound is the only possible cause).
- `membership-identify.spec.ts` — **arm 2**: real TCP + identify peers; C confirmed `member`, then
  a `peer:update` carrying C's *pre-registration* protocol list is dispatched on A. The assertion
  is synchronous immediately after dispatch (the listener classifies inline for a peer already in
  the store), so nothing can re-promote and mask a demotion.

## Use cases a reviewer should poke at

- **A member restarts.** Kill and restart a peer's FRET service while leaving its libp2p node up.
  It should stay in the ring across the blip and never appear in `getNeighbors`'s complement.
- **A genuinely foreign peer.** A co-resident other-network peer must still settle at `foreign` —
  the threshold must not disable classification, only delay it (~7 s via 1 s + 2 s + 4 s backoff,
  or immediately where identify is available).
- **A NAT'd member we cannot dial** but that dials us: one inbound RPC should admit it with zero
  outbound probe traffic.
- **Persisted table round-trip.** `exportTable` → `importTable` must not carry handshake history.

## Known gaps / things I would look at first

- **The two pre-existing net-b tests changed shape.** `ring-membership.spec.ts`'s two
  `'labels a same-network peer member…'` / `'excludes the foreign peer…'` tests used a fixed
  `setTimeout(6000)`. The threshold pushes B's demotion to ≈6 s (probe at t₁, then +1.5 s, then
  one tick skipped by backoff, then +1.5 s ⇒ ≈ t₁+4.5 s with t₁ ≤ 1.5 s), i.e. right at the old
  sleep boundary. I converted both to `waitFor` on the labels. That is strictly less flaky, but a
  reviewer should confirm the conversion did not weaken what they assert.
- **The foreign re-probe test was re-scoped, deliberately.** It previously ran a full `svcC`; with
  arm 3 in place svcC's own classification ping would reach A as *inbound* traffic and promote C
  by itself, masking the re-probe path the test exists to cover. C now runs only a bare net-a ping
  handler (`registerPing(nodeC, …)`) and sends nothing. Worth a second opinion on whether that is
  the right isolation or whether the test should instead assert the re-probe directly.
- **"Never excluded from the ring during the transient window" is sampled, not continuous.** Arm
  1b asserts `getNeighbors` includes C at the instant the first failure is observed, not at every
  instant of the window. A continuous sampler would be stronger but is timing-fragile.
- **Two changed sites have no direct test**: the maybeAct forward-path `negotiate-failure`
  (`fret-service.ts:~1459`) and the maybeAct inbound promotion. Both are one-line routes through
  the same guard that the tested sites use, so I judged the guard's own coverage sufficient —
  disagree if you think the forward path deserves its own harness.
- **Phase 4 (reprobe ordering) has no test.** It is a sort inside a bounded pass with no
  observable public surface; testing it means reaching into `backoffMap`. Flagging rather than
  hiding.
- **`NEGOTIATE_FAILURE_THRESHOLD = 3` is a private constant, not config.** Matches the ticket's
  recommendation. If a deployment ever wants it tunable that is a follow-up, not a defect.
- **`handleLeave` deliberately does not promote.** A leave notice is an authenticated inbound
  namespaced RPC, so it would qualify as `rpc-inbound` — but promoting a peer that is announcing
  its departure is pointless. Called out in case a reviewer reads the four-of-five handler
  coverage as an oversight.
- **`noteInboundRpc` upserts unseen senders.** Any peer that dials one of our namespaced protocols
  is now inserted into the routing table as `member` even if `peer:connect` somehow missed it.
  That is intended (it is the NAT case), but it is a new write path into the store off remote
  action — worth an adversarial read given the table is capacity-bounded.
