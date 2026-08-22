description: A test file was added that checks the network code handles peers replying "I'm busy" or with garbage. It was reviewed, two small gaps in the test were fixed, one documentation sentence was added, and a wider check confirmed no other test files fall into a related trap.
files: packages/fret/test/maintenance-nonok-replies.spec.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
---

## What landed

The implement stage added `packages/fret/test/maintenance-nonok-replies.spec.ts` (197 lines, four
cases) in commit `1b85381` — **test-only**, no production source changed. It drives the maintenance
rig so a peer answers the stabilization tick *badly* rather than not at all, and pins what the
service scores in each case:

- **Case 1 — `busy` ping.** `pingsSent` and `pingsFail` both increment, `ProbeBackoff.record` runs
  (backoff factor becomes non-zero), and there is no relevance decay and no contact strike. The peer
  stays a confirmed member, because a `busy` reply still arrived over this network's namespaced
  protocol.
- **Case 2 — `ok: false` ping.** Relevance decays, no backoff, no strike.
- **Case 3 — undecodable-but-complete reply frame.** Membership confirmed, relevance decays, no
  strike, and (added in review) `pingsOk` unchanged.
- **Case 4 — composition.** One peer answers `busy` on the ping half while its snapshot fetch
  answers badly, observed through a single `stabilizeOnce`: the ping half scores, the fetch half
  stays silent.

The `Behavior` widening in `test/helpers/maintenance-rig.ts` that makes those replies expressible
(`busy` / `not-ok` / `undecodable`, per-(peer, protocol) overrides) landed earlier on this branch in
`9b7c410` under a different ticket, so it was context here rather than work under review.

## Review findings

### Checked against the production code — all confirmed correct, nothing changed

- **Case 1's `busy` arm matches `probeNeighborLatency` exactly** (`fret-service.ts` ~2428–2480): the
  `busy` case increments `pingsSent` and `pingsFail`, calls `noteAnsweredOnProtocol(id)` and
  `this.backoff.record(id)`, and takes no decay and no strike. All five of the spec's case-1
  assertions hold.
- **Case 3's `decode-error` scoring is correct.** `noteRpcFailure`'s `decode-error` arm calls
  `noteAnsweredOnProtocol(id)` then `applyFailure(id)` — membership signal, proof of life, relevance
  decay, no contact strike. The spec's claims match.
- **The backoff assertions are meaningful, not coincidental.** `ProbeBackoff.factor()` returns `0`
  for a peer with no entry (`packages/fret/src/service/probe-backoff.ts:160` —
  `this.entries.get(id)?.factor ?? 0`), so the two `=== 0` assertions on the decay arms really
  discriminate, and the `> 0` on the busy arm is a real signal rather than an artifact.
- **The shared per-peer ordering assertions match `probeAndFetch`** — `wasCancelled` sits ahead of
  the `answered` gate, and the fetch is skipped for a ping that did not answer.

### Fixed inline (minor)

Both in `packages/fret/test/maintenance-nonok-replies.spec.ts`:

- `expectAnsweredNotStruck`'s membership assertion claimed more than the case could exercise. Its
  message was `'an answer on our protocol confirms membership'`, but the near pass draws its targets
  from the live-member-gated ring view, so a peer seeded `unknown` is never selected and the
  promotion path is not reachable from this spec. Reworded to
  `'an answer does not demote a confirmed member'` — what is actually pinned — with a comment saying
  why the stronger claim is not exercisable here.
- Case 3 (`undecodable`) was missing the `p.ok - p0.ok === 0` assertion that cases 1 and 2 both
  carried. Added, restoring symmetry across the three ping arms.

### Kept against the implementer's own suggestion

The handoff invited deleting case 4 as redundant with `test/fetch-snapshot-failure-arms.spec.ts`.
**Declined.** That spec's cases are `skipped`, `decode-error`, `ok`, `foreign-protocol`,
`unreachable` and `timeout`, each driven by calling `fetchAndMergeSnapshot` directly against its own
connection stub. It has no `busy` arm at all, and it never runs a whole tick. Case 4 pins the
composition — the ping half scoring while the fetch half stays silent, both observed through one
`stabilizeOnce` — which nothing else covers.

### Tripwire recorded, not filed as a ticket

`getDiagnostics()` returns the live `diag` object rather than a copy
(`packages/fret/src/service/fret-service.ts:511`). Any spec that captures that result **as an
object** and subtracts a later read from it therefore sees zero for every field and passes without
asserting anything. The spec under review avoids the trap by reading scalars, and its file header
says so — but that is a class-level concern parked in one spec's header, which is the wrong home.

Audited every `getDiagnostics()` caller under `packages/fret/test/`. **No spec falls into it**: the
three sites that hold the result across a diff are all safe —
`libp2p-memory.integration.spec.ts:305` spreads a copy, `payload-bounds-ttl.spec.ts:215` extracts
the counter as a number at capture time, and `network.isolation.spec.ts:37` reads scalars with no
later comparison. Every other caller reads a scalar directly off the call.

So this is conditional, not a live defect, and it is parked as a `NOTE:` at the `getDiagnostics`
site alongside the existing shallow-`Readonly` note. The disposition it records: the
types/representation fix (return a frozen shallow copy, making the bad idiom unrepresentable) is a
production change with a per-call allocation cost and no defect to justify it today; the stated
revisit condition is a spec ever being found taking a diff against an uncopied handle.

### Documentation

`docs/fret.md` was checked against every claim this change touches.

- Line 79's two forward references to `test/maintenance-nonok-replies.spec.ts` name the file that
  actually landed, and the `busy` arm is described there accurately against the production code
  (`pingsSent` + `pingsFail`, no relevance decay, no strike, membership confirmed,
  `ProbeBackoff.record`). No change needed.
- The `fetchAndMergeSnapshot` silent-arm sentence named neither spec that pins it. Added one
  sentence naming both and saying what each covers — `fetch-snapshot-failure-arms.spec.ts` drives the
  method directly per outcome, `maintenance-nonok-replies.spec.ts` pins the whole-tick composition.

### Empty categories, with reasons

- **No major findings, so no new `fix/`, `plan/` or `backlog/` tickets were filed.** The change is
  test-only and every assertion in it was verified against the production code it claims to pin; the
  one class-level concern found (above) has no live instance, so per the disposition rules it is a
  tripwire rather than a ticket.
- **No accepted-tradeoff `NOTE:`s were overridden.** The one `NOTE:` at a site this review touched is
  the shallow-`Readonly` note at `getDiagnostics`; its subject is adjacent to but distinct from the
  finding above, and nothing was re-filed against it.
- **No pre-existing test failures**, so no `tickets/.pre-existing-error.md` was written — the full
  suite ran clean (below).

### Gaps left open deliberately

The implementer's stated narrowings are the honest floor for a test-only spec and are **not**
re-filed as tickets: the coarse backoff assertion (deferred to the already-open
`debt-backoff-map-test-surface`), core profile only, one peer per case, no negative-pong arm on the
fetch side, and no comparative "a bad answer scores lower than a good one" case. Each is a
documented narrowing rather than a defect.

## Validation

- `cd packages/fret && npx tsc --noEmit` → clean, at `bb31cfe`.
- `cd packages/fret && yarn test` → **1264 passing, 0 failing** (~9 min), same SHA.
- After the two spec fixes: `node --import ./register.mjs node_modules/mocha/bin/mocha.js
  "test/maintenance-nonok-replies.spec.ts" --timeout 30000` → **4 passing**.
- There is no lint step; `yarn check` is the gate, and `yarn format` / `yarn format:check` must not
  be run (AGENTS.md).

**The full suite was not re-run after the final two edits, and this is stated rather than glossed.**
Those edits are a `//` comment block in `fret-service.ts` and a prose sentence in `docs/fret.md` —
neither is executable, so neither can change a test outcome. The run was skipped because this ticket
hit its token budget ceiling; the banked 1264-passing run plus the 4-passing spec run stands as the
evidence. A reviewer wanting belt-and-braces should run `cd packages/fret && npx tsc --noEmit`, which
is the only gate a comment block could conceivably trip.
