----
description: A peer that genuinely belongs to this network can be wrongly and stickily labelled an outsider — by one failed protocol negotiation, or by a stale notification that arrives after the peer was already confirmed — and is then excluded from routing and discovery with only a slow recovery path.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/protocols.ts, packages/fret/src/service/peer-discovery.ts, docs/fret.md
difficulty: medium
repro: static — inferred from code. Field correlate in gotchoices/Optimystic#11: an always-on node logged "could not negotiate .../fret/1.0.0/ping" 9x against NAT'd peers that demonstrably served the network, and the mesh never closed. Confirm with two tests — (a) remote registers its FRET handlers *after* the first inbound ping, assert it is eventually classified member; (b) an RPC-confirmed member receives a late identify event carrying a protocol list that predates our handler registration, assert it stays member.
----
Membership labelling (`unknown` | `member` | `foreign`, see the *Ring membership* section of `docs/fret.md`) currently treats every classification signal as equally authoritative and equally durable. It is not. The signals differ in how much they actually prove:

| Signal | What it proves | Current handling |
|---|---|---|
| Completed namespaced RPC (ping / maybeAct over `/optimystic/<net>/fret/1.0.0/...`) | The remote served *this* network's protocol just now — the strongest possible proof | sets `member` |
| `identify` protocol list | What the remote advertised *at the time that list was captured* — may predate our own handler registration | sets `member` **or** `foreign`, unconditionally |
| "could not negotiate" on dial | The remote had no answerable handler *at that instant* | sets `foreign`, durably |

Because a weaker, older signal can overwrite a stronger, newer one, a same-network peer gets stranded as `foreign`: excluded from ring/cohort selection (`getNeighbors` is member-scoped, `fret-service.ts:1105-1111`) and from discovery emission (`peer-discovery.ts:76`, `fret-service.ts:1170`), with only the exponential-backoff foreign re-probe (at most ~once per window) to get back.

## The invariant to establish

**Classification strength ordering.** Attach to each entry the *strength* of the evidence behind its current membership label, and never let a weaker or staler signal override a stronger, more recent one. Concretely: RPC-confirmed `member` outranks identify-derived classification, which outranks a single negotiate failure. Promotion toward `member` on strong evidence always applies; demotion requires evidence at least as strong as what set the current label.

This is the invariant that retires the class — both arms below are the same mistake at two sites, and any third site added later inherits the guard rather than repeating the bug. Keep the tri-state and its documented semantics; add the strength dimension behind it.

## Arm 1 — a negotiate failure is treated as a durable verdict

`isUnsupportedProtocolError` (`packages/fret/src/rpc/protocols.ts:32-42`) matches the "could not negotiate" message substring, and the call sites at `fret-service.ts:913`, `:1011`, and `:1259` respond with `markForeign(id)`. But a peer whose FRET service has not yet run `registerRpcHandlers()` (`start()` ordering), or that errored during startup and restarted, produces exactly the same failure as a genuinely foreign peer.

Expected: a negotiate failure is *evidence*, not a verdict — retry with backoff before demoting, and/or make `foreign`-via-negotiate-failure expire so a peer that starts serving is re-admitted promptly.

Related earlier work: `complete/debt-foreign-reprobe-backoff-growth` tuned the re-probe backoff; this arm is about the demotion being wrong in the first place.

## Arm 2 — a stale identify event demotes an RPC-confirmed member

The `peer:identify` and `peer:update` handlers (`fret-service.ts:~340-361`) both call `classifyByProtocols` (`~287-292`) with whatever protocol list the event carries. `classifyByProtocols` marks the peer `foreign` whenever the list is non-empty but contains none of this network's protocols — and that list can predate this service registering its handlers. If the classification probe pass has already RPC-confirmed the peer as `member`, a late-arriving identify event demotes it.

This is already inconsistent with `seedFromPeerStore`, which classifies only entries still labelled `unknown` and never touches an already-resolved peer — that function's rule is the correct one, generalized.

Expected: an existing `member` is never demoted by an identify-derived protocol list. Promotion in the other direction (`foreign → member`, `unknown → member`/`foreign`) still applies.

## Notes for the implementer

- Update the *Ring membership* section of `docs/fret.md` — it currently describes the label transitions as if all signals were equal, which is exactly the bug.
- The foreign re-probe pass is the safety net for a mislabel; it stays, but it should stop being the *only* way back.
- Prefer one guard the classification sites route through over three separate `if` checks at three call sites — a fourth site added later must inherit it.
