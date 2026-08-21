description: Added a test proving the service really detaches its four network event listeners from the libp2p node when it shuts down, and confirmed the test fails if that detach is broken.
files: packages/fret/test/service-lifecycle.spec.ts, packages/fret/src/service/fret-service.ts, docs/fret.md

## What shipped

One spec in `test/service-lifecycle.spec.ts` — `'detaches every listener it registered from the
real node on stop(), by handler identity'`. It wraps the node's own `addEventListener` /
`removeEventListener` before `start()`, records every `(type, handler)` pair passed to each, runs
`start()` then `stop()`, and asserts:

- the four event names FRET registers (`peer:connect`, `peer:disconnect`, `peer:identify`,
  `peer:update`) all appear among the recorded adds;
- every recorded add has a matching remove **with the same handler function object** (`===`).

Wrappers are restored in a `finally`, matching the `hangGhostDials` / `dials.restore()` convention
already in the file. No production code changed — `addNodeListener` / `removeNodeListeners`
(`fret-service.ts:1204-1215`) were already correct; this was a pure coverage gap.

Added in this review pass: a `NOTE:` tripwire above the spec body (see findings), and a `docs/fret.md`
sentence under *Service shell & lifecycle (A1)* recording that the detach half is now pinned by
handler identity and why counting the tracking array cannot substitute.

## Review findings

### Verification of the handoff's stated gap — closed

The implement handoff was explicit that the spec had never been run and should be treated as a draft.
That was the first thing done here:

- `npx tsc --noEmit` from `packages/fret`: **clean**. The `as unknown as LooseListenerFn` cast the
  implementer applied against libp2p's strict `keyof Libp2pEvents<ServiceMap>` overload compiles as
  written. The handoff's worry about needing `opts as never` did not materialise — `opts` is passed
  through the loose signature untyped and libp2p does not object at runtime.
- `test/service-lifecycle.spec.ts` standalone: **16 passing**, including the new spec.
- Full suite (`yarn test`): **1228 passing, 0 failing**. No pre-existing failures surfaced, so
  nothing was written to `tickets/.pre-existing-error.md`.

The handoff's three "reasoned about but not checked" items, each resolved:

- **Are the four event names the complete set?** Yes. `grep -n addNodeListener src/service/fret-service.ts`
  returns exactly four call sites — lines 1082, 1101, 1123, 1136 — matching the four names in
  `expectedTypes`. Taken from the code this pass, not from the ticket body.
- **Do libp2p internals also register node-level listeners during start/stop?** No. The
  "every add has a matching remove" loop asserts over *all* observed adds, so a stray internal
  registration would have failed the spec. It passed, so `added` contained only FRET's four.
- **Could an add/remove options mismatch let the real detach silently fail?** Not observed; the
  wrappers forward `opts` verbatim on both sides and no FRET call site passes any.

### Is the test load-bearing? — proven by mutation, not assumed

The ticket's whole claim is that identity matching catches a bug that name matching would not. That
was tested rather than taken on trust. `addNodeListener`'s detach closure was mutated to reconstruct
the handler —

```
this.nodeListeners.push(() => this.node.removeEventListener(type, ((evt) => handler(evt)) as typeof handler));
```

— which leaves the real listener attached to the node while emptying the tracking array. The spec
**failed**, as intended:

```
AssertionError: removeEventListener called with the same handler object for peer:connect:
expected false to equal true
```

The mutation was reverted; `git diff` on `src/service/fret-service.ts` is empty and the full suite was
run against the restored file. This also re-confirms the ticket's premise that no *other* lifecycle
spec catches it: under the mutation, only this spec failed.

### Minor findings — fixed in this pass

- **`docs/fret.md` was out of date on this behavior.** The A1 lifecycle bullet stated that `stop()`
  detaches node listeners but recorded nothing about how that is guaranteed, so the house convention
  of naming the pinning spec was unmet for the one behavior this ticket exists to pin. Added a
  sentence there stating the identity rule and why array-counting cannot substitute for it.

### Major findings — none

No architectural or correctness defect found. The production detach path is a closure capturing the
same `type` / `handler` the registration used, cleared wholesale in `removeNodeListeners`; there is no
reconstruction, no name-keyed lookup, and no path by which the array empties without the node call
being made. The diff is test-only and touches no shared helper, so there is no blast radius to assess.

### Conditional / speculative — recorded as a tripwire, not a ticket

Two fragilities in the new spec, both genuinely conditional ("fine now; only matters if X"), parked as
one `NOTE:` comment at the spec body in `test/service-lifecycle.spec.ts`:

- `expectedTypes` restates the four `addNodeListener` call sites. A fifth listener would still be
  leak-checked by the matching-remove loop, but its *absence* would go unnoticed by the presence half.
  Trips when a fifth call site lands.
- The matching-remove loop asserts over every add seen on the node, not only FRET's four. If a future
  libp2p version attaches a node-level listener of its own during `start()`, this spec fails on that
  rather than on a FRET leak. Trips on a libp2p upgrade that changes node-level listener behavior.

Neither is a latent defect — both are correct today and would announce themselves as a failing test
rather than as silent wrong behavior, which is why they are notes and not tickets.

### Considered-and-declined — none

No accepted-tradeoff `NOTE:` exists at any site this change touches, so nothing was left alone on
those grounds.

### Not covered, stated plainly

The spec proves the service *calls* `removeEventListener` with the right handler object; it does not
independently prove libp2p then honours that call. Asserting the stronger property behaviorally is not
possible through observable effects here, because every listener body opens with
`if (this.stopped) return;` — a leaked listener is inert, which is precisely why the leak was invisible
in the first place. Trusting `EventTarget.removeEventListener` to remove a listener it was handed by
identity is the one assumption left, and it is the platform's contract rather than FRET's.
