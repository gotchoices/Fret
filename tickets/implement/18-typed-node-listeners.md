description: Replace loose "any" typing on the core service's internal libp2p event-listener bookkeeping with the real event types, so a wrong payload shape is caught at compile time instead of silently doing nothing at runtime.
files: packages/fret/src/service/fret-service.ts
difficulty: medium

## Status

This is the last remaining item from ticket `18-cleanup-core-service` (9 runs of that ticket
landed everything else: `warmupTargetIds` extraction, merged `peer:connect` listener, wired
`ready()` — all confirmed present in the working tree, `npx tsc --noEmit` clean, `yarn test`
1116 passing / 0 failing, verified this run). This ticket exists only because that ticket kept
re-verifying instead of acting on the one item that needs a design decision. Do not re-run a
verification pass on the three landed items — they're done. Go straight to the task below.

## The task

`packages/fret/src/service/fret-service.ts` currently types the libp2p node-listener registry
and all four listener bodies as `any`:

- Line 203: `private readonly nodeListeners: Array<{ type: string; handler: (evt: any) => void }> = [];`
- Line 922: `this.addNodeListener('peer:connect', async (evt: any) => {`
- Line 942: `this.addNodeListener('peer:disconnect', async (evt: any) => {`
- Line 963: `this.addNodeListener('peer:identify', async (evt: any) => {`
- Line 977: `this.addNodeListener('peer:update', async (evt: any) => {`
- Line 1042: `private addNodeListener(type: string, handler: (evt: any) => void): void {`
  — body: `this.nodeListeners.push({ type, handler }); this.node.addEventListener(type as any, handler);`
- Line 1048: `private removeNodeListeners(): void {`
  — body loops `this.node.removeEventListener(type as any, handler);`

House style (`AGENTS.md`) says "Don't be type lazy - avoid `any`". Confirmed real payload types
from `node_modules/@libp2p/interface/dist/src/index.d.ts`, `Libp2pEvents` interface:

```
'peer:connect': CustomEvent<PeerId>;
'peer:disconnect': CustomEvent<PeerId>;
'peer:identify': CustomEvent<IdentifyResult>;
'peer:update': CustomEvent<PeerUpdate>;
```

`PeerId` is already imported at line 1 (`import type { Startable, PeerId } from '@libp2p/interface';`).
`IdentifyResult` and `PeerUpdate` are also exported from `@libp2p/interface` — add them to that
same import line. `this.node`'s type is `Libp2p<T>` (imported line 18 from `'libp2p'`), which
extends `TypedEventTarget<Libp2pEvents<T>>`.

### Try this first: generic `addNodeListener`

```ts
private addNodeListener<K extends keyof Libp2pEvents>(
	type: K,
	handler: (evt: Libp2pEvents[K]) => void
): void {
	this.nodeListeners.push({ type, handler } as { type: string; handler: (evt: any) => void });
	this.node.addEventListener(type, handler);
}
```

Import `Libp2pEvents` from `@libp2p/interface` alongside `PeerId` at line 1. Each call site
(lines 922/942/963/977) then types its own callback directly, e.g.
`this.addNodeListener('peer:connect', async (evt: CustomEvent<PeerId>) => { ... });` — no cast
needed at the call site because `K` is inferred from the string literal and checked against
`Libp2pEvents[K]` independently per call.

**Why this is likely to type-check where a flat `(evt: Event) => void` parameter does not:**
the previous ticket worked through this by hand and concluded a *non-generic* method parameter
typed `(evt: Event) => void` rejects a callback typed `(evt: CustomEvent<PeerId>) => void` under
`strictFunctionTypes` contravariant parameter checking, because `Event` is not assignable to
`CustomEvent<PeerId>` (missing `detail`) — and this is a `private` method parameter of
function-type (not shorthand method syntax), so the bivariant-method exception does not apply.
**That reasoning was never actually run through `tsc`** — verify it either way, but the generic
route above sidesteps the problem entirely: each call is checked against its own `K`, never
against one shared `Event`-typed parameter, so the contravariance issue shouldn't arise. Still
run `npx tsc --noEmit` to confirm — don't assume either way.

The `nodeListeners` array itself has a genuine problem the generic method doesn't fully solve:
it stores heterogeneous handlers (four different payload types) under one array. Options, in
order of preference:
1. If TypeScript accepts widening each handler to `(evt: any) => void` only at the point of
   pushing into the shared array (the `as` cast shown above, isolated to that one line) while
   every public-facing signature — the generic method's own parameters — stays fully typed, that
   contains the `any` to the one place it's structurally unavoidable (a heterogeneous array).
2. If that doesn't sit right, an alternative is a `type: string; handler: (evt: Event) => void`
   array (narrower than `any` — `Event` is the real common base type `CustomEvent` extends, not
   an escape hatch) with a cast only at the two `addEventListener`/`removeEventListener` call
   sites inside `addNodeListener`/`removeNodeListeners` — those casts are structurally necessary
   because a heterogeneous array of specifically-typed handlers cannot line up with libp2p's own
   overloaded `addEventListener<K>` signature without one.

Either way, the goal is: no `any` at the four call sites or in the method's own public signature;
`any` (if it survives at all) is isolated to the internal array's storage/dispatch mechanics,
which is a materially different, smaller admission than today's blanket `evt: any` on every
handler body.

### Fallback if the generic route doesn't compile

Keep `nodeListeners`/`addNodeListener` structurally as today (`(evt: Event) => void`, no `any`
in the type position — only in the two required casts at the `addEventListener`/
`removeEventListener` calls), and type each of the four listener bodies individually:

```ts
this.addNodeListener('peer:connect', async (evt: CustomEvent<PeerId>) => { ... });
this.addNodeListener('peer:disconnect', async (evt: CustomEvent<PeerId>) => { ... });
this.addNodeListener('peer:identify', async (evt: CustomEvent<IdentifyResult>) => { ... });
this.addNodeListener('peer:update', async (evt: CustomEvent<PeerUpdate>) => { ... });
```

This needs a cast at each call site (`handler as (evt: Event) => void` or similar) since a
`CustomEvent<PeerId>`-typed callback isn't directly assignable to `(evt: Event) => void` under
`strictFunctionTypes` — try the generic route first since it avoids this entirely.

## Inside each handler body, once typed

- `peer:connect` / `peer:disconnect` (line ~926, ~946): replace `evt?.detail?.toString?.()` —
  `evt.detail` is now statically a `PeerId`, so this becomes `evt.detail?.toString()` or similar;
  keep the optional-chaining only where the event itself could plausibly be malformed at runtime
  (it can't, from libp2p — this is defensive against nothing once typed, consider dropping the
  chain on `detail` itself, keeping it only on `.toString?.()` if `PeerId`'s `toString` could
  theoretically be absent, which it can't either — `PeerId extends { toString(): string }`).
  Judgment call: don't over-defend against a shape TypeScript now guarantees.
- `peer:identify` (line ~966): `const pid: PeerId | undefined = evt?.detail?.peerId;` — with
  `evt: CustomEvent<IdentifyResult>`, `evt.detail.peerId` is now statically typed; check
  `IdentifyResult`'s actual field name/type in `@libp2p/interface` matches (`peerId: PeerId`
  expected, but confirm) and drop the `undefined` fallback if the field is non-optional.
- `peer:update` (line ~980): `const peer = evt?.detail?.peer;` — with `evt: CustomEvent<PeerUpdate>`,
  check `PeerUpdate`'s shape (`peer: Peer` expected — confirm field name and that `Peer` has
  `.id: PeerId`, `.protocols: string[]`, `.addresses: Address[]` matching what the body already
  reads at lines 981/985/988).

## Acceptance

- `cd packages/fret && npx tsc --noEmit` clean.
- `cd packages/fret && yarn test` — expect 1116 passing, 0 failing (that's the current baseline
  on this branch, confirmed this run; a new failure is from this change, not carried debt).
- No behavior change — this is a typing-only refactor. The four handler bodies' logic is
  untouched; only the parameter/array type annotations change, plus whatever narrowing the new
  types make possible/necessary inside each body (e.g. dropping now-redundant optional chains).
- No `any` remaining at the four `addNodeListener` call sites or in `addNodeListener`'s /
  `removeNodeListeners`'s own signatures. `any` is acceptable only if structurally forced at the
  single point where the heterogeneous array is written to or dispatched from (see options above)
  — and even there, prefer the narrower `Event` type with a targeted cast over a bare `any` if it
  type-checks.

## Edge cases (unchanged behavior to preserve)

- `peer:connect` merged listener: the store-upsert/state/proof-of-life half still runs on every
  connect event; the one-time `postBootstrapAnnounced` guard + `announceNeighborsBounded(8)`
  half still fires exactly once, outside the `try/catch` so it still runs even if the try body
  no-ops early (e.g. `this.stopped` true, or no `id`).
- `stop()` still calls `removeNodeListeners()` (line 1016) and detaches everything cleanly —
  don't change call sites outside the four listener registrations and the two registry methods.

## Out of scope

Don't touch `warmupTargetIds`, the merged `peer:connect` listener's logic, or `ready()` — all
three are done and verified working (see Status above). Don't re-verify them; a diff review will
catch any regression.

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
