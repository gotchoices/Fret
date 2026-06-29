description: Sanitize metadata keys and bound metadata size to prevent prototype pollution and storage bloat
dependencies: none
files: src/service/fret-service.ts (mergeAnnounceSnapshot ~line 600-603), src/store/digitree-store.ts (update ~line 93-98)
----

### Problem

The `metadata` field (`Record<string, any>`) received in announcements is stored and propagated without sanitization:

- Not validated for dangerous keys (`__proto__`, `constructor`, `toString`)
- Not size-limited — an attacker can inject arbitrarily large metadata payloads
- Propagated to all peers who receive snapshots
- Stored indefinitely in peer entries
- Spread via `{ ...cur, ...patch }` in `DigitreeStore.update`, which is vulnerable to prototype pollution if keys like `__proto__` are present

### Expected behavior

1. Reject or strip metadata keys that match known prototype pollution vectors (`__proto__`, `constructor`, `prototype`).
2. Use `Object.create(null)` for metadata storage so prototype chain attacks have no effect.
3. Enforce a size limit on metadata (e.g., max keys, max total serialized bytes).
4. Validate metadata values are JSON-safe primitives or simple objects (no functions, no circular references).

### Threat references

- threat-analysis.md §8.1 (Medium): Metadata prototype pollution
- threat-analysis.md §6.5 (Medium): Metadata injection — storage bloat and cross-layer injection
