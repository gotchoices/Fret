----
description: The peer-announcement sweep now resumes where it left off instead of restarting from the beginning each time, so a node that knows more peers than its bookkeeping can remember eventually tells libp2p about all of them rather than the same half forever.
files: packages/fret/src/store/digitree-store.ts (`RingCursor`, `RingWalkPage`, `walkFrom`), packages/fret/src/service/peer-discovery.ts (`scanOnce`, `cursor`, `FretPeerDiscoveryConfig.maxTracked`), packages/fret/src/service/libp2p-fret-service.ts (profile sizing comment), packages/fret/src/index.ts (type re-exports), packages/fret/test/digitree.invariants.spec.ts (`DigitreeStore.walkFrom` block), packages/fret/test/peer-discovery.spec.ts (coverage property, cursor-reset case, retargeted capacity case), docs/fret.md (libp2p integration → Discovery)
----

## What shipped

`FretPeerDiscovery` used to walk `store.list()` from ring position 0 on **every** tick, emitting up
to `batchSize` peers not currently in its `emitted` debounce map. Once the live-member population
exceeded that map's capacity (`maxTracked`), evictions always landed nearest the front of the ring,
so the sweep re-reached those peers, re-emitted them, and never advanced past roughly
`maxTracked + batchSize` positions. Everything beyond was emitted **never** — permanently, since
ring position is a stable hash of the peer id.

Three pieces make the sweep resume:

**`DigitreeStore.walkFrom(cursor, count, filter)` → `{ entries, next }`** (new). One page of a ring
walk starting **strictly after** `cursor` (at the ring start when `null`), wrapping past the end,
skipping filter misses rather than stopping, and visiting at most `size()` entries — one full lap —
so a ring where nothing matches terminates. `RingCursor` is an opaque `{ key }` token minted and
consumed by the store, because the position it names is the store's private tree key
(`hex(coord)|id`). Returns `PeerEntry[]` so the caller gets its next cursor without a second
`getById`.

**`FretPeerDiscovery.scanOnce()`** (was the private `scan`). Holds a `cursor` as instance state,
asks the store for one page, advances the cursor from `page.next`, then emits. The three exclusions
— `isLiveMember`, the self check, the `emitted.has` debounce — moved *into* the walk's filter
predicate, which is what makes a skipped entry advance the walk instead of consuming one of the
tick's `batchSize` slots. `stop()` clears the cursor alongside `emitted.clear()`. It is deliberately
public so the coverage property can drive ticks without the scheduler.

**Comments and docs.** The three starvation `NOTE:` blocks are gone. The Core 4096 / Edge 1024
`maxTracked` split is kept and re-justified as a profile-scaled memory ceiling, since coverage no
longer depends on it. `docs/fret.md` (libp2p integration → Discovery) drops the "Known defect"
paragraph and states the cursor rule and the `ceil(N / batchSize)` drain instead.

Two design points that carry the fix: resuming *strictly after* rather than *at* the cursor (resuming
at it re-emits that peer whenever its debounce lapses, spending a page slot every tick and, at
`batchSize: 1`, never advancing at all), and an empty page returning the **input** cursor as `next`
rather than `null` (returning `null` would silently restart the sweep whenever a lap found nothing
eligible).

## Review findings

### Checked

- **`walkFrom` correctness.** Traced strictly-after resumption on both paths — cursor entry still
  present, and cursor entry evicted so `find` lands in the crack where the key used to be — against
  the store's own `ceilPath` / `floorPath` crack semantics at `digitree-store.ts:279-293`; `next()`
  of a crack path is the entry after it, so both resume at the right ring position. Wrap, bounded
  scan at `size()`, empty-page-holds-position, `count <= 0`, and the empty ring all behave as
  documented.
- **The coverage claim, by hand, at the adversarial settings** the property generates
  (`maxTracked: 1` against 200 members, at `batchSize` 1 and 50). `emitted.set` running *after* the
  walk rather than during it is what keeps a page from mis-deduping against itself, and the
  eviction order never re-starves a position the cursor has passed.
- **Per-tick cost.** The handoff lists this as "argued, not measured". Reading `list()` at
  `digitree-store.ts:254` settles it in the fix's favour: the old `scan` allocated a full N-entry
  array **every tick unconditionally**, while `walkFrom` is a path walk with no allocation that
  stops as soon as the page fills. Worst case (everything debounced, one full lap of path steps) is
  what `list()` already cost. Strictly cheaper, not merely unchanged.
- **Lifecycle and cleanup.** `Libp2pFretService.start()` / `stop()` drive `discovery.start()` /
  `stop()`; `stop()` clears the timer, the debounce map, and the cursor.
- **`emitted.sweep()` is still unconditional per tick,** so the doc claim "swept on every scan tick"
  survives the refactor even though `has()` is now called only for entries the page actually
  reaches.
- **Docs against code.** Read the whole `docs/fret.md` Discovery section against
  `peer-discovery.ts`, `libp2p-fret-service.ts`, and `digitree-store.ts`. Accurate; the defect
  paragraph is correctly removed and the replacement matches what the code does.
- **Error handling and type safety.** The emit loop keeps its per-entry `try` / `catch` and the
  cursor-already-advanced consequence is documented at the site. No `any`. `RingCursor.key` is
  `readonly`.
- **Lint.** There is no lint step in this repo (`AGENTS.md`: `yarn format` / `format:check` are
  knowingly broken against the house tab style; `yarn check` is the gate). Typecheck stands in.

### Found and fixed in this pass (minor)

- **Two stale references to the renamed method.** The class doc at `peer-discovery.ts:64` pointed at
  "the multiaddr NOTE in `scan`" and `test/peer-discovery.spec.ts:19` said
  "FretPeerDiscovery.scan" — neither exists after the rename to `scanOnce`. Both renamed.
- **`stop()` resetting the cursor was claimed but untested.** The existing
  `stop clears emitted cache and timer` case runs on a **one-peer ring**, where a retained cursor
  and a cleared one are indistinguishable — clearing only the debounce map would pass it. Added
  `stop resets the sweep cursor to the ring start`: three members, `batchSize: 1`, ticks driven
  directly, asserting the post-`stop` tick emits the ring-order-**first** member rather than the
  third.

### Found, appended to an existing ticket (major, already claimed)

- **`walkFrom` is a fifth copy of the wrap-and-skip walk loop** in `digitree-store.ts`, alongside
  `successorOfCoord`, `predecessorOfCoord`, `neighborsRight`, and `neighborsLeft`. The site-claim
  check found `tickets/plan/19-cleanup-store-ring.md` already claims exactly it ("Four
  near-identical wrap walks exist in the store; extract one directional walker and reuse it"), so
  this is evidence, not a new ticket. Appended as an arm there, with the reason it matters beyond
  tidiness: the shared shape carries the bounded-scan guard that stops a filtered walk spinning
  forever on the wrap-around when nothing matches, so each copy is a site where a future walk can be
  written without that guard. Extracting the walker makes an unbounded filtered ring walk
  unwritable in the store rather than a convention each new method must remember.

### Considered and not filed

- **New-member emission latency.** A peer classified `member` just behind the cursor now waits up to
  a full lap (`ceil(N / batchSize)` ticks; ~8.5 min at Core defaults against a full 2048-entry
  table) instead of possibly the next tick. Not a regression: under the old scan, "next tick" only
  ever applied to peers near ring position 0, and everything past `maxTracked + batchSize` waited
  forever. Bounded-and-fair replaces unbounded-and-biased, and the `scanOnce` doc comment already
  states the lap cost.
- **An uncaught throw out of `scanOnce` inside the `setInterval` callback would be process-fatal.**
  Pre-existing shape — the old `scan` had identical exposure through `store.list()` — speculative,
  and not made more reachable by this diff. Left alone rather than parked; a `NOTE:` for every
  "what if this throws" is noise, not knowledge.
- **`walkFrom` returns live `PeerEntry` references.** The handoff flags it. It is `list()`'s existing
  convention and no caller mutates the result, so it is not a new hazard introduced here.

### Tripwires parked

None. The two conditional concerns in this area already carry their own `NOTE:` at their sites and
were not changed: the filtered-walk skip-scan cost (`digitree-store.ts:303`, whose "the ordered-walk
methods below" scope covers `walkFrom` as written) and per-entry TTLs in `ExpiringMap`
(`expiring-map.ts:45`).

### Empty categories

- **No `blocked/` ticket** — nothing in this diff needs a human decision.
- **No new `fix/`, `plan/`, or `backlog/` ticket** — the one architectural finding was already
  claimed by an open ticket and became an arm on it, and no other finding rose above minor.

## Validation

`cd packages/fret && npx tsc --noEmit` clean. `yarn test` → **590 passing, 0 failing** (~4 min) —
589 from the implement stage plus the cursor-reset case added here. No pre-existing failures
surfaced, so no `tickets/.pre-existing-error.md` was written.

## Test coverage as it stands

- **`test/peer-discovery.spec.ts` → `FretPeerDiscovery ring coverage (property)`** — `fast-check`
  over population ∈ [1, 200] × `maxTracked` ∈ [1, 200] × `batchSize` ∈ [1, 50], 200 runs, asserting
  every member is emitted within `2 * ceil(N/B) + 2` directly-driven ticks, and asserting on its own
  generated distribution so the `N > maxTracked` region is provably reached. 200 real Ed25519 ids
  minted once in `before()`, since `scanOnce` runs `peerIdFromString` on every emission.
- **`test/digitree.invariants.spec.ts` → `DigitreeStore.walkFrom`** — one lap visits every entry
  exactly once in ring order; wraps; a single page caps at one lap even when `count` exceeds the
  ring; a one-peer ring re-yields its peer; filter misses are skipped not counted; an all-miss filter
  terminates and holds position; empty ring; `count <= 0`; and a cursor whose entry was removed
  between pages resumes at the next ring position.
- **The retargeted capacity case** — *debounce map caps at maxTracked and evicts…* now runs at
  `maxTracked: 2` against 5 members (was `4`, chosen to dodge the bug), so it proves the fix
  directly.
- **`stop resets the sweep cursor to the ring start`** — added in review, above.

Known gaps that remain, unchanged from the implement handoff and judged not worth a ticket: the
property takes wall-clock expiry out of play (`debounceMs: 3_600_000`) so the capacity rule is what
is under test, and `emitted`'s clock is not injectable from `FretPeerDiscovery`'s config; the
property never runs the `setInterval` path or the lazy `DiscoverySnapshotSource` thunk, which the
existing wall-clock cases cover; and coverage is asserted as set membership after a tick bound, so
nothing pins emission *ordering* or an upper bound on re-emission frequency — a sweep that thrashed
but still eventually covered the ring would pass.
