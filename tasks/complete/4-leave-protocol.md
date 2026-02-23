description: Graceful leave protocol with replacement suggestions
dependencies: FRET core (S/P sets, Digitree, neighbor management)
----

Graceful departure protocol: peers leave cleanly with replacement suggestions and bounded fan-out.

### Implementation

#### Sender (`sendLeaveToNeighbors` in `src/service/fret-service.ts`)
- `computeReplacements()` gathers candidates from wider Digitree walk (m*2 each direction), excludes S/P set, sorts by connectivity then relevance, caps at 6.
- `sendLeaveToNeighbors()` populates `replacements` in `LeaveNoticeV1` before sending to S/P neighbors (capped at 8).
- Bounded fan-out: after S/P, uses `expandCohort()` to notify additional connected peers (core=4, edge=2 extra).

#### Receiver (`handleLeave` in `src/service/fret-service.ts`)
- Rate limited via `bucketLeave`; validates timestamp freshness.
- Removes departing peer from store.
- Merges `notice.replacements` (suggested by departing peer) with locally computed candidates, deduped.
- Probes suggested replacements first (departing peer vouched for them), warms up to 6.
- `announceReplacementsToNeighbors()` sends neighbor snapshot to up to 4 connected S/P neighbors around the departing coordinate (fire-and-forget).

#### Validation (`registerLeave` in `src/rpc/leave.ts`)
- `sanitizeReplacements()` truncates to 12 entries and drops unparseable PeerIds silently.
- Applied before passing to the `onLeave` callback.

#### Bug fix (`assembleCohort` in `src/service/fret-service.ts`)
- Fixed infinite loop: when one direction (succ/pred) was exhausted, the alternating walk got stuck. Added fallback to the other direction.

### Review fixes applied
- **Bug fix**: Removed `applyFailure` call after `store.remove()` in `handleLeave` — was re-inserting the just-removed peer via `upsert` inside `applyFailure`.
- **Indentation**: Fixed inconsistent indentation in `sendLeaveToNeighbors` try block.
- **Test: "leave notice includes replacement suggestions"**: Removed dead code (unused variables: `receivedNotices`, `originalSend`, `capturedNotice`, spy handler). Added actual assertion that the leaving peer is removed from all remaining services' stores.
- **Test: "oversized replacements array is truncated"**: Rewrote to register a custom leave handler that captures the sanitized notice, then asserts `replacements.length ≤ 12`.
- **Docs**: Added `LeaveNoticeV1` wire format to `docs/fret.md` (was missing from wire formats section).

### Testing

5 tests in `test/churn.leave.spec.ts`:
- `sendLeave triggers stabilization and replacement warming` — 4-node mesh, stops one, verifies others survive
- `leave notice includes replacement suggestions` — 6-node mesh, asserts leaving peer removed from all stores
- `recipients probe suggested replacements from leave notice` — verifies ping/announce diagnostics increase after leave
- `fan-out notifies peers beyond immediate S/P` — 8-node mesh with core profile (fanOut=4)
- `oversized replacements array is truncated` — sends 20 replacements, verifies truncation to ≤12

All 67 tests pass (including churn simulation suite).

### Key files
- `packages/fret/src/rpc/leave.ts`
- `packages/fret/src/service/fret-service.ts`
- `packages/fret/test/churn.leave.spec.ts`
- `docs/fret.md`
