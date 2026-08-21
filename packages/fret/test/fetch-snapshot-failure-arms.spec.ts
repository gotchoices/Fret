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
