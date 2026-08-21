description: The libp2p wrapper around the core networking service forwards every call by hand, and nothing checks that those calls actually arrive with the right arguments in the right order — a swapped pair of numbers would go unnoticed.
files: packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/libp2p-service-node-source.spec.ts, packages/fret/test/libp2p-facade-forwarding.spec.ts (new)
difficulty: easy
---

<!-- resume-note -->
Third run in a row stopped on BUDGET_WARNING. This run got further than the prior two: it
re-confirmed the source is unchanged (same as before — zero drift), then went on to work out the
exact mechanics the Design section below left implicit — arities, sync-vs-async-vs-throw
classification per method, and the accessor-invocation trap — and wrote the **complete, ready-to-
paste file content** below. Nothing is left to design. The next run should create
`test/libp2p-facade-forwarding.spec.ts` with exactly the content in the fenced block below (no
re-reading of `libp2p-fret-service.ts`, no re-deriving arities), then run the two verification
commands at the bottom of this note. If it still passes only for lack of a spare cycle, the next
run after that has truly nothing left to do but paste and run.

**One correctness trap found this run that the original Design section did not call out:**
`Libp2pFretService` has a private `get node()` accessor (string-keyed, not a symbol) at what was
line 82. Enumerating prototype methods via `Object.getOwnPropertyNames(proto)` and then checking
`typeof proto[name] === 'function'` by **directly indexing `proto[name]`** invokes that getter
immediately (`proto` here is the bare prototype object, not a constructed instance) — its body
reads `this.components.libp2p`, and `this.components` is `undefined` on the bare prototype, so the
enumeration itself throws. The fix is to check the property **descriptor** instead of touching the
property: `typeof Object.getOwnPropertyDescriptor(proto, name)?.value === 'function'`. This never
invokes any getter, so `node`, `[Symbol.toStringTag]`, and `[peerDiscoverySymbol]` are all excluded
safely (the latter two are also simply invisible to `getOwnPropertyNames`, since it only returns
string keys and both are computed symbol keys — but `node` is a real trap the naive filter walks
into). The file below uses the descriptor form throughout.

**Arity-driven sentinel args.** Every wrapper method's optional trailing parameters compile to
plain (non-default) JS parameters, so `Function.prototype.length` already equals the number of
arguments the design wants exercised, optional ones included — no per-method arg-count table
needed. `sentinelArgs(fn)` below just builds `fn.length` distinct `{__arg: i}` objects.

**Exact classification derived by reading every wrapper method body** (all still match — see
prior runs' confirmation of zero drift):
- `ASYNC_UNWRAP = ['routeAct', 'ready', 'importTable']` — for the **forwarding-with-mock**
  property, these three need `await` before comparing the resolved value to the mock's sentinel,
  because their wrappers return a `Promise` (either via `async`/`await`, or via bare `return
  this.ensure().importTable(table)` which forwards the promise object itself).
- `REJECTS = ['routeAct', 'ready']` only — for the **not-injected-throws** property. This is
  narrower than `ASYNC_UNWRAP` and is the one subtlety easy to get wrong: `importTable`'s wrapper
  is **not** marked `async` (`importTable(table): Promise<number> { return
  this.ensure().importTable(table); }`), so when `ensure()` throws, it throws **synchronously**
  out of the `importTable(...)` call itself — there is no promise yet to reject. Only the two
  methods whose wrapper body actually has the `async` keyword ahead of the `ensure()` call
  (`routeAct`, `ready`) convert that synchronous throw into a rejected promise. Every other
  method — including `importTable` and `iterativeLookup` — throws synchronously when uninjected,
  because every non-`async` wrapper calls `this.ensure()` as its first statement.
- `ASYNC_GENERATOR = ['iterativeLookup']` — call it (no `await`), assert identity on the returned
  generator object directly; never iterate it.
- Every other enumerated method is synchronous request/response: call directly, assert identity
  on the return value directly.

**Pinned expected count: `forwarding.length === 20`.** Counted by hand from the full method list
in `libp2p-fret-service.ts`: 27 total function-valued own properties on the prototype (26 methods
+ `constructor`), minus the 7-entry skip list (`constructor, start, stop, setLibp2p,
getPeerDiscovery, ensure, discoverySource`) = 20. (The original ticket's "22-ish" estimate was an
approximation and undercounts the skip list; 20 is the exact, derived number — hardcode it so a
future skip-list addition without updating this number is a loud, deliberate failure, per the
Design section's "future interface member... doesn't silently fall into an ever-growing skip list
unnoticed.")

**Complete file to create at `test/libp2p-facade-forwarding.spec.ts`:**
```ts
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { Libp2pFretService } from '../src/service/libp2p-fret-service.js'

function coreOf(svc: Libp2pFretService): { inner: unknown } {
	return svc as unknown as { inner: unknown }
}

const SKIP_LIST = ['constructor', 'start', 'stop', 'setLibp2p', 'getPeerDiscovery', 'ensure', 'discoverySource']
// Wrappers whose body has `async` ahead of the ensure() call: a missing core surfaces as a
// rejected promise. Every other method (including importTable, whose wrapper forwards a promise
// but is not itself async) throws synchronously when uninjected.
const REJECTS = new Set(['routeAct', 'ready'])
// Methods whose wrapper returns a Promise that must be awaited to reach the mock's sentinel.
const ASYNC_UNWRAP = new Set(['routeAct', 'ready', 'importTable'])
// Returns a generator object synchronously; identity-check the object itself, never iterate it.
const ASYNC_GENERATOR = new Set(['iterativeLookup'])

type AnyFn = (...args: unknown[]) => unknown

function protoRecord(): Record<string, unknown> {
	return Libp2pFretService.prototype as unknown as Record<string, unknown>
}

// Uses property descriptors, never direct indexing: Libp2pFretService has a private `get node()`
// accessor whose body dereferences `this.components`, which is undefined on the bare prototype
// object — indexing `proto['node']` directly invokes it and throws.
function enumerateForwardingMethods(): string[] {
	const proto = protoRecord()
	return Object.getOwnPropertyNames(proto)
		.filter(name => typeof Object.getOwnPropertyDescriptor(proto, name)?.value === 'function')
		.filter(name => !SKIP_LIST.includes(name))
}

function sentinelArgs(fn: AnyFn): unknown[] {
	return Array.from({ length: fn.length }, (_, i) => ({ __arg: i }))
}

function call(svc: unknown, name: string, args: unknown[]): unknown {
	return (svc as Record<string, AnyFn>)[name]!(...args)
}

describe('Libp2pFretService — forwarding', function () {
	this.timeout(20_000)

	it('skip list entries all still exist on the prototype', () => {
		const proto = protoRecord()
		for (const name of SKIP_LIST) {
			if (name === 'constructor') continue
			expect(typeof Object.getOwnPropertyDescriptor(proto, name)?.value, name).to.equal('function')
		}
	})

	it('enumerates a non-empty, exactly-20-member forwarding set (getters excluded)', () => {
		const forwarding = enumerateForwardingMethods()
		expect(forwarding.length).to.equal(20)
		expect(forwarding).to.include('getDiagnostics')
		expect(forwarding).to.not.include.members(SKIP_LIST.filter(n => n !== 'constructor'))
	})

	it('forwards every non-skipped method to the core with exact args, order, and return identity', async () => {
		const node = await createMemNode(); await node.start()
		const svc = new Libp2pFretService({ libp2p: node }, { profile: 'core', k: 7 })
		try {
			svc.setMode('passive') // cheap real pass-through: forces ensure() to build the real core once
			const calls: Array<{ name: string; args: unknown[] }> = []
			const proto = protoRecord() as Record<string, AnyFn>
			const methods = enumerateForwardingMethods()
			const sentinels = new Map<string, unknown>()
			const mockCore: Record<string, AnyFn> = {}
			for (const name of methods) {
				const sentinel = { __sentinel: name }
				sentinels.set(name, sentinel)
				mockCore[name] = (...args: unknown[]) => {
					calls.push({ name, args })
					return ASYNC_UNWRAP.has(name) ? Promise.resolve(sentinel) : sentinel
				}
			}
			coreOf(svc).inner = mockCore

			for (const name of methods) {
				calls.length = 0
				const args = sentinelArgs(proto[name]!)
				let result = call(svc, name, args)
				if (ASYNC_UNWRAP.has(name)) result = await result
				expect(calls, `${name} called once`).to.have.length(1)
				expect(calls[0]!.name).to.equal(name)
				expect(calls[0]!.args, `${name} args in order`).to.deep.equal(args)
				expect(result, `${name} return identity`).to.equal(sentinels.get(name))
			}
		} finally {
			await svc.stop()
			await stopAll([node])
		}
	})

	it('every non-skipped method fails with the not-injected error when no core exists', async () => {
		const svc2 = new Libp2pFretService({})
		const proto = protoRecord() as Record<string, AnyFn>
		const methods = enumerateForwardingMethods()
		for (const name of methods) {
			const args = sentinelArgs(proto[name]!)
			if (REJECTS.has(name)) {
				let err: unknown
				try { await call(svc2, name, args) } catch (e) { err = e }
				expect(err, `${name} rejects`).to.be.instanceOf(Error)
				expect((err as Error).message, name).to.match(/libp2p node not injected/)
			} else {
				expect(() => call(svc2, name, args), name).to.throw(/libp2p node not injected/)
			}
		}
	})
})
```

**Verification commands (run both, in order, after creating the file):**
```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/libp2p-facade-forwarding.spec.ts" --timeout 30000
cd packages/fret && npx tsc --noEmit
```
If the mocha run fails on a specific method's arg count or sync/async classification, the fix is
almost certainly a one-line correction to `REJECTS` / `ASYNC_UNWRAP` / `ASYNC_GENERATOR` above (or,
if `libp2p-fret-service.ts` has genuinely changed since this note, re-deriving that one method's
row from its current wrapper body) — not a redesign.

Confirmed facts below (unchanged from the original ticket, now double-checked) save the next run a
re-discovery pass; the Design/Edge-cases/TODO sections are otherwise unchanged and still the spec
to implement.

**Confirmed by reading `packages/fret/src/service/libp2p-fret-service.ts` (full file, 223 lines):**
- Every method matches the design doc's description. `ensure()` (private, line 86) throws
  `Error('Libp2pFretService: libp2p node not injected')` when neither `setLibp2p` nor the
  `components.libp2p` fallback supplied a node — this is the exact string the not-injected-throws
  property (design step 6) should match against (`/libp2p node not injected/`).
- `getDiagnostics` (line 142) returns `ReturnType<CoreFretService['getDiagnostics']>` and forwards
  to `this.ensure().getDiagnostics()` — confirmed not on the public `FretService` interface, confirmed
  present as a real wrapper method. Must NOT be in the skip list; mock needs a `getDiagnostics` spy.
- `[Symbol.toStringTag]` (line 62) and `[peerDiscoverySymbol]` (line 114) are both `get` accessors
  (property descriptor has `get`, no plain `value`) — confirmed these are what the
  `typeof proto[name] === 'function'` filter naturally excludes.
- Skip-list candidates all confirmed present on the prototype: `constructor`, `start` (123),
  `stop` (133), `setLibp2p` (71), `getPeerDiscovery` (119), plus the two private helpers `ensure`
  (86) and `discoverySource` (102) — `discoverySource` has no same-named core counterpart at all,
  confirmed (core has no `discoverySource` method).

**Confirmed by reading `packages/src/index.ts` lines 100-130 (`FretService` interface):** 21
members exactly: `start, stop, setMode, ready, neighborDistance, getNeighbors, assembleCohort,
expandCohort, routeAct, report, setMetadata, getMetadata, listPeers, reportNetworkSize,
getNetworkSizeEstimate, getNetworkChurn, detectPartition, setActivityHandler, iterativeLookup,
exportTable, importTable`. This matches the ticket's "known 21-ish member count" — so
(enumerated prototype methods − skip list) should equal 21 interface members + 1 (`getDiagnostics`)
= 22 non-skipped forwarding methods to test.

**Confirmed by reading `packages/fret/test/libp2p-service-node-source.spec.ts` (the existing
wrapper spec, full file) — this is the pattern to follow for imports/setup:**
```ts
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { Libp2pFretService } from '../src/service/libp2p-fret-service.js'
```
Construction pattern confirmed: `new Libp2pFretService({ libp2p: node }, { profile: 'core', k: 7 })`,
then `await svc.start()` / `await svc.stop()`, `await stopAll([node])` in a `finally`. The
not-injected case in that existing spec (lines 44-50) is the direct precedent for design step 6:
`new Libp2pFretService({}, { profile: 'core', k: 7 })`, call `svc.start()` (or whichever method),
catch, assert `instanceOf Error` and message matches `/node not injected/`.

**Confirmed by reading `packages/fret/test/helpers/libp2p.ts`:** `createMemNode(addr?)` returns a
`Promise<Libp2p>` using the in-memory transport (no identify needed for this ticket — forwarding
doesn't touch membership classification). `stopAll(nodes)` stops newest-first, best-effort,
logging failures rather than throwing. Both already imported correctly in the existing spec above.

**Not yet done — full scope remains:**
- `test/libp2p-facade-forwarding.spec.ts` has not been created. Nothing written.
- The `coreOf` cast helper, the mock core object, the runtime prototype enumeration, the two
  properties (forwarding-with-mock, not-injected-throws) — all still to write, exactly per the
  Design/Edge-cases sections below (unchanged from the original ticket).
- Neither `mocha` nor `tsc --noEmit` has been run against the new file (it doesn't exist yet).

Resume by writing the spec file directly — no further research needed before starting.

## Design (resolved)

New file `test/libp2p-facade-forwarding.spec.ts`, one table-driven test, not 21 hand-written ones:

1. Construct `new Libp2pFretService({ libp2p: node }, { profile: 'core', k: 7 })` with a node from
   `createMemNode()` (helper already in `test/helpers/libp2p.ts`), then force the private core to
   build by calling `svc.setMode('passive')` (or any cheap real pass-through) once — or simply
   invoke the private `ensure()` via the same cast used below. Either way, one narrow named cast
   helper reaches the private field:
   ```ts
   function coreOf(svc: Libp2pFretService): { inner: unknown } {
     return svc as unknown as { inner: unknown }
   }
   ```
2. Replace `coreOf(svc).inner` with a hand-built mock object implementing the `FretService`
   surface: every method is a small spy that records `(name, args)` into a shared array and
   returns a distinct sentinel object (`{ __sentinel: methodName }`) so return-by-identity is
   checkable with `.to.equal(...)`, not `.to.deep.equal(...)`.
3. Enumerate the wrapper's own prototype methods at runtime:
   `Object.getOwnPropertyNames(Libp2pFretService.prototype)` filtered to
   `typeof proto[name] === 'function'` (this naturally excludes the two `get` accessors —
   `[Symbol.toStringTag]` and `[peerDiscoverySymbol]` — since their property descriptor has no
   plain `value`).
4. Skip list (methods deliberately not plain forwards to a same-named core method — read off the
   current source, so a maintainer adding a new one must touch this list, which is the property
   the ticket wants):
   - `constructor` (not a method call)
   - `start`, `stop` — do extra discovery-loop work around the core call
   - `setLibp2p` — sets `nodeRef` only, never touches `inner`/core
   - `getPeerDiscovery` — returns `this.discovery`, not a core forward
   - `ensure`, `discoverySource` — private helpers; `ensure()` is what *builds* `inner`, and
     `discoverySource` has no same-named core counterpart at all
5. For every remaining method name: call it on `svc` with a fresh set of distinct sentinel
   arguments (one sentinel per parameter position — plain objects/strings/numbers that are easy
   to tell apart, e.g. `{__arg: 0}, {__arg: 1}, ...`), then assert:
   - the mock's same-named method was called exactly once
   - with exactly those sentinels, in that order (`.to.deep.equal` on the args array is fine here
     — argument *identity* doesn't need proving, only order/completeness; it's the *return value*
     identity that must not be cloned)
   - the wrapper's return value is `.to.equal` (identity) the mock's return sentinel — covers both
     sync returns and `Promise`-returning methods (`await` both sides)
6. Second property, same rig: before installing the mock (i.e. with `inner` still `null` and no
   node ever supplied — construct a second `svc2 = new Libp2pFretService({})` for this part, no
   `setLibp2p`), call each non-skipped method and assert it rejects/throws matching
   `/libp2p node not injected/` — proving every pass-through actually funnels through `ensure()`'s
   guard. Async methods: assert on the rejected promise; sync methods: assert on the thrown call.

Reaching into `svc.inner` uses the one named cast helper (`coreOf`) above — not sprinkled `any`.

## Edge cases & interactions

- **Sync vs async methods differ in call shape.** `routeAct`, `ready`, `importTable`,
  `iterativeLookup` (async generator, not a plain `Promise`) need different invocation/assertion
  handling than the sync majority. `iterativeLookup` returns an `AsyncGenerator` object directly
  (not awaited) — the identity check is on the generator object itself, not on anything it later
  yields; do not iterate it.
- **Optional trailing parameters must still be exercised.** `reportNetworkSize(estimate,
  confidence, source?)`, `getNeighbors`/`assembleCohort`/`expandCohort` (optional `exclude`) —
  call once with the optional argument present (this is the case that would catch a swap) since
  the whole point of this ticket is catching a swapped/misordered argument list.
- **Getter properties are not methods and must not appear in the enumerated list** —
  `[Symbol.toStringTag]` and `[peerDiscoverySymbol]`. Confirm the enumeration filter actually
  excludes them (assert the generated method-name list's length/contents once, so a future
  reader sees the filter is doing real work, not just trusting it silently).
- **The skip list itself should be asserted against the live prototype**, not just trusted: e.g.
  assert every skip-listed name actually exists on the prototype (catches a rename left stale in
  the test) and that the remaining (enumerated − skipped) set is non-empty and matches the known
  21-ish member count roughly, so a future interface member that should be forwarded doesn't
  silently fall into an ever-growing skip list unnoticed.
- **`getDiagnostics`** is not on the public `FretService` interface but *is* a real wrapper
  method calling `this.ensure().getDiagnostics()` — it must NOT be skip-listed; it's exactly the
  kind of member the plain-forward test should cover, and the mock object needs a
  `getDiagnostics` spy too even though it's typed via `ReturnType<CoreFretService[...]>` rather
  than the `FretService` interface.
- **Mock installation must happen after `ensure()` has run once**, otherwise the first
  non-`ensure`-triggering call under test would go through the *real* `ensure()` logic and throw
  or construct a second real core. Simplest path: call `svc.setMode('passive')` (or any single
  harmless real pass-through) once before swapping `inner`, to force construction, then swap.
- **Two separate `Libp2pFretService` instances needed** — one with a node (for the
  forwarding-with-mock property) and one with no node at all (for the not-injected-throws
  property) — don't try to reuse one instance across both, since once `inner` is set/mocked the
  not-injected guard can no longer be exercised on it.

## TODO

- Write `test/libp2p-facade-forwarding.spec.ts` per the design above
- Enumerate prototype methods at runtime; assert the skip list against the live prototype
- Build the mock core (spy + sentinel-return per method) and the one named cast helper (`coreOf`)
- Cover sync, async (`Promise`), and async-generator (`iterativeLookup`) return shapes
- Exercise optional trailing parameters at least once each (`reportNetworkSize` source arg,
  `exclude` sets)
- Add the not-injected-throws property against a second, un-injected instance
- Run `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/libp2p-facade-forwarding.spec.ts" --timeout 30000` and `npx tsc --noEmit`


## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
