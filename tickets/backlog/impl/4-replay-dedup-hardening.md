description: Tighten timestamp validation to ±30s, use crypto.randomUUID() for correlation IDs, and make dedup capacity profile-tuned
dependencies: none (leave dedup is handled by 4-leave-authentication ticket §3)
files: src/rpc/protocols.ts (validateTimestamp), src/service/fret-service.ts (~line 1239 correlation ID, ~line 99 dedupCache), src/service/dedup-cache.ts, test/dedup-cache.spec.ts, test/iterative-lookup.spec.ts, docs/fret.md
----

### Overview

Three changes close the 9.5-minute replay window identified in threat-analysis.md §3.3, §5.4, §5.6, §3.6:

1. **Tighten timestamp validation** from ±5 minutes to ±30 seconds
2. **Cryptographically strong correlation IDs** via `crypto.randomUUID()`
3. **Profile-tuned dedup capacity** to resist cache exhaustion

Leave notice dedup (the fourth gap) is addressed separately in the `4-leave-authentication` ticket §3.

### Threat references

- threat-analysis.md §3.3 (High): Replay attacks with 9.5-minute window
- threat-analysis.md §5.4 (Medium): Weak correlation ID generation
- threat-analysis.md §5.6 (Medium): Timestamp replay window
- threat-analysis.md §3.6 (Medium): Dedup cache poisoning

---

### 1. Tighten timestamp validation to ±30 seconds

#### Current state

`validateTimestamp` in `src/rpc/protocols.ts:86` defaults `maxDriftMs` to `300_000` (5 minutes). The dedup cache TTL is 30 seconds. This creates a 9.5-minute window where a replayed message passes timestamp validation but has already left the dedup cache.

#### Change

Change the default `maxDriftMs` from `300_000` to `30_000` (30 seconds). This aligns with the dedup cache TTL.

```typescript
export function validateTimestamp(ts: number, maxDriftMs = 30_000): boolean {
    return Math.abs(Date.now() - ts) <= maxDriftMs;
}
```

All three callers use the default:
- `handleMaybeAct` (fret-service.ts:346)
- `handleLeave` (fret-service.ts:503)
- neighbor snapshot handler (fret-service.ts:619)

No call-site changes needed — the tighter default applies everywhere.

#### Rationale

±30s is generous for NTP-synced systems (typical drift <1s). This eliminates the replay window while retaining tolerance for moderate clock skew. Systems with poor time sync (no NTP) may need the caller to pass a wider window, but the default should be secure.

---

### 2. Cryptographically strong correlation IDs

#### Current state

`iterativeLookup` (fret-service.ts:1239) generates:
```typescript
const correlationId = `${selfId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
```

`Math.random()` uses V8's xorshift128+ PRNG which is predictable from observed outputs. An attacker observing a few IDs can predict future ones and pre-fill the dedup cache.

#### Change

Replace with `crypto.randomUUID()`:
```typescript
const correlationId = `${selfId}-${crypto.randomUUID()}`;
```

`crypto.randomUUID()` uses a CSPRNG and is available in Node 16+, all modern browsers, Deno, and Bun via `globalThis.crypto`. The `selfId` prefix is retained for traceability/debugging (it doesn't need to be secret — the UUID provides the unpredictability).

For React Native environments where `globalThis.crypto.randomUUID` may not be available, use a fallback:

```typescript
function secureCorrelationId(selfId: string): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return `${selfId}-${globalThis.crypto.randomUUID()}`;
    }
    // Fallback: crypto.getRandomValues is more widely available
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${selfId}-${hex}`;
}
```

Place this helper in `fret-service.ts` as a module-level function (not exported — internal use only).

---

### 3. Profile-tuned dedup capacity

#### Current state

The dedup cache is hardcoded at 1024 entries with 30s TTL. At 30s TTL, this supports ~34 unique messages/second before eviction begins. For Edge nodes with low traffic, 1024 is wasteful. For Core nodes under heavy load, an attacker sending >34 msg/s can evict legitimate entries, enabling replays.

#### Change

Make the dedup cache size profile-dependent, parameterized through `FretConfig`:

- **Edge**: 512 entries (Edge nodes see lower traffic; rate limits cap inbound further)
- **Core**: 2048 entries (higher throughput; harder to exhaust via flooding)

In the `FretService` constructor, derive the capacity from the profile:

```typescript
const dedupCapacity = this.cfg.profile === 'core' ? 2048 : 512;
private readonly dedupCache = new DedupCache<...>(30_000, dedupCapacity);
```

This is a low-risk change — the capacity just affects when eviction kicks in, and the existing FIFO eviction policy remains.

---

### Test plan

**Timestamp tightening:**
- Existing tests that fabricate messages with `Date.now()` timestamps continue to pass (within ±30s)
- New test: message with timestamp 60s in the past is rejected (`validateTimestamp` returns false)
- New test: message with timestamp 25s in the past is accepted
- New test: message with timestamp 31s in the future is rejected

**Correlation ID strength:**
- New test: `secureCorrelationId` returns a string starting with the self ID prefix
- New test: two calls produce different IDs (non-deterministic)
- New test: the random portion has sufficient length (≥32 hex chars or UUID format)

**Profile-tuned capacity:**
- New test: Edge profile creates DedupCache with 512 capacity
- New test: Core profile creates DedupCache with 2048 capacity

---

### TODO

Phase 1: Tighten timestamp validation
- [ ] Change `validateTimestamp` default in `src/rpc/protocols.ts` from `300_000` to `30_000`
- [ ] Audit existing tests for hardcoded timestamps that might break with the tighter window; fix if needed

Phase 2: Cryptographically strong correlation IDs
- [ ] Add `secureCorrelationId(selfId: string): string` helper function in `fret-service.ts` (module-level, not exported)
- [ ] Replace the `Math.random()` correlation ID generation in `iterativeLookup` (~line 1239) with `secureCorrelationId(selfId)`

Phase 3: Profile-tuned dedup capacity
- [ ] Change the `dedupCache` initialization in `FretService` to derive capacity from `this.cfg.profile` (512 for Edge, 2048 for Core)

Phase 4: Tests
- [ ] Add timestamp validation boundary tests (±25s passes, ±31s/±60s fails) — can go in a new `test/replay-dedup.spec.ts` or extend `test/dedup-cache.spec.ts`
- [ ] Add correlation ID format/uniqueness tests
- [ ] Add dedup capacity profile tests (verify Edge=512, Core=2048)
- [ ] Verify existing test suite passes (`cd packages/fret && yarn test`)

Phase 5: Docs and build
- [ ] Update `docs/fret.md` "Current state" section: change "Timestamp bounds (±5 min)" to "Timestamp bounds (±30 s)"
- [ ] Update `docs/fret.md` "Not yet implemented" section: mark replay hardening items as done (tightened timestamp, strong correlation IDs, profile-tuned dedup capacity)
- [ ] Type-check passes (`cd packages/fret && npx tsc --noEmit`)
- [ ] Full test suite passes (`cd packages/fret && yarn test`)
