description: Implement cryptographic signatures on all FRET protocol messages
dependencies: none (parallel with 5-transport-identity-verification; complementary defense-in-depth)
files: src/rpc/sign.ts (new), src/rpc/protocols.ts, src/rpc/neighbors.ts, src/rpc/maybe-act.ts, src/rpc/leave.ts, src/service/fret-service.ts, src/service/libp2p-fret-service.ts, src/index.ts, docs/fret.md, test/sign.spec.ts (new), test/signature-integration.spec.ts (new)
----

### Overview

All outbound FRET messages must be signed with the sender's libp2p private key. All inbound messages must have their signature verified against the claimed sender's public key before processing. Invalid signatures are dropped and the sender is penalized via `report()`.

This closes threat-analysis.md §5.1 (Critical) and §3.1 (Critical: message forgery).

### Architecture

#### New module: `src/rpc/sign.ts`

A single signing/verification module that all RPC layers call. Keeps crypto logic in one place.

```typescript
import type { PrivateKey, PublicKey } from '@libp2p/interface';

/** Domain-separation prefix prevents cross-protocol replay. */
type MessageDomain = 'fret.neighbors.v1' | 'fret.maybeAct.v1' | 'fret.leave.v1';

/**
 * Canonical bytes for signing: UTF-8(domain) || UTF-8(canonicalJson).
 * canonicalJson = JSON.stringify with sorted keys, sig/signature field excluded.
 */
function signable(domain: MessageDomain, msg: Record<string, unknown>): Uint8Array;

/** Sign a message, returning base64url-encoded signature. */
async function signMessage(
  domain: MessageDomain,
  msg: Record<string, unknown>,
  privateKey: PrivateKey
): Promise<string>;

/** Verify a message signature. Returns true if valid. */
async function verifyMessage(
  domain: MessageDomain,
  msg: Record<string, unknown>,
  signature: string,
  publicKey: PublicKey
): Promise<boolean>;

/**
 * Resolve public key from a peer ID string.
 * For Ed25519/secp256k1, the public key is embedded in the peer ID multihash.
 * For RSA, the public key may not be available — return undefined.
 */
function publicKeyFromPeerId(peerIdStr: string): PublicKey | undefined;
```

**Canonical JSON**: To produce a deterministic byte representation for signing:
1. Clone the message object
2. Delete the signature field (`sig` or `signature`) from the clone
3. `JSON.stringify` with a replacer that sorts keys alphabetically at every nesting level
4. Prepend the domain string as `UTF-8(domain) + '\0' + UTF-8(json)`

This is simple, cross-platform, and doesn't require additional dependencies. The null byte separator prevents domain/message ambiguity.

#### Private key threading

libp2p stores the private key in its internal `Components` object (not exposed on the `Libp2p` class directly). The private key must be threaded through to `FretService`:

1. Add optional `privateKey?: PrivateKey` to `FretConfig`
2. In `FretService` constructor, store `this.privateKey = cfg.privateKey`
3. In `Libp2pFretService`, access the private key from the libp2p `Components` if available
4. If no private key is provided, signing is skipped (backward compat for tests) but a warning is logged on start
5. Verification always runs (public keys are extractable from peer IDs for Ed25519/secp256k1)

#### Wire format changes

**LeaveNoticeV1** — add `sig` field:
```typescript
export interface LeaveNoticeV1 {
  v: 1;
  from: string;
  replacements?: string[];
  timestamp: number;
  sig: string;  // NEW — base64url signature
}
```

**NeighborSnapshotV1** — `sig` field already exists (currently always `''`). No type change needed.

**RouteAndMaybeActV1** — `signature` field already exists (currently always `''`). No type change needed.

Note: The field names differ (`sig` vs `signature`) across message types. This is an existing convention. The signing module handles both by parameterizing the excluded field name.

### Signing integration points

#### Outbound signing (4 sites):

1. **`fret-service.ts:snapshot()`** (~line 847): After building the snapshot object, call `signMessage('fret.neighbors.v1', snap, this.privateKey)` and assign to `snap.sig`.

2. **`fret-service.ts:iterativeLookup()`** (~line 1290): After building the `msg` object, call `signMessage('fret.maybeAct.v1', msg, this.privateKey)` and assign to `msg.signature`.

3. **`fret-service.ts:sendLeaveToNeighbors()`** (~line 487): After building the `notice` object, sign and assign `notice.sig`.

4. **`fret-service.ts:routeAct()` forwarding** (~line 1010-1014): When forwarding a `RouteAndMaybeActV1`, the original sender's signature is preserved (the forwarder does NOT re-sign). This is correct — the signature authenticates the *originator*, not intermediate hops. Transport-layer identity verification (separate ticket) covers hop-by-hop authentication.

#### Inbound verification (3 sites):

1. **`neighbors.ts:registerNeighbors()` announce handler** (~line 34-44): After decoding the snapshot, verify `snap.sig` against `publicKeyFromPeerId(snap.from)`. Drop and log on failure.

2. **`maybe-act.ts:registerMaybeAct()`** (~line 16-27): After decoding, verify `msg.signature` against the originator. The originator is `msg.breadcrumbs[0]` (first breadcrumb = original sender). If no breadcrumbs, fall back to the `from` field if present, or drop. Drop and penalize on failure.

3. **`leave.ts:registerLeave()`** (~line 32-43): After decoding, verify `notice.sig` against `publicKeyFromPeerId(notice.from)`. Drop and log on failure.

The request handler in `registerNeighbors()` (the non-announce path, line 23-31) only *sends* a response — it doesn't receive a signed message, so no verification needed there.

#### Penalty on invalid signatures

When verification fails:
- Log at `warn` level with the peer ID and protocol
- Increment a new `diag.rejected.invalidSignature` counter
- Call `report({ peerId, type: 'bad', reason: 'invalid-signature' })` to update reputation
- Drop the message (do not process)

### Backward compatibility

During rollout, peers without signatures will send `sig: ''` / `signature: ''`. To avoid breaking the network during upgrade:

- **If the signature field is empty string**: Log at `debug` level and process normally. This allows mixed-version networks.
- **If the signature field is non-empty but invalid**: Drop and penalize. This catches actual forgery.
- A future follow-up ticket can add a config flag `requireSignatures: boolean` (default false) that, when true, rejects empty signatures.

### Test plan

**Unit tests (`test/sign.spec.ts`)**:
- `signable()` produces deterministic bytes for identical messages
- `signable()` produces different bytes for different messages
- `signable()` produces different bytes for different domains (cross-protocol replay prevention)
- `signable()` excludes the `sig` field from the canonical form
- `signable()` excludes the `signature` field from the canonical form
- `signMessage()` + `verifyMessage()` round-trip succeeds with Ed25519 key
- `verifyMessage()` fails with wrong key
- `verifyMessage()` fails with tampered message
- `verifyMessage()` fails with wrong domain
- `publicKeyFromPeerId()` extracts key from Ed25519 peer ID
- `publicKeyFromPeerId()` returns undefined for RSA peer ID (key not embedded)
- Canonical JSON is order-independent (keys inserted in different order produce same bytes)
- Nested objects have sorted keys

**Integration tests (`test/signature-integration.spec.ts`)**:
- Two connected FRET nodes exchange neighbor snapshots with valid signatures
- A FRET node drops a forged neighbor snapshot (signature from wrong key)
- A FRET node drops a forged maybeAct message
- A FRET node drops a forged leave notice
- A FRET node accepts messages with empty signatures (backward compat)
- `iterativeLookup()` produces signed messages that the receiver can verify
- Forwarded maybeAct messages preserve the original sender's signature

### TODO

Phase 1: Signing module
- [ ] Create `src/rpc/sign.ts` with `signable()`, `signMessage()`, `verifyMessage()`, `publicKeyFromPeerId()`
- [ ] Write unit tests in `test/sign.spec.ts` — run and pass

Phase 2: Wire format and config
- [ ] Add `sig: string` field to `LeaveNoticeV1` in `src/rpc/leave.ts`
- [ ] Add `privateKey?: PrivateKey` to `FretConfig` in `src/index.ts`
- [ ] Store private key ref in `FretService` constructor
- [ ] Thread private key through `Libp2pFretService` (extract from components or config)
- [ ] Add `diag.rejected.invalidSignature` counter

Phase 3: Outbound signing
- [ ] Sign snapshots in `fret-service.ts:snapshot()`
- [ ] Sign maybeAct messages in `fret-service.ts:iterativeLookup()`
- [ ] Sign leave notices in `fret-service.ts:sendLeaveToNeighbors()`

Phase 4: Inbound verification
- [ ] Verify in `neighbors.ts` announce handler — drop invalid, allow empty
- [ ] Verify in `maybe-act.ts` handler — drop invalid, allow empty
- [ ] Verify in `leave.ts` handler — drop invalid, allow empty
- [ ] Penalize peers with invalid signatures via `report()`

Phase 5: Integration tests and docs
- [ ] Write integration tests in `test/signature-integration.spec.ts` — run and pass
- [ ] Ensure existing tests still pass (backward compat with empty sigs)
- [ ] Update `docs/fret.md` "Not yet implemented" section to mark message signing as implemented
- [ ] Update `docs/fret.md` LeaveNoticeV1 wire format to include `sig` field
- [ ] Type-check passes (`npx tsc --noEmit`)
- [ ] Full test suite passes (`yarn test`)
