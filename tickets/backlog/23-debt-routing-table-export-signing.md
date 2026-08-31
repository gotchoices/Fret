description: A saved routing-table file carries no proof it was written by this node and has not been altered since. Sign it on save and check the signature on load.
prereq: feat-message-signatures
files:
  - packages/fret/src/service/fret-service.ts (`exportTable` / `importTable`)
  - packages/fret/src/rpc/sign.ts (new, from the message-signing ticket — same key infrastructure)
  - docs/fret.md (*Routing table persistence*)
tradeoffs: The exported table is written and read by the host application itself, so the threat needs an attacker who can already write that application's storage — arguably outside FRET's trust boundary and better solved once, at the storage layer, for every file the application keeps rather than specially for this one.
----

# Integrity protection for `exportTable` / `importTable`

Split from the original `routing-table-export-integrity` ticket. The other half — re-deriving each
imported entry's ring coordinate from its peer id — **does not depend on any of this** and is
scheduled pre-1.0 as `4-debt-import-table-coordinate-verification`. Read that one first; if it has
landed, the "fabricated peer entries with chosen coordinates" arm below is already closed and what
remains here is the rest.

## What is unprotected

`exportTable` / `importTable` produce and consume JSON with no integrity protection. Where that
JSON is stored on disk or moved between machines, it can be altered:

- relevance scores raised to promote attacker-chosen peers (relevance drives both next-hop
  preference and eviction, so this shapes routing and decides who gets evicted under capacity),
- health counters rewritten to make a failing peer look reliable,
- entries added or removed wholesale.

Coordinates are covered by the pre-1.0 ticket. Everything else in `SerializedPeerEntry` is not
derivable from anything and can only be protected by an integrity check over the file.

Note two fields are already defended by construction and should stay that way: `state` is forced
to `disconnected` on import and both failure counters are reset to zero, so handshake and liveness
history cannot be smuggled in. `importTable` also drops any record claiming to be self.

## Expected behaviour

1. `exportTable` signs the serialized table with the local peer's key, over a canonical encoding of
   the full content.
2. `importTable` verifies before processing, and rejects an invalid signature. **Whether a
   *missing* signature is rejected is the real decision** — rejecting it breaks every table saved by
   an earlier version, so this likely needs the same staged rollout the message-signing ticket uses
   (accept unsigned, warn, then require behind a flag).
3. Distinguish a self-exported table from one obtained elsewhere. Today the API cannot tell them
   apart, and they do not warrant the same trust.

## Threat reference

`docs/threat-analysis.md` §5.5 (Medium) — serialized routing table tampering.

## TODO

- [ ] Canonical encoding for the signed payload — must round-trip identically, so settle it against
      the codec rules in `docs/fret.md` (*Wire formats*): `-0`, non-finite numbers and `undefined`
      own-properties do not survive JSON, and a signature over a form that does not round-trip will
      fail to verify against its own output
- [ ] Sign on export, verify on import
- [ ] Decide the missing-signature policy and the migration path for tables written before this
- [ ] Distinguish self-exported from foreign-supplied tables in the API
- [ ] Confirm the interaction with `4-debt-import-table-coordinate-verification`: two independent
      reject paths over the same input should agree on all-or-nothing semantics
