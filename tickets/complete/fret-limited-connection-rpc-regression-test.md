description: Added and reviewed a unit test that guards FRET's ability to run wire RPCs over relay-only (circuit-relay) connections — a code path that previously shipped with no test coverage.
prereq:
files:
  - packages/fret/src/rpc/protocols.ts (isLimitedConnection exported; no logic change)
  - packages/fret/test/rpc.protocols.spec.ts (new unit spec — the deliverable)
difficulty: easy
----

# Complete: regression test for FRET RPCs over limited (circuit-relay) connections

## What shipped

- `src/rpc/protocols.ts`: `isLimitedConnection` promoted module-private → `export`.
  No logic change; pure predicate, exported so the spec asserts it directly.
- `test/rpc.protocols.spec.ts` (new): now 11 tests (10 at implement handoff + 1
  added in review), Mocha + Chai, hand-rolled stub `Libp2p`/`Connection`, no real
  transport. Guards that `openRpcStream` opens over a limited connection with
  `runOnLimitedConnection` truthy, and that direct connections are preferred.

## Validation

- `npx tsc --noEmit` — clean.
- `test/rpc.protocols.spec.ts` — **11 passing**.
- Full suite (`test/**/*.spec.ts`) — **272 passing, 0 failing** (~3m). Export
  change is behavior-neutral; no regression.

## Review findings

Adversarial pass over the implement diff (spec + one-line export). Test-only
change, so the surface is the spec's own coverage and honesty, not production logic.

**Checked:**
- **Predicate correctness** — `isLimitedConnection`: `limits != null` covers both
  `null` and `undefined` in one branch; `/p2p-circuit` fallback; absent
  `remoteAddr` doesn't throw (optional-chained). All four branches asserted. Good.
- **Selection logic** — `openRpcStream`: direct-preferred (`find(!limited) ?? open[0]`),
  closed-filtered (`status === 'open'`), no-`newStream`-filtered, `requireExisting`
  short-circuit, dial fallback. All exercised. Ordering-independence proven by
  listing limited first in the direct-preferred test.
- **Guard actually bites** — if code dropped `runOnLimitedConnection` or set it
  falsy, the `.to.be.ok` assertions go red. Confirmed the regression it names is
  the regression it catches.
- **Type safety** — no `any`; casts confined to the stub→libp2p boundary. Matches
  repo style (tabs, no semicolons, `.js` ESM imports).
- **Docs** — `docs/fret.md` needs no change (test-only; protocol IDs & limited-conn
  behavior already documented under *libp2p integration*).

**Fixed inline (minor):**
- Headline limited-only test proved `newStream` was *called* but not that the
  connection was *reused* rather than re-dialed. Added
  `expect(dialCalls.length).to.equal(0)` — a broken "always dial" refactor would
  otherwise have slipped past. (`packages/fret/test/rpc.protocols.spec.ts`)

**Major:** none. No new tickets filed.

**Tripwires (parked, not ticketed):**
- **Multi-limited tie-break under-specified.** Only the single-limited case pins
  `open[0]`; a ring with several limited connections and no direct one is not
  asserted. Fine now (realistic steady state is 0–1 limited paths per peer). If a
  topology arises where a peer holds multiple concurrent circuit-relay connections
  to the same target and tie-break *order* becomes load-bearing, add a dedicated
  assertion. Parked as this findings bullet — no single code site to comment.
- **`negotiateFully: false` intentionally unpinned.** Assertions target
  `runOnLimitedConnection` only, so an unrelated new stream option won't false-red
  these. If `negotiateFully` is ever deemed load-bearing, add a targeted assertion.
  Documented in the spec's helper comment (`expectRunsOnLimited`).
- **`getConnections` stub ignores its `pid` arg** — returns the configured array
  regardless. Fine for single-peer tests; a reviewer extending to multi-peer
  scenarios must add pid-aware routing to the stub. Noted at implement handoff.
- **Stub, not real relay.** These prove *selection + opts* logic, not that a live
  circuit-relay transport accepts the stream. End-to-end relay behavior (does
  libp2p honor `runOnLimitedConnection` at runtime) remains uncovered on the Fret
  side and belongs in an integration/E2E test — the heavier optimystic-side
  4th-node-over-relay option was explicitly deferred by the original ticket.
