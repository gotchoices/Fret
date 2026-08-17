description: FRET's libp2p stream-open helper — and the release helper it must be paired with — are now reachable from the package root, so the downstream consumer can delete its three hand-copied versions.
files: packages/fret/src/index.ts, packages/fret/src/rpc/protocols.ts, packages/fret/test/package-exports.spec.ts, docs/fret.md, .release-notes.pending.md
----
## What shipped

`openRpcStream` and `releaseRpcStream` are re-exported from `packages/fret/src/index.ts` (the only
entry the package's `exports` map resolves), alongside the `Stream` type their signatures trade in.
`src/rpc/protocols.ts` bodies are unchanged — this is purely additive, no behavior change. Internal
call sites still import from `./rpc/protocols.js` directly, per the original non-goal.

Why both halves: an opened stream must be released, and the release rule — abort once the caller's
signal has fired, `close()` otherwise — is the half a consumer hand-rolls wrongly, because `close()`
against a stalled remote is unbounded. Exporting only the opener would have left the harder half
private, which is the same class of bug the export exists to retire.

Reachability is pinned by `test/package-exports.spec.ts` (4 cases): the `exports` map has exactly
one key (`.`) whose `types`/`import` — and the legacy `main`/`types` fields — all name the root
entry; `tsconfig`'s `outDir`/`rootDir`/`declaration` are what map `src/index.ts` onto that emitted
file; the root entry's runtime surface carries `openRpcStream`, `releaseRpcStream`, `readAllBounded`;
and a type-level assignment proves `Stream` is nameable from the root. The spec deliberately does
*not* self-name-import `p2p-fret`, since that resolves through the gitignored `dist/` and root
`check` type-checks before it builds — a fresh clone would fail typecheck.

Docs: `docs/fret.md` *Dialability* now states that the seam is public, why the two functions are
exported together, and the `negotiateFully: false` caveat. `.release-notes.pending.md`'s "Added"
bullet was extended to cover `releaseRpcStream`, `Stream`, and that caveat.

## Verification

- `npx tsc --noEmit` (from `packages/fret/`) — clean.
- `yarn build` — clean.
- `yarn test` — **822 passing, 0 failing** (log: `tickets/.logs/1-export-openrpcstream.review.test.log`).
  Includes the 4 `package public surface` cases.
- No lint step exists in this repo (`yarn format`/`format:check` are unusable against the house tab
  style — documented in `AGENTS.md`); `yarn check` is the gate and its three legs all pass.

## Review findings

**Checked:** the plan-stage code diff (`3065149`) with fresh eyes before the handoff text; the
implement-stage commit (`6abef5a`); `openRpcStream` / `releaseRpcStream` bodies and their doc
comments; `package.json` `exports` / `main` / `types` / dependency classification; `tsconfig`
emit mapping; the new spec's assertions; the actual downstream consumer
(`../optimystic/packages/db-p2p/src/cohort-topic/stream-util.ts`,
`libp2p-key-network.ts`, `libp2p-node-base.ts`) to confirm the export unblocks its fix; `docs/fret.md`
for every claim the change touches; and whether `src/` started importing through the barrel.

**Major — none filed.** The change is one additive export line; nothing rose to a class of defect
worth a ticket, and nothing needed the architecture ladder.

**Minor — fixed in this pass:**

- *Half a seam was exported.* `releaseRpcStream` stayed private while `openRpcStream` went public.
  Confirmed non-theoretical: the downstream `stream-util.ts` hand-rolls `try { await stream.close() }`
  in a `finally` for both `requestResponse` and `sendOneWay` — exactly the unbounded-close-against-a-
  stalled-remote shape `releaseRpcStream` exists to prevent. Fixed by exporting it alongside, with a
  comment at the export site stating why the two travel together.
- *A consumer-visible behavior caveat was undocumented.* `openRpcStream` hardcodes
  `negotiateFully: false`; downstream's own copy deliberately omits that flag, documenting that it
  defers an unsupported-protocol failure from stream-open to the first read, which turns its
  fire-and-forget `sendOneWay` into a silent no-op against a peer lacking the protocol. A consumer
  migrating to the exported helper inherits that change with no warning. Fixed by stating it in
  `openRpcStream`'s doc comment, in `docs/fret.md`, and in the release note. Not made configurable:
  every FRET sender reads a reply so the deferred failure always surfaces, and a knob to weaken the
  seam is a wider commitment than this ticket earns.
- *The test asserted a mapping it did not verify.* It claimed `src/index.ts` is what `./dist/src/index.js`
  resolves to, but only read `package.json`; an `outDir`/`rootDir` change would silently repoint the
  exports map at a file that is never emitted, and the spec would still pass. Added the `tsconfig`
  assertions plus the `main`/`types` consistency check (a pre-`exports` resolver reads those, so a
  mismatch makes the surface resolver-dependent), and a type-level check that `Stream` is nameable
  from the root — the plan asked for a type-level check and the implement pass shipped only a
  runtime `typeof` one.
- *Two handoff claims were inaccurate and are corrected here, not carried forward.* (a) "`Stream`
  had to be re-exported or a consumer could not name the return type" — `@libp2p/interface` is a
  **peerDependency**, so the consumer necessarily has it installed and could always import `Stream`
  itself. The re-export is convenience, and it is kept (harmless, structurally identical type, one
  fewer import for the consumer) but its justification is convenience, not necessity. (b) "no
  `from '../index'` import inside `src/`" — there are five (`rpc/maybe-act.ts`, `rpc/neighbors.ts`,
  `rpc/ping.ts`, `service/fret-service.ts`, `service/libp2p-fret-service.ts`). All are pre-existing
  `import type` of wire interfaces, so they create no runtime cycle and nothing about this change
  made them worse — but the claim as written is false and a future reader should not trust it.

**Tripwires (recorded, not ticketed):** none new. The `negotiateFully` caveat above is a stated
contract at the code site rather than a conditional concern, so it is documented as behavior, not
tagged as a tripwire.

**Considered and declined:**

- *Exporting `isLimitedConnection` and `RPC_TIMEOUT_MS` too.* Both are reachable arguments for a
  consumer, but neither is needed to use the seam correctly, and each is a further API commitment
  with no named consumer. Left private.
- *Loosening the spec's exact-path assertions* (`'./dist/src/index.d.ts'` etc.) to something less
  brittle. The brittleness is the point: those literals are the contract a consumer resolves
  through, and a change to them should require a deliberate test edit.

**Out of scope, flagged not touched:** the implement-stage commit `6abef5a` also carries edits to
`test/fret.mesh.spec.ts`, `test/iterative-lookup.spec.ts`, `test/profile.behavior.spec.ts` and a new
`tickets/backlog/5.1-lookup-profile-test-assertions.md` — concurrent board/ticket activity swept into
this ticket's commit, unrelated to this diff. Left alone deliberately (the working tree is not this
ticket's to sanitize). Downstream's three copies remain optimystic's ticket
(`debt-shared-limited-connection-dial-options`), now unblocked once FRET releases.
