description: Graceful leave protocol with replacement suggestions
dependencies: FRET core (S/P sets, Digitree, neighbor management)
----

Completed the graceful departure protocol: peers now leave cleanly with replacement suggestions and bounded fan-out.

### What changed

#### Sender (`sendLeaveToNeighbors` in `src/service/fret-service.ts`)
- New `computeReplacements()` method gathers candidates from wider Digitree walk (m*2 each direction), excludes S/P set, sorts by connectivity then relevance, caps at 6.
- `sendLeaveToNeighbors()` populates `replacements` in `LeaveNoticeV1` before sending.
- Bounded fan-out: after notifying S/P, uses `expandCohort()` to notify additional connected peers (core=4, edge=2 extra).

#### Receiver (`handleLeave` in `src/service/fret-service.ts`)
- Merges `notice.replacements` (suggested by departing peer) with locally computed candidates, deduped.
- Probes suggested replacements first (departing peer vouched for them).
- New `announceReplacementsToNeighbors()` sends neighbor snapshot to up to 4 connected S/P neighbors around the departing coordinate (fire-and-forget).

#### Validation (`registerLeave` in `src/rpc/leave.ts`)
- `sanitizeReplacements()` truncates to 12 entries and drops unparseable PeerIds silently.
- Applied before passing to the `onLeave` callback.

#### Bug fix (`assembleCohort` in `src/service/fret-service.ts`)
- Fixed pre-existing infinite loop: when one direction (succ/pred) was exhausted, the alternating walk got stuck because the modulo check kept choosing the empty direction. Now falls back to the other direction.

### Testing

5 tests in `test/churn.leave.spec.ts`:
- `sendLeave triggers stabilization and replacement warming` — existing, still passes
- `leave notice includes replacement suggestions` — 6-node mesh, verifies leaving peer is removed
- `recipients probe suggested replacements from leave notice` — verifies ping/announce activity after leave
- `fan-out notifies peers beyond immediate S/P` — 8-node mesh with core profile (fanOut=4)
- `oversized replacements array is truncated` — sends crafted notice with 20 replacements, validates handling

All 67 tests pass (including churn simulation suite).

### Key files
- `packages/fret/src/rpc/leave.ts`
- `packages/fret/src/service/fret-service.ts`
- `packages/fret/test/churn.leave.spec.ts`
