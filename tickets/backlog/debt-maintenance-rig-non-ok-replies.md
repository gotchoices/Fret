description: The test harness for background maintenance can only make a fake peer reply "yes" or go silent, so the case where a peer answers "I am too busy right now" is never tested even though the code treats that answer specially.
files: packages/fret/test/helpers/maintenance-rig.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/test/failure-recovery.spec.ts, docs/fret.md
difficulty: medium
tradeoffs: The busy path is short and reads correctly, so a maintainer may judge that widening a shared test harness costs more than it buys — until a real overloaded peer exercises it in production.
---

## What is missing

A peer under load can answer a maintenance ping with `busy` instead of `ok`. FRET treats that
answer as its own case, distinct from both a good reply and a failure, and the distinction is
load-bearing in four ways at once:

- it **is** an answer on this network's namespaced protocol, so it confirms the peer is a member
  and clears any run of contact failures;
- it records probe backoff for the peer;
- it records **no** relevance decay and **no** contact strike;
- because the peer answered, `probeAndFetch` goes on to fetch its neighbor snapshot.

None of those four is asserted anywhere. Verified by reading the suite, not inferred: the string
`busy` does not appear in `packages/fret/test/failure-recovery.spec.ts` at all, and the only
occurrence in `packages/fret/test/dead-state.spec.ts` is in a prose comment. The design document
claimed this arm was pinned by `failure-recovery.spec.ts`; that claim was corrected in the same
review pass that filed this ticket.

## Root cause — one site, and it is the harness, not the assertions

`packages/fret/test/helpers/maintenance-rig.ts` is the shared harness for every pooled maintenance
path (the stabilization tick and both connection warm-up passes). Its per-peer behavior type is
exactly two values, `'answers' | 'hangs'`, and its reply builder emits a hard-coded `{ok: true}`
for a ping and an empty snapshot for a neighbors fetch. So **no** maintenance-path spec can express
a peer that replies anything other than "yes" — this is a property of the harness, not an oversight
in any one test file.

That is why this is filed as one ticket about the harness rather than as a point ticket about the
busy arm. Widening the harness retires a whole class of untestable arms at once, not just this one:

- a ping answered `busy` (the case above);
- a ping answered `ok: false` — keeps its relevance decay, still counts as membership evidence;
- a reply whose bytes will not decode — proof of life, relevance decay only, never a contact
  strike.

All three share the same shape: *the peer answered, but not well*, and all three are currently
unreachable from a maintenance test for the same single reason.

## Expected behavior once the harness can express it

A near peer answering `busy` on its maintenance ping should, in one tick:

- be confirmed a member and have any contact-failure run cleared;
- gain a backoff record;
- gain no contact strike and no relevance decay;
- still have its neighbor snapshot fetched.

## Related

`tickets/backlog/debt-backoff-map-test-surface` proposes extracting the probe-backoff bookkeeping
into its own class and names this same `busy` arm among the call sites that would delegate to it.
That ticket is about the *arithmetic* of backoff being hard to unit-test; this one is about the
*arm* being unreachable from an integration test. They touch different files and neither blocks the
other, but whoever takes the second should read the first.

`tickets/backlog/debt-fetch-snapshot-failure-arms-untested` lists the same kind of gap one RPC
later — the arms of the neighbor-snapshot *fetch* rather than of the ping that precedes it. It is a
separate site with separate arms, so it stays a separate ticket, but it is blocked by the same
harness limitation described above: widening the harness is what makes both writable. Whoever picks
up either should do the harness change once and then satisfy both.
