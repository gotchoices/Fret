----
description: An automated test now covers the code that decides whether a connected peer belongs to this network or a co-resident one using its libp2p "identify" handshake — a path the old in-memory tests could never reach — and the review found that one of the three identify sub-paths was silently dead.
prereq:
files:
  - packages/fret/test/membership-identify.spec.ts (integration spec; 2 active tests + 1 skipped regression guard)
  - packages/fret/test/helpers/libp2p.ts (createIdentifyNode factory: TCP + identify + identifyPush)
  - packages/fret/package.json (devDependency @libp2p/identify@4.0.10)
  - packages/fret/src/service/fret-service.ts (system under test — peer:identify/peer:update ~357-378; classifyByProtocols ~291; classifyFromPeerStore ~298; seedFromPeerStore ~804)
  - tickets/backlog/bug-seedfrompeerstore-getpeers-noop.md (major finding filed from this review)
difficulty: medium
----

# Review: integration test for identify-driven membership classification

## What this covered (plain language)

FRET labels every peer it knows as `member` (serves this network), `foreign` (serves only
some other network sharing the transport), or `unknown` (not yet decided). One way it
decides is libp2p's `identify` handshake, which tells each peer what protocols the other
supports. The old in-memory test nodes run no `identify`, so that whole path had zero
automated coverage. This ticket added real TCP + identify nodes and tests for it.

## What was implemented (by the implement stage)

- `createIdentifyNode()` in `test/helpers/libp2p.ts` — a TCP node with `identify` +
  `identifyPush`, so the peerStore protocol list populates and `peer:identify` /
  `peer:update` fire.
- `test/membership-identify.spec.ts` — member + foreign classification via identify, and
  `foreign → member` re-admission via `peer:update`, each with the observer's probe pass
  stubbed out and a `pingsSent === 0` witness so identify is provably the sole cause.
- `@libp2p/identify@4.0.10` devDependency, pinned (not 4.1.x) to avoid a duplicate
  `@libp2p/interface` copy that breaks the type-check.

## Review findings

### Checked — implementation correctness & test isolation (no change needed)

- **The "no outbound probe ⇒ identify is the only classifier" claim holds.** Verified the
  two paths that could classify a peer *without* a probe and *without* identify are inert
  here: the inbound ping handler (`handlePingRequest`, ~445) returns a size estimate and
  never touches membership; the inbound announce merge (`mergeAnnounceSnapshot`, ~759) uses
  `applyTouch`, not `applySuccess`, so it never marks the sender `member`. Only
  `applySuccess` (off an outbound RPC, which would bump `pingsSent`) and the identify path
  set `member`. So with `stabilizeOnce` stubbed and `pingsSent === 0` asserted, identify is
  genuinely the sole source.
- **Default mode is `passive`** (constructor ~101), so `preconnectNeighbors` (a `pingsSent`
  source) does not run at start — the `pingsSent === 0` witness is sound.
- **Re-admission isolation is airtight**: `seedFromPeerStore` re-classifies only `unknown`
  peers (~816), never `foreign`, so `peer:update` is the only thing that can flip a
  `foreign` peer to `member` once probing is off.
- **Dependency pin confirmed**: `@libp2p/identify@4.0.10` is installed; its
  `@libp2p/interface@^3.1.0` range dedupes onto the project's single `3.1.0` copy. `tsc
  --noEmit` is clean (the duplicate-package symptom would surface there). The pin rationale
  and minimal `yarn.lock` churn check out.

### Found — MAJOR: a third identify sub-path is dead code → filed `bug-seedfrompeerstore-getpeers-noop`

Trying to add a test that *isolates* the peerStore poll path
(`seedFromPeerStore → classifyFromPeerStore`, the one identify sub-path the implementer's
two tests leave racing with the event handlers) exposed that the path never runs with real
libp2p:

`seedFromPeerStore` enumerates peers via `this.node.peerStore.getPeers()`, **which does not
exist** — `getPeers()` is on the libp2p *node* (connected peers), not the peerStore (whose
enumerator is `all()`). The optional-call seam (`peerStore?.getPeers?.()`) plus a permissive
`WithPeerStore` type masks it: the call yields `undefined → [] `, so the per-peer
upsert/`setState`/`classifyFromPeerStore` loop is a silent no-op. Confirmed at runtime
(`node.getPeers` = function/count 1; `node.peerStore.getPeers` = undefined;
`node.peerStore.all` = function/count 1).

No user-visible breakage today because three other paths cover classification (`peer:connect`,
the `peer:identify`/`peer:update` listeners, and the probe pass) — so it's a latent defect /
dead code, not an outage. **Disposition:** filed as a `bug-` (reachable-now) ticket rather
than fixed inline, because the fix flips on per-tick peerStore enumeration — a production
stabilization behavior change that needs its own testing and, critically, interacts with the
existing `bug-upsert-resets-peer-stats-each-tick` (whose "clobbers stats every tick" premise
is itself currently false *because* this loop is dead; fixing this one activates that one).
Both relationships are documented in the new ticket.

### Done — added a pre-written regression guard (minor, inline)

Added the poll-path isolation test to `membership-identify.spec.ts` as `it.skip`, with a
comment pointing at the bug ticket and written to pass against the fixed enumeration. It
connects two identify nodes, lets libp2p populate the observer's peerStore *before* its
FretService starts, then asserts classification synchronously right after `start()` — which
pins the poll path alone (start awaits `seedFromPeerStore` before attaching any event
listener). Un-skip when the bug lands.

### Tripwires (recorded, not ticketed)

- **`disableProbing` stubs a private method (`stabilizeOnce`) via cast.** Test-only; if
  renamed, the stub silently stops isolating but the `pingsSent === 0` assertion then
  *fails* and flags it (probe and identify agree on labels, so it never produces a false
  pass). Acceptable — not worth adding production surface for a test-only seam. Parked here
  in findings (no single new code site warrants a `NOTE:`).
- **Re-admission test timing** rides the `identifyPush` debounce (~1s) + a round-trip;
  `waitFor` budget is 10s and it lands in ~2s locally. Most likely of the suite to be slow
  on a loaded CI box; no flakiness observed across runs. Left at 10s (generous).

### Empty categories (explicit)

- **Docs**: no change required. `docs/fret.md` describes the *intended* identify behavior
  correctly; the bug is the code not matching it, which the new ticket fixes — patching the
  doc would misrepresent current reality. The dead-poll-path nuance lives in the bug ticket,
  not the design doc.
- **Production code edits in this pass**: none. The only correctness issue found is the
  major bug above, dispositioned to its own ticket per the reason given; all other checks
  passed as-is.
- **Other regressions / new bugs**: none beyond the one filed.

## Validation performed (review)

- `cd packages/fret && npx tsc --noEmit` → clean
- new spec alone → 2 passing, 1 pending (the skipped guard)
- `cd packages/fret && yarn test` → **256 passing, 1 pending, 0 failing**
