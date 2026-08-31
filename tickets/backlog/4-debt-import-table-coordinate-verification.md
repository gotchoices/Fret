description: Restoring a saved routing table from disk trusts the ring position recorded for each peer instead of recomputing it. A file that has been altered can therefore place peers at wrong positions on the ring, which quietly corrupts every ordered lookup that follows.
files:
  - packages/fret/src/service/fret-service.ts (`importTable` / `importEntries`)
  - packages/fret/src/ring/hash.ts (`hashPeerId` — the derivation to check against)
  - packages/fret/src/store/digitree-store.ts (`assertCoordWidth` at the write seam — the existing, weaker guard)
  - packages/fret/test/per-tick-hotpath.spec.ts (already pins that a wrong coordinate survives a maintenance tick)
  - docs/fret.md (*Routing table persistence*)
difficulty: easy
tradeoffs: The threat needs an attacker who can already write the host application's own storage, which a maintainer may reasonably place outside FRET's trust boundary and leave to the storage layer. The counter-argument is that this is public API accepting outside input, and adding the check after 1.0 turns imports that used to succeed into failures — a breaking change — so it is materially cheaper to decide before 1.0 than after.
----

# `importTable` trusts the coordinate in the file

## Why this is pre-1.0 and not later

A peer's ring coordinate is `SHA-256(peerId)` — fully derivable from a field the same record
already carries. Nothing has to be trusted here, yet `importTable` reads `coord` off the snapshot
and stores it.

The reason to settle it before 1.0 is not severity, it is **compatibility**. Adding the check
later changes what the public API accepts: a table that imported cleanly under 1.0 would start
being rejected. That is a breaking change to a documented entry point, so it is cheap now and
expensive after.

## What is actually unguarded

The store's write seam already enforces coordinate **width** (`assertCoordWidth`, exactly 32
bytes), and the decoders reject a malformed encoding. Neither checks that the coordinate is the
*right* one for the id beside it. A well-formed 32-byte coordinate belonging to a different peer
passes every existing guard.

Because the tree key is `hex(coord)|id`, a wrong-but-well-formed coordinate sorts the entry into
an arbitrary ring position. Every ordered read then silently returns the wrong peers — neighbour
windows, cohorts, routing candidates, the size estimate — with no error anywhere. This is the same
failure mode `assertCoordWidth` exists to prevent, reached by the one route that guard does not
cover.

## Nothing else repairs it any more

Until `16-per-tick-hotpath` (complete), the maintenance loop rehashed every peer's coordinate each
cycle and wrote it back, which *incidentally* repaired a tampered coordinate for any peer libp2p's
peer store also knew about. That repair is gone by design — it was partial, owned by nobody, and
paid for by every node on every cycle — and its removal is deliberately pinned by
`test/per-tick-hotpath.spec.ts`, which asserts a wrong coordinate now survives a tick.

So this check is the only place a wrong coordinate from a restored snapshot would ever be caught.
(The ticket this was split from referred to that assertion as still queued in a
`16.1-per-tick-hotpath-tests` ticket; it was in fact folded into the spec above and that ticket
never existed.)

## Shape of the fix

Re-derive each imported record's coordinate from its `id` and compare. The interesting decision is
the failure mode, and `importTable` already has a precedent to follow: a malformed coordinate
**rejects the whole snapshot before anything is written**, because a corrupt persisted table is
better refused loudly than admitted as ring state, and a mid-loop throw would leave a
half-imported table behind *and* skip the capacity enforcement that runs after. A mismatch is the
same kind of evidence about the same file, so all-or-nothing is the consistent choice — but say so
in the ticket's resolution rather than leaving it implied, since the alternative (skip the bad
record, import the rest) is defensible for a partially-corrupt file and is what the *wire* snapshot
merge paths do.

Note the asymmetry is already established and intentional: wire-borne sample entries skip-and-log
per entry, because one bad entry from a peer should not cost the whole message; a persisted table
is refused whole. Whichever way this lands, it should not disturb that.

## Out of scope — split to `23-debt-routing-table-export-signing`

Signing or HMAC-ing the export, and verifying that signature on import, is the other half of the
ticket this was split from. It depends on the message-signing key infrastructure and is post-1.0.
This ticket needs none of it: the coordinate is self-verifying from data the record already holds.

## TODO

- [ ] Re-derive `coord` from `id` for every imported record and compare against the stored value
- [ ] Decide and document the failure mode — reject the whole snapshot (consistent with the
      existing malformed-coordinate rule) vs skip the record
- [ ] Test both a tampered coordinate and a coordinate belonging to a *different* real peer, since
      the latter passes width and decode checks
- [ ] Confirm the check runs before anything is written, so a rejected import leaves no partial state
- [ ] Update *Routing table persistence* in `docs/fret.md` — it currently records coordinate
      verification for other peers' records as "a separate, still-open concern"
