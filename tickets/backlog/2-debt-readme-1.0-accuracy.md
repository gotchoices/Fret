description: The project's front-page README tells readers to run two commands that either do not exist or that the project's own guidance says never to run, and it says nothing about what the library does and does not protect against — which is the first thing someone evaluating a 1.0 networking library needs to know.
files:
  - README.md (*Development* block ~136-150; needs a new security section; *Documentation* ~169)
  - packages/fret/README.md (check for the same claims before fixing only one)
  - AGENTS.md (the source of truth for the build/test commands)
  - docs/fret.md (*Security and abuse considerations* — what the new section should summarise and link to)
  - docs/threat-analysis.md, docs/threat-rir-mitigated.md
difficulty: easy
tradeoffs: Documentation-only, so it is easy to keep deferring behind code work; the argument for doing it before 1.0 is that a published package's README is the one file every evaluator reads and the only one most of them read, and a wrong command in it costs a newcomer their first ten minutes.
----

# The front-page README is wrong in two ways, and silent in a third

## Wrong: two commands in the *Development* block

```bash
# Lint
yarn lint

# Format
yarn format
```

- **`yarn lint` does not exist.** The root `package.json` defines `clean build build:parallel test
  format format:check typecheck check bump pub pub:fret gh-release release` — there is no `lint`
  script and no lint step anywhere. Running it fails.
- **`yarn format` exists and must not be run.** `AGENTS.md` is explicit: there is no prettier
  config, so it applies prettier's space-indent defaults and rewrites every source file against the
  house tab style. `yarn format:check` fails on all 21 source files for the same reason — known,
  and not a regression. So the README's own *Development* section tells a new contributor to
  reformat the entire codebase as step three.

What the block should say instead is what actually gates a change: `yarn check` from the repo root
(typecheck → build → test). Worth stating that it is a **root** script — running it from
`packages/fret` fails with "Couldn't find a script named check", which looks like a clean exit if
only the tail of the output is read.

Check `packages/fret/README.md` for the same two claims before fixing only the root one.

## Silent: no statement of security posture

For a 1.0 of a peer-to-peer routing overlay this is the gap that matters. `docs/fret.md` carries an
honest *Security and abuse considerations* section split into "Current state" and "Not yet
implemented", and there are two threat documents beside it — but nothing in the README says any of
it, so the reader most likely to need it is the one least likely to find it.

The section does not need to be long. It needs to say plainly what the reader is adopting:

- **What is in place** — every RPC namespaced per network so a foreign network cannot negotiate;
  transport-authenticated sender identity checked on every message carrying a `from`; global
  per-protocol rate limits; inbound concurrency caps; bounded routing table with relevance
  eviction; correlation-id and phase dedup with replay bounds; caps on every inbound list and
  message size.
- **What is not** — messages are not cryptographically signed, so the guarantee is exactly what the
  transport gives (libp2p noise): a peer cannot forge *another peer's identity*, but a peer can lie
  about *third parties*. FRET is built to expect that — hearsay creates an unscored `unknown` entry
  and is vetted by a probe before it reaches any ring view — but it should be stated, not inferred.
  Also absent: per-peer rate limiting, admission control, Sybil resistance, eclipse mitigation,
  cohort diversity, payload encryption.
- **The one-line consequence** — the honest framing is that 1.0 targets deployments where the
  transport is authenticated and peers are semi-trusted, and that adversarial hardening is the
  post-1.0 roadmap. Link the backlog band rather than restating it.

Whoever picks this up should re-read `docs/fret.md`'s security section rather than copying the
bullets above; that document moves, and this ticket is a snapshot of it.

## TODO

- [ ] Replace the *Development* block with the commands that actually exist, leading with the
      root-only `yarn check`
- [ ] Delete the `yarn lint` entry; either delete `yarn format` or annotate it with the AGENTS.md
      warning rather than presenting it as a normal step
- [ ] Check `packages/fret/README.md` for the same claims
- [ ] Add a short *Security posture* section, honest about both halves, linking `docs/fret.md` and
      the two threat documents
- [ ] Confirm no other README claim has drifted — the *Project Structure* tree and the *Protocols*
      list are both worth a read against the current tree
