description: Add tests proving that when this node asks a peer for its neighbour list and the peer either doesn't answer at all or answers with garbage, the code's bookkeeping reaction stays exactly what it is today — so a future change that silently starts scoring these cases gets caught.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/fetch-snapshot-failure-arms.spec.ts (new), packages/fret/test/rpc.snapshot-merge-cap.spec.ts, packages/fret/test/dead-state.spec.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
----

Third continuation of this ticket — the prior two runs both hit the session token budget during
discovery/re-verification before writing test code. Discovery is now fully done and re-confirmed
this run (code at `fetchAndMergeSnapshot` lines 2637–2681 read directly, `dead-state.spec.ts`
cancelled test read directly at lines 1035–1046, `rpc.snapshot-merge-cap.spec.ts` helpers read
directly lines 154–221, `test/helpers/rpc-fuzz.ts` read in full). A ready-to-paste draft test file
is below — the only remaining work is: paste it in, adjust anything that doesn't compile/pass, and
run `yarn test`. **Do not re-open `fret-service.ts` or the merge-cap spec to re-derive anything —
everything needed is already extracted below.**

A sibling ticket (`fetch-snapshot-failure-arms-hard`, prereq on this one, same target file) covers
`foreign-protocol` / `unreachable` / `timeout` / `busy` — don't do that work here.

## Confirmed facts (do not re-derive)

- `fetchAndMergeSnapshot(id, signal)` is a **private** method on `FretService`
  (`packages/fret/src/service/fret-service.ts:2637`), called via `(svc as any).fetchAndMergeSnapshot(id, signal)`.
- Switch arms relevant here (exact code, confirmed this run):
  ```ts
  switch (out.kind) {
      case 'skipped':      // no connection — nothing attempted, count nothing
      case 'cancelled':    // our own cancellation — not evidence about the peer
          return announced;
      case 'busy':
      case 'decode-error':
          // Answered badly / refused: alive. Today's empty-snapshot path scored nothing — preserved.
          log.error('fetchNeighbors %s from %s', out.kind, id);
          return announced;
      case 'foreign-protocol':
      case 'unreachable':
      case 'timeout':
          await this.noteRpcFailure(id, out);
          return announced;
      case 'ok':
          break;
  }
  ```
  `skipped` and `decode-error` are **bookkeeping-identical**: nothing is scored, nothing touched,
  only a `log.error` call distinguishes `decode-error` (and that isn't observable from outside).
  This corrects the original ticket's assumption that `decode-error` should show relevance decay —
  it does not, by design ("Today's empty-snapshot path scored nothing — preserved").
- `svc.getDiagnostics().snapshotsFetched` only increments on `ok` (confirmed both in the switch
  above — `this.diag.snapshotsFetched++` sits right after the switch, before the merge loops — and
  in `dead-state.spec.ts`'s own comment at line ~1030).
- `svc.getStore()` returns the store; `store.upsert(id, coord)`, `store.setMembership(id, 'member')`,
  `store.getById(id)` (returns `{contactFailures, negotiateFailures, relevance, membership, state, ...}`)
  are all confirmed in use in `dead-state.spec.ts` (its `unreachablePeer`/`expectUnscored` helpers,
  lines ~897–929).
- **Arm 3 (`cancelled`) is already directly covered — confirmed this run, no new test needed.**
  `packages/fret/test/dead-state.spec.ts`, lines 1035–1046, test
  `'merges nothing and scores nothing when a snapshot fetch is cancelled'`:
  ```ts
  it('merges nothing and scores nothing when a snapshot fetch is cancelled', async () => {
      const id = await unreachablePeer()
      cancelRun()
      const before = svc.getDiagnostics().snapshotsFetched
      const entriesBefore = store.list().length

      await (svc as any).fetchAndMergeSnapshot(id, (svc as any).runSignal)

      expect(svc.getDiagnostics().snapshotsFetched, 'a cancelled fetch is not a fetch').to.equal(before)
      expect(store.list().length, 'nothing merged').to.equal(entriesBefore)
      expectUnscored(id)
  })
  ```
  This calls `fetchAndMergeSnapshot` **directly** with a pre-aborted run signal (`cancelRun()` sets
  it up), which is exactly the direct test the original ticket wanted. Just cite this location in
  the handoff — do not duplicate it.

## Ready-to-paste draft: `packages/fret/test/fetch-snapshot-failure-arms.spec.ts`

Paste this in as a starting point, then compile-check and adjust (e.g. if `store.setMembership` or
`PeerEntry` field names differ slightly from what's assumed, or if `Connection`/`PeerId`/`Stream`
type imports need tweaking to match the merge-cap spec's exact import list):

```ts
import { afterEach, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { Connection, PeerId, Stream } from '@libp2p/interface'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { NETWORK, peerIdStr, json } from './helpers/rpc-fuzz.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'

describe('fetchAndMergeSnapshot failure arms', function () {
	this.timeout(30000)

	// Distinct seed from rpc.snapshot-merge-cap.spec.ts's FROM (peerIdStr(60)) — hygiene only,
	// each test gets its own store so collision isn't actually reachable.
	const FROM = peerIdStr(220)

	let node: Libp2p
	let svc: CoreFretService

	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
		// Deliberately unstarted: no stabilization loop, no registered handlers.
		svc = new CoreFretService(node, { profile: 'core', networkName: NETWORK })
	})

	afterEach(async () => { await stopAll([node]) })

	interface EntrySnapshot {
		contactFailures: number
		negotiateFailures: number
		relevance: number
		membership: string
		state: string
	}

	function readEntry(id: string): EntrySnapshot {
		const e = svc.getStore().getById(id)
		expect(e, `${id} present in routing table`).to.not.equal(undefined)
		return {
			contactFailures: e!.contactFailures,
			negotiateFailures: e!.negotiateFailures,
			relevance: e!.relevance,
			membership: e!.membership,
			state: e!.state,
		}
	}

	function seed(id: string): EntrySnapshot {
		svc.getStore().upsert(id, new Uint8Array(32).fill(7))
		svc.getStore().setMembership(id, 'member')
		return readEntry(id)
	}

	it('skipped: no connection leaves the peer entirely untouched', async () => {
		const before = seed(FROM)
		const fetchedBefore = svc.getDiagnostics().snapshotsFetched

		const announced = await (svc as any).fetchAndMergeSnapshot(FROM, undefined)

		expect(announced, 'nothing announced').to.deep.equal([])
		expect(readEntry(FROM), 'entry unchanged').to.deep.equal(before)
		expect(svc.getDiagnostics().snapshotsFetched, 'not counted as fetched').to.equal(fetchedBefore)
	})

	it('decode-error: a genuinely unusable reply is bookkeeping-identical to skipped', async () => {
		const before = seed(FROM)
		const fetchedBefore = svc.getDiagnostics().snapshotsFetched

		// Rejected by makeSnapshotParser: `from` must be a parseable peer id.
		const body = { v: 1, from: 'not-a-peer-id', timestamp: Date.now(), successors: [], predecessors: [], sig: '' }
		let pulls = 0
		const chunk = json(body)
		const stream = {
			id: 'decode-error-stub',
			send: (): boolean => true,
			close: async (): Promise<void> => { /* released */ },
			abort: (): void => { /* released */ },
			[Symbol.asyncIterator]: () => ({
				next: async (): Promise<IteratorResult<Uint8Array>> => {
					pulls++
					return pulls === 1 ? { done: false, value: chunk } : { done: true, value: undefined }
				},
			}),
		} as unknown as Stream

		const holder = node as unknown as { getConnections: (p?: PeerId) => Connection[] }
		const real = holder.getConnections.bind(node)
		holder.getConnections = () => [{ status: 'open', newStream: async () => stream }] as unknown as Connection[]

		let announced: string[]
		try {
			announced = await (svc as any).fetchAndMergeSnapshot(FROM, undefined)
		} finally {
			holder.getConnections = real
		}

		expect(announced, 'nothing announced').to.deep.equal([])
		expect(pulls, 'the stub stream was actually read, not skipped').to.be.greaterThan(0)
		expect(readEntry(FROM), 'entry unchanged — bookkeeping-identical to skipped').to.deep.equal(before)
		expect(svc.getDiagnostics().snapshotsFetched, 'not counted as fetched').to.equal(fetchedBefore)
	})

	// cancelled arm: already covered directly by dead-state.spec.ts:1035
	// ('merges nothing and scores nothing when a snapshot fetch is cancelled') — verified this run
	// to call fetchAndMergeSnapshot directly with a pre-aborted run signal. Not duplicated here.
})
```

Notes on likely adjustment points (not re-verified this run, flagged so the next agent checks fast
rather than re-discovering from scratch):
- `store.setMembership` signature/name — used as-is in `dead-state.spec.ts`, should be exact.
- `PeerEntry.membership` / `.state` string literal types — `deep.equal` against a captured object
  sidesteps needing the exact union type names.
- If `CoreFretService` constructor signature differs from `{ profile, networkName: NETWORK }`,
  copy the exact constructor call from `rpc.snapshot-merge-cap.spec.ts` line ~252 instead.

## TODO

- Create `packages/fret/test/fetch-snapshot-failure-arms.spec.ts` from the draft above
- Compile-check (`npx tsc --noEmit` from `packages/fret/`) and fix any type mismatches
- Run `yarn test` from `packages/fret/` and confirm the new file + full suite green
- In the review handoff, cite `dead-state.spec.ts:1035` for the `cancelled` arm (no new test needed for it)

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
