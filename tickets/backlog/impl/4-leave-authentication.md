description: Add liveness verification before peer removal, treat suggested replacements as untrusted, and add leave dedup
dependencies: 5-message-signatures (sig field + verification), 5-transport-identity-verification (from-field check) — but all work below is independent and ships first
files: src/service/fret-service.ts (handleLeave ~501-562), src/rpc/leave.ts, src/rpc/ping.ts, test/churn.leave.spec.ts, docs/fret.md
----

### Overview

`handleLeave` currently removes a peer immediately on receipt of a leave notice and prioritizes attacker-controllable suggested replacements. Three independent hardening measures close the spoofing / replay / Sybil-injection vectors without waiting for the message-signatures or transport-identity tickets:

1. **Liveness verification** — ping the allegedly departing peer before removal
2. **Untrusted replacement handling** — demote suggested replacements and verify before warming
3. **Leave notice dedup** — prevent replay of captured leave notices

### Threat references

- threat-analysis.md §3.2 (Critical): Leave notice spoofing removes honest peers
- threat-analysis.md §7.1 (Critical): Forced peer removal at scale
- threat-analysis.md §7.2 (High): Leave replacement poisoning

---

### 1. Liveness verification before peer removal

#### Design

When `handleLeave` receives a notice claiming peer X is departing, before removing X from the store:

```
1. Rate limit check (existing bucketLeave)
2. Timestamp validation (existing validateTimestamp)
3. Leave dedup check (new — see §3)
4. Liveness ping to peer X:
   - sendPing with a 5-second timeout (Promise.race with a timer)
   - If ping succeeds (peer responds) → DON'T remove. Log warn. Increment diag counter.
   - If ping fails (unreachable, timeout, error) → proceed with removal as today.
```

#### Rationale

- **Genuine departure**: Peer sends leave notices then shuts down. By the time neighbors receive and attempt the liveness ping, the peer is unreachable → removal proceeds normally.
- **Spoofed leave**: Attacker sends fake leave notice for victim. Liveness ping reaches the victim who responds → no removal. Attack thwarted.
- **Race condition (ping succeeds during shutdown)**: Peer stays in store temporarily. The next stabilization cycle detects it's unreachable and removes it via normal failure detection. Slight delay, but safe — no data loss.

#### Implementation

Add a private helper to `FretService`:

```typescript
private async isReachable(peerId: string, timeoutMs = 5000): Promise<boolean> {
	try {
		const result = await Promise.race([
			sendPing(this.node, peerId, this.protocols.PROTOCOL_PING),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('liveness timeout')), timeoutMs)
			),
		]);
		return result.ok;
	} catch {
		return false;
	}
}
```

In `handleLeave`, after timestamp validation and before `this.store.remove(peerId)`:

```typescript
// Liveness verification: if peer is still reachable, don't remove
if (entry) {  // only check peers we actually track
	const alive = await this.isReachable(peerId);
	if (alive) {
		log.warn('leave notice for %s but peer is still reachable — ignoring', peerId);
		this.diag.rejected.livenessCheckPassed++;
		return;
	}
}
```

The `entry` guard ensures we only ping peers in our store. Unknown peers can't be removed anyway.

---

### 2. Untrusted replacement handling

#### Current behavior (fret-service.ts ~520-541)

Suggested replacements from the leave notice are inserted first ("departing peer vouched for them"), then locally-computed candidates. This lets an attacker inject Sybil nodes as trusted replacements.

#### New behavior

Reverse the priority: **local replacements first**, then suggested (after verification). Don't warm suggested replacements that fail a ping check.

```typescript
// Local replacements first (trusted), then suggested (untrusted hints)
const seen = new Set([peerId, selfStr, ...base]);
const newIds: string[] = [];
for (const id of localNew) {
	if (!seen.has(id)) { newIds.push(id); seen.add(id); }
}
for (const id of suggested) {
	if (!seen.has(id)) { newIds.push(id); seen.add(id); }
}
```

During the warming loop, check ping results before proceeding with announcement/snapshot merge for suggested replacements:

```typescript
const suggestedSet = new Set(suggested);
for (const id of warm) {
	try {
		const pingResult = await sendPing(this.node, id, this.protocols.PROTOCOL_PING);
		if (!pingResult.ok && suggestedSet.has(id)) {
			// Suggested replacement failed verification — skip
			continue;
		}
		// ... existing announcement and warming logic
	} catch (err) { ... }
}
```

Locally-computed replacements that fail ping are still warmed (they may just be temporarily busy). Only suggested/untrusted replacements are gated on ping success.

Update the comment from "Suggested first, departing peer vouched for them" to "Local first (trusted), then suggested (untrusted hints)".

---

### 3. Leave notice dedup

#### Design

Add a `DedupCache<boolean>` for leave notices, keyed by `${from}:${timestamp}`. This prevents exact replay of a captured leave notice within the dedup window.

```typescript
private readonly leaveDedup = new DedupCache<boolean>(60_000, 256);
```

- **TTL: 60 seconds** — much smaller than the timestamp window (±5 min), but the replay-dedup-hardening ticket will tighten the timestamp window to ±30s, at which point the dedup TTL and timestamp window will align.
- **Max size: 256** — leave notices are infrequent compared to maybeAct; 256 entries is ample.
- **Key: `${from}:${timestamp}`** — composite key prevents replay of the same notice. Different timestamps produce different keys. When the sig field lands (message-signatures ticket), the key can optionally include the signature for stronger dedup, but from+timestamp is sufficient since legitimate re-sends will have different timestamps.

In `handleLeave`, after timestamp validation:

```typescript
const dedupKey = `${peerId}:${notice.timestamp}`;
if (this.leaveDedup.has(dedupKey)) {
	this.diag.rejected.duplicateLeave++;
	return;
}
this.leaveDedup.set(dedupKey, true);
```

---

### 4. Diagnostic counters

Add to `diag.rejected`:

```typescript
rejected: {
	// ... existing ...
	duplicateLeave: 0,
	livenessCheckPassed: 0,
},
```

These are exposed through `getDiagnostics()` for monitoring and test assertions.

---

### 5. Documentation updates

In `docs/fret.md`, "Not yet implemented" section:
- Move "Leave authentication: Require signature from departing peer" to a "Partially implemented" note
- Change to: "Leave authentication: Liveness verification and dedup implemented. Signature verification depends on message-signatures ticket."
- Update the `## Leave` section to note that recipients perform a liveness check before removal and treat suggested replacements as untrusted hints

---

### Test plan (`test/churn.leave.spec.ts`)

Extend the existing test file with new cases:

**Liveness check blocks removal of reachable peer:**
- Create 3 nodes, connect, let stabilize
- Send a leave notice from node A claiming node B is departing (but node B is still running)
- Assert node B is still in node A's peer list after processing
- Assert `diag.rejected.livenessCheckPassed > 0`

**Liveness check allows removal of unreachable peer:**
- Create 3 nodes, connect, let stabilize
- Stop node B (genuinely depart)
- Send leave notice from node B to node A
- Assert node B is removed from node A's store

**Leave dedup prevents replay:**
- Create 2 connected nodes with a custom leave handler
- Send identical leave notice twice (same from + timestamp)
- Assert the handler processes only the first
- Assert `diag.rejected.duplicateLeave > 0`

**Suggested replacements not prioritized over local:**
- Requires inspecting the order in which replacement IDs are warmed
- Assert that locally-computed replacement IDs appear before suggested ones in the warming sequence (can verify via ping order or by instrumenting the warming loop)

**Unreachable suggested replacement is skipped:**
- Send leave notice with suggested replacements that include a stopped (unreachable) peer
- Assert the unreachable suggestion is not inserted into the store / not snapshot-merged

---

### TODO

Phase 1: Leave dedup
- [ ] Add `leaveDedup` field (`DedupCache<boolean>`, 60s TTL, 256 max) to `FretService`
- [ ] Add `duplicateLeave: 0` to `diag.rejected`
- [ ] Add dedup check in `handleLeave` after timestamp validation — return early if duplicate
- [ ] Insert into dedup cache after check passes

Phase 2: Liveness verification
- [ ] Add `isReachable(peerId, timeoutMs)` private method to `FretService`
- [ ] Add `livenessCheckPassed: 0` to `diag.rejected`
- [ ] In `handleLeave`, after dedup check and before `this.store.remove()`, call `isReachable`; skip removal if peer responds

Phase 3: Untrusted replacement handling
- [ ] Reverse priority order in `handleLeave`: iterate `localNew` before `suggested`
- [ ] Update comment to "Local first (trusted), then suggested (untrusted hints)"
- [ ] In warming loop, gate suggested replacements on successful ping (skip if `!pingResult.ok && suggestedSet.has(id)`)

Phase 4: Tests
- [ ] Add "liveness check blocks removal of reachable peer" test
- [ ] Add "liveness check allows removal of unreachable peer" test
- [ ] Add "leave dedup prevents replay" test
- [ ] Add "suggested replacements not prioritized" test
- [ ] Add "unreachable suggested replacement is skipped" test
- [ ] Verify existing leave tests still pass (`yarn test`)

Phase 5: Docs and build
- [ ] Update `docs/fret.md` leave section and "Not yet implemented" list
- [ ] Type-check passes (`cd packages/fret && npx tsc --noEmit`)
- [ ] Full test suite passes (`cd packages/fret && yarn test`)
