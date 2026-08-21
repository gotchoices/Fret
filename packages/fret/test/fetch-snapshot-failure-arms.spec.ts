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
	/** Extra nodes a single test spins up (the two-node `foreign-protocol` arm). Torn down with `node`. */
	let extraNodes: Libp2p[]

	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
		// Deliberately unstarted: no stabilization loop, no registered handlers.
		svc = new CoreFretService(node, { profile: 'core', networkName: NETWORK })
		extraNodes = []
	})

	afterEach(async () => { await stopAll([node, ...extraNodes]) })

	interface EntrySnapshot {
		contactFailures: number
		negotiateFailures: number
		failureCount: number
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
			failureCount: e!.failureCount,
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

	/**
	 * Serve `newStream` as the node's only open connection for the duration of `fn`, restoring the
	 * real `getConnections` afterwards. The three stubs below differ only in what that `newStream`
	 * does — a readable reply, an open that rejects, a stream that never yields — and each must
	 * stay incapable of producing the others' behavior, so the *behaviors* remain three separate
	 * functions while this override/restore shape is stated once.
	 */
	async function withConnection<T>(newStream: () => Promise<Stream>, fn: () => Promise<T>): Promise<T> {
		const holder = node as unknown as { getConnections: (p?: PeerId) => Connection[] }
		const real = holder.getConnections.bind(node)
		holder.getConnections = () => [{ status: 'open', newStream }] as unknown as Connection[]
		try {
			return await fn()
		} finally {
			holder.getConnections = real
		}
	}

	/**
	 * Hand back an open connection whose stream yields `body` as one framed JSON chunk then EOF,
	 * for the duration of `fn`. `pulls` proves the stream was actually read, so a test using this
	 * cannot pass by silently taking the `skipped` arm instead.
	 */
	async function withStubReply<T>(body: unknown, fn: () => Promise<T>): Promise<{ result: T, pulls: number }> {
		let pulls = 0
		const chunk = json(body)
		const stream = {
			id: 'stub-reply',
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

		return { result: await withConnection(async () => stream, fn), pulls }
	}

	function snapshotBody(from: string): unknown {
		return { v: 1, from, timestamp: Date.now(), successors: [], predecessors: [], sig: '' }
	}

	it('decode-error: a genuinely unusable reply is bookkeeping-identical to skipped', async () => {
		const before = seed(FROM)
		const fetchedBefore = svc.getDiagnostics().snapshotsFetched

		// Rejected by makeSnapshotParser: `from` must be a parseable peer id.
		const { result: announced, pulls } = await withStubReply(
			snapshotBody('not-a-peer-id'),
			async () => await (svc as any).fetchAndMergeSnapshot(FROM, undefined) as string[],
		)

		expect(announced, 'nothing announced').to.deep.equal([])
		expect(pulls, 'the stub stream was actually read, not skipped').to.be.greaterThan(0)
		expect(readEntry(FROM), 'entry unchanged - bookkeeping-identical to skipped').to.deep.equal(before)
		expect(svc.getDiagnostics().snapshotsFetched, 'not counted as fetched').to.equal(fetchedBefore)
	})

	// Positive control for the test above. `decode-error` and `busy` are both silent arms, so
	// "nothing was scored" alone cannot prove which one ran - nor that the stub is capable of
	// reaching a scoring arm at all. Same stub, same node, only the body differs: a parseable
	// snapshot must count as fetched. Without this, deleting the whole switch would still leave
	// the decode-error test green.
	it('the same stub with a parseable body reaches the ok arm and is counted', async () => {
		seed(FROM)
		const fetchedBefore = svc.getDiagnostics().snapshotsFetched

		const { pulls } = await withStubReply(
			snapshotBody(FROM),
			async () => await (svc as any).fetchAndMergeSnapshot(FROM, undefined) as string[],
		)

		expect(pulls, 'the stub stream was actually read').to.be.greaterThan(0)
		expect(svc.getDiagnostics().snapshotsFetched, 'a parseable reply is a fetch').to.equal(fetchedBefore + 1)
	})


	// ---------------------------------------------------------------------------------------
	// The three arms that reach `noteRpcFailure`. Read against that method's switch in
	// `fret-service.ts`, confirmed this run:
	//   foreign-protocol -> applyMembershipSignal(id, 'negotiate-failure')
	//                       => negotiateFailures +1; membership only flips at the threshold of 3
	//   unreachable      -> applyContactFailure => applyFailure (relevance recompute +
	//   timeout          -/                        failureCount +1), then applyContactStrike
	//                                              (contactFailures +1)
	// The point of pinning all three next to `decode-error` (above, which scores *nothing*) is
	// that the four land on visibly different bookkeeping. A future edit collapsing any two of
	// them onto one path fails here rather than shipping.
	// ---------------------------------------------------------------------------------------

	it('foreign-protocol: a connected peer that does not serve this protocol takes the membership path', async () => {
		// A genuine negotiation failure cannot be faked with a stub stream — a stub answering with
		// valid bytes always looks like a valid protocol response. `foreign-protocol` means libp2p
		// itself failed to agree on a protocol id, so this needs a real second node.
		//
		// That second node deliberately runs **no FRET service at all**, rather than an unstarted
		// one: an unstarted `CoreFretService` registers nothing, so it would be indistinguishable
		// from a bare node here while costing the test a construction it never uses. What the arm
		// needs is precisely "connected and reachable, but no handler for
		// /optimystic/<network>/fret/1.0.0/neighbors".
		const other = await createMemNode()
		await other.start()
		extraNodes.push(other)
		const otherId = other.peerId.toString()

		// Real dial, so a real connection exists — `fetchNeighbors` is connection-only (dial
		// 'never') and reuses it rather than dialing fresh. Connect *before* evaluating handlers:
		// the peer is up and dialable, it simply does not speak this protocol.
		await node.dial(other.getMultiaddrs()[0]!)

		const before = seed(otherId)
		expect(before.negotiateFailures, 'starts with a clean negotiate run').to.equal(0)
		const fetchedBefore = svc.getDiagnostics().snapshotsFetched

		const announced = await (svc as any).fetchAndMergeSnapshot(otherId, undefined) as string[]
		const after = readEntry(otherId)

		expect(announced, 'nothing announced').to.deep.equal([])
		expect(svc.getDiagnostics().snapshotsFetched, 'not counted as fetched').to.equal(fetchedBefore)
		// The membership channel, and only it.
		expect(after.negotiateFailures, 'exactly one negotiate-failure strike').to.equal(before.negotiateFailures + 1)
		// One failure is evidence, not a verdict: the demotion threshold is 3, so a single blip
		// must not demote a confirmed member.
		expect(after.membership, 'still a member after one blip').to.equal('member')
		// ...and nothing on the contact channel: the peer answered the dial, so it is neither
		// unreachable nor a failed contact.
		expect(after.contactFailures, 'no contact strike').to.equal(before.contactFailures)
		expect(after.failureCount, 'no relevance decay — applyFailure never ran').to.equal(before.failureCount)
		expect(after.relevance, 'relevance untouched').to.equal(before.relevance)
		expect(after.state, 'liveness untouched').to.equal(before.state)
	})

	/**
	 * Hand back an open connection whose `newStream` **rejects** — no stream is ever opened, so
	 * nothing can be read. Deliberately distinct from `withStubReply` above: this arm must not be
	 * able to produce a readable (or merely hanging) stream, or the timeout arm's assertion would
	 * be what is really firing here.
	 */
	async function withFailingOpen<T>(fn: () => Promise<T>): Promise<{ result: T, opens: number }> {
		let opens = 0
		const newStream = async (): Promise<Stream> => { opens++; throw new Error('boom') }
		return { result: await withConnection(newStream, fn), opens }
	}

	it('unreachable: a stream that will not open is a contact failure, not a membership one', async () => {
		const before = seed(FROM)
		const fetchedBefore = svc.getDiagnostics().snapshotsFetched

		const { result: announced, opens } = await withFailingOpen(
			async () => await (svc as any).fetchAndMergeSnapshot(FROM, undefined) as string[],
		)
		const after = readEntry(FROM)

		expect(opens, 'the open was actually attempted, not skipped').to.equal(1)
		expect(announced, 'nothing announced').to.deep.equal([])
		expect(svc.getDiagnostics().snapshotsFetched, 'not counted as fetched').to.equal(fetchedBefore)
		// The contact channel, and only it. `failureCount` is the unambiguous proof that
		// `applyFailure` ran: relevance is *recomputed* from the health counters rather than
		// scaled down, so on a freshly-seeded entry (every counter at 0) its numeric direction is
		// not a reliable signal, while the counter driving the recompute is.
		expect(after.contactFailures, 'exactly one contact strike').to.equal(before.contactFailures + 1)
		expect(after.failureCount, 'relevance was re-scored on the failure').to.equal(before.failureCount + 1)
		// One strike of the three needed for `dead`.
		expect(after.state, 'one strike is not yet dead').to.equal(before.state)
		// ...and nothing on the membership channel: failing to reach a peer says nothing about
		// which network it belongs to.
		expect(after.negotiateFailures, 'no negotiate-failure strike').to.equal(before.negotiateFailures)
		expect(after.membership, 'membership untouched').to.equal('member')
	})

	describe('timeout', function () {
		// The real default is 1000ms. Override the static so the test costs ~50ms of wall clock
		// instead, and restore it after — the arm is about which counters move, not about how long
		// the deadline is, and pinning the real value only buys a slower suite.
		const REAL_TIMEOUT = (CoreFretService as any).MAINTENANCE_SNAPSHOT_TIMEOUT_MS as number
		const SHORT_TIMEOUT_MS = 50

		beforeEach(() => { (CoreFretService as any).MAINTENANCE_SNAPSHOT_TIMEOUT_MS = SHORT_TIMEOUT_MS })
		afterEach(() => { (CoreFretService as any).MAINTENANCE_SNAPSHOT_TIMEOUT_MS = REAL_TIMEOUT })

		/**
		 * Hand back an open connection whose stream opens fine and then never yields a byte. The
		 * iterator's `next()` never settles at all; `readFramed` races each read against the
		 * signal it was handed, so the fetch's own internal deadline — built from
		 * `MAINTENANCE_SNAPSHOT_TIMEOUT_MS`, not from any signal the caller passed — is what ends
		 * it. Deliberately *not* a rejecting open: that is the `unreachable` arm.
		 */
		async function withHangingStream<T>(fn: () => Promise<T>): Promise<{ result: T, pulls: number }> {
			let pulls = 0
			const stream = {
				id: 'stub-hang',
				send: (): boolean => true,
				close: async (): Promise<void> => { /* released */ },
				abort: (): void => { /* released */ },
				[Symbol.asyncIterator]: () => ({
					next: async (): Promise<IteratorResult<Uint8Array>> => {
						pulls++
						return await new Promise<IteratorResult<Uint8Array>>(() => { /* never settles */ })
					},
				}),
			} as unknown as Stream

			return { result: await withConnection(async () => stream, fn), pulls }
		}

		it('a peer that opens a stream and then stalls lands on the same counter as unreachable', async () => {
			const before = seed(FROM)
			const fetchedBefore = svc.getDiagnostics().snapshotsFetched

			const started = Date.now()
			// An `undefined` signal is fine here: the deadline is internal to the fetch — a child
			// of whatever was passed — so it still fires on its own.
			const { result: announced, pulls } = await withHangingStream(
				async () => await (svc as any).fetchAndMergeSnapshot(FROM, undefined) as string[],
			)
			const elapsed = Date.now() - started
			const after = readEntry(FROM)

			expect(pulls, 'the stub stream was actually read, not skipped').to.be.greaterThan(0)
			// Bounded well inside the real 1000ms, so an override that silently stopped taking
			// effect fails here rather than squeaking under a bound set at the real value. Half
			// the real timeout is 10x the override and still nowhere near scheduler noise, so it
			// pins the override taking effect without pinning the deadline's exact value.
			expect(elapsed, 'bounded by the overridden timeout, not the real 1000ms').to.be.lessThan(REAL_TIMEOUT / 2)
			expect(announced, 'nothing announced').to.deep.equal([])
			expect(svc.getDiagnostics().snapshotsFetched, 'not counted as fetched').to.equal(fetchedBefore)
			// Same channel as `unreachable`: both are "could not get an answer at all".
			expect(after.contactFailures, 'exactly one contact strike').to.equal(before.contactFailures + 1)
			expect(after.failureCount, 'relevance was re-scored on the failure').to.equal(before.failureCount + 1)
			expect(after.state, 'one strike is not yet dead').to.equal(before.state)
			expect(after.negotiateFailures, 'no negotiate-failure strike').to.equal(before.negotiateFailures)
			expect(after.membership, 'membership untouched').to.equal('member')
		})
	})

	// cancelled arm: already covered directly by dead-state.spec.ts:1035
	// ('merges nothing and scores nothing when a snapshot fetch is cancelled') — verified this run
	// to call fetchAndMergeSnapshot directly with a pre-aborted run signal. Not duplicated here.
})
