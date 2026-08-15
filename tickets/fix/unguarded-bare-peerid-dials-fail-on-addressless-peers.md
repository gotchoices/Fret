----
description: Several maintenance and routing paths dial peers for which no address can possibly be known, producing a steady stream of failed dials against peers the network itself admitted.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts
repro: static — inferred from code; field correlate in gotchoices/Optimystic#11 (always-on node logged `NoValidAddressesError` 76x against admitted cohort members). Confirm with a unit test upserting a ring entry for a peer with no peerStore addresses and driving the leave/lookup paths.
----
All FRET RPC sends funnel through `openStreamMaybe` (`packages/fret/src/rpc/protocols.ts:141-156`): reuse an open connection if one exists, else `node.dialProtocol(pid, ...)` with a **bare peer id** (`:155`). FRET never learns or stores multiaddrs (messages carry peer-id strings only), so that dial only succeeds if libp2p's own address book happens to have an entry — for a peer known only through FRET gossip it never does, and the dial throws `NoValidAddressesError`.

The stabilization paths are mostly guarded by `hasAddresses()` / `isConnected` filters (`fret-service.ts:483-491`, used at `:525`, `:705`, `:885`, `:944-946`, `:976-978`). Two problems remain:

**1. Unguarded dial sites.** These dial bare peer ids with no reachability filter at all:
- `fret-service.ts:660` — `handleLeave` warm loop pings the departing peer's suggested replacements (ids straight off the wire, near-guaranteed addressless).
- `fret-service.ts:543`, `:565` — preconnect loops.
- `fret-service.ts:1247` — `routeAct` forwards via `sendMaybeAct(next, ...)`; `chooseNextHop` takes `isConnected` only as a *scoring* input (`:1236`), not a hard filter.
- `fret-service.ts:1532`, `:1561` — `iterativeLookup` probes the target and remote-supplied anchors.

Expected behavior: peers with no live connection and no known addresses are skipped (or queued for when a connection appears), not dialed. `{ requireExisting: true }` — already used by `neighbors.ts:57` and `:87` — is the existing mechanism; the question per site is whether skipping is acceptable or whether the operation must be deferred/redirected.

**2. `hasAddresses()` fails silently to `false`.** It probes an optional `node.getMultiaddrsForPeer?.(pid)` and swallows all errors (`fret-service.ts:483-491`). On a node that does not expose that method, *every* peer reads as addressless, which quietly disables the announce paths that prefer non-connected peers — a silent behavior change keyed on host capability. Expected: fall back to a `peerStore.get` lookup rather than reporting `false` for everyone, or at minimum log once when the capability is absent.

Distinct from `backlog/feat-address-hints-in-neighbor-exchange` (which would make addresses *available*); this ticket is about not dialing when they demonstrably are not.
