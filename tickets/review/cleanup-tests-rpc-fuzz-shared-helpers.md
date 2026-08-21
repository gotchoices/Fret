description: Moved the small test fixtures shared by two upcoming test files into one shared helper file, so the file split that follows can be a pure move with no test behavior change.
files: packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/helpers/rpc-fuzz.ts
----
Third agent run on this ticket (two prior runs interrupted by budget). The fixture move itself
(new `test/helpers/rpc-fuzz.ts`, updated imports in `rpc.handler-fuzz.spec.ts`) had already landed
in commits `c820360` / `2c10db7` from a prior run. This run picked up from the `<!-- resume-note -->`
left in the implement ticket, found the working tree already clean/committed (no uncommitted
edits — the note's claim of a dirty tree was stale), and re-verified from scratch rather than
trusting the note.

## What was actually wrong (the note misdiagnosed this)

The resume-note's "10 Import declaration conflicts" and "InboundStubOpts unused" worries were
stale/transient, as the note itself suspected. But the note never ran the test file, only
live-diagnostics — and running it surfaced a real bug the diagnostics never caught:

`rpc.handler-fuzz.spec.ts` imported `InboundHandler`, `InboundStub`, `InboundStubOpts` as
**value** imports from `./helpers/rpc-fuzz.js`, but all three are `export type`/`export interface`
in the helper (type-only, no runtime value). `npx tsc --noEmit` is silent about this — it's valid
TS. But this repo runs tests via Node's experimental type-stripping loader (`register.mjs`), which
strips type syntax **per file** and does not resolve whether an imported name is type-only across
module boundaries. A plain `import { InboundHandler, ... }` therefore survives stripping as a
runtime import specifier, and loading the compiled helper module — which exports no such runtime
binding — threw at import time:

```
SyntaxError: The requested module './helpers/rpc-fuzz.js' does not provide an export named 'InboundHandler'
```

This is a real gap in the "does `tsc --noEmit` catch it" assumption baked into this codebase's
"TS execution: `--import ./register.mjs` loader hook" setup (AGENTS.md) — type-only cross-file
imports must be marked `import type` (or `type` per-specifier) or the test file fails to load at
runtime with a clean typecheck. Worth a tripwire if this bites again elsewhere in the test suite;
not filed as a ticket here since it's a one-off in this file, not a pattern found more than once.

## Fix applied

`rpc.handler-fuzz.spec.ts` top-of-file import block: marked `InboundHandler` and `InboundStub` as
`type InboundHandler` / `type InboundStub` inline in the named-import list. `InboundStubOpts` was
dropped from the import entirely — grepped the spec file, it has zero uses outside the import
line; it's only referenced inside the helper's own `inboundStub()` signature.

## Verification performed

- `cd packages/fret && npx tsc --noEmit` — clean, no output.
- `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.handler-fuzz.spec.ts" --timeout 30000` — **181 passing**, 0 failing, run twice (before and after dropping the unused `InboundStubOpts` import), identical result both times.
- One remaining live-diagnostic-only item, confirmed benign: `'await' has no effect on the type of this expression. [80007]` at the `sendFramed(stream, await encodeJson(...))` call inside the "bounds a real handler's success-path close..." test body (an existing test that stayed in the spec file, untouched by this ticket's fixture move). `[80007]` is a TS **suggestion**-tier diagnostic, not an error; `npx tsc --noEmit` — the actual build gate per AGENTS.md — reports nothing for it. Not touched; it predates this ticket and isn't part of the fixture move's scope.

## Known gap — not run this pass

**`cd packages/fret && yarn test` (the full suite) was not run** — this run hit a token budget
warning right after landing the fix above and getting the single-file result clean, and stopped
per the ticket workflow's budget-warning rule rather than continuing. The single spec file this
ticket touches is fully green and type-checks clean, which is the surface this ticket's diff
actually changes, but the reviewer (or a follow-up check before `21.42-cleanup-tests-rpc-fuzz-split-blocks`
starts) should run the full suite once to confirm nothing else regressed:

```
cd packages/fret && yarn test
```

`21.42-cleanup-tests-rpc-fuzz-split-blocks` (the tier-extraction ticket that does the actual file
split) has `prereq: cleanup-tests-rpc-fuzz-shared-helpers` and should not start until that full-suite
run is confirmed green — the prereq system will gate it on this ticket reaching `complete/`, but the
full-suite gap above means "landed" here means "single file verified," not "whole suite verified."

## Design/scope notes (unchanged from the original ticket, still accurate)

`test/helpers/rpc-fuzz.ts` now exports the fixtures shared by the tier that stays in
`rpc.handler-fuzz.spec.ts` and the two tiers `21.42` is about to extract: `NETWORK`, `P`,
`peerIdStr`, `sampleCoord`, `wrongWidthCoord`, `PEER_CLAIMED`, `PEER_ACTUAL`, `sleep`, `waitUntil`,
`seq` (mutable, `export let`), `baseMsg`, `withoutKey`, `InboundStub`/`InboundStubOpts`/`inboundStub`,
`InboundHandler`, `framed`, `json`. `enc`/`dec` were deliberately **not** moved — the helper has its
own local `enc` (needed by `baseMsg`/`framed`); the spec file keeps its own `enc`/`dec` for its
unit-tier-only code (`fakeNode()`, `decodeFramed()`, and the `sendFramed(stream, await
encodeJson(...))` test body noted above, which still uses the spec's own `enc`/`dec` indirectly
through `encodeJson`/`decodeJson`). No test was added, changed, or deleted — this was a pure fixture
relocation, as the original ticket required.

## Review findings

- Type-only cross-file imports (`InboundHandler`, `InboundStub`, `InboundStubOpts`) were imported
  as values, which type-checks fine under `tsc --noEmit` but fails at runtime under this repo's
  Node type-stripping test loader. Fixed by marking them `type` in the import list / dropping the
  unused one. Not filed as a broader debt ticket — single occurrence, caught and fixed inline; flag
  here in case the pattern recurs elsewhere in the test suite during future fixture moves.
  See "What was actually wrong" above for the diagnosis and "Fix applied" for the change.
- Full-suite `yarn test` not run this pass (budget-warning cutoff) — see "Known gap" above. Reviewer
  should run it before `21.42-cleanup-tests-rpc-fuzz-split-blocks` proceeds.
