# Ticket board conventions

Workflow rules live in [tess/agent-rules/tickets.md](../tess/agent-rules/tickets.md) and are the
authority for stages, headers and transitions. This file records the two conventions that are
local to *this* repo's board.

## `backlog/` is flat — do not reintroduce sub-folders

The runner's ticket discovery is `readdir(stageDir)` filtered to `.md`
([tess/scripts/lib/tickets.mjs](../tess/scripts/lib/tickets.mjs)), so it never descends into a
sub-directory. A ticket in one is invisible both to `--stages backlog:<n>` and to the cross-stage
`prereq:` index — a `prereq:` naming it resolves as "not found", so the gate silently passes
instead of deferring the dependent.

Nineteen tickets sat in `backlog/impl/` and `backlog/plan/` in exactly that state until
2026-08-31, including a `prereq:` chain that could never have been enforced.

## Sequence bands encode the 1.0 release line

**Lower runs sooner**, as everywhere in tess. The bands only make the 1.0 cut readable at a glance:

| band | meaning |
|---|---|
| **1–9** | **Pre-1.0.** Must land before `v1.0.0` is tagged. |
| **10+** | **Post-1.0.** Additive; ships in a later minor. |

Within the post-1.0 range the decade is a theme, leaving gaps so work can be inserted without
renumbering:

- **10–19** reachability and operability — things real deployments have actually hit
- **20–29** adversarial hardening that is implementable today (prereq-chained; signatures first)
- **30–39** test, simulation and CI infrastructure
- **40–49** open design questions — no defensible default yet, closer to research than to work
- **50–59** documentation

**The pre-1.0 test is narrow, deliberately.** A ticket belongs in 1–9 only if landing it *after*
1.0 would be a breaking change or a broken promise:

- it changes what the public API or the wire format **accepts**, or
- it is documentation that currently claims behaviour the code does not have.

Everything else — however valuable — is additive and belongs after. A long pre-1.0 band means 1.0
never ships.

## Two things to check when renumbering

- `prereq:` names the **full slug including its kind prefix** (`feat-message-signatures`, not
  `message-signatures`).
- A prereq's sequence must be **≤** its dependent's, or the runner fails fast. This board carried
  such a conflict — `size-consensus` at sequence 3 declaring a prereq that sat at sequence 5 —
  which was latent only because the sub-folder hid both from the index.
