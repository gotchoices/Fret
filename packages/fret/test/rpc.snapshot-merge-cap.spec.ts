import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { Connection, PeerId, Stream } from '@libp2p/interface'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import {
	type InboundHandler,
	NETWORK,
	P,
	inboundStub,
	json,
	peerIdStr,
	sampleCoord,
	sleep,
	wrongWidthCoord,
} from './helpers/rpc-fuzz.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { makeSnapshotParser } from '../src/rpc/validate.js'
import { registerNeighbors } from '../src/rpc/neighbors.js'
import { hashPeerId } from '../src/ring/hash.js'
import { peerIdFromString } from '@libp2p/peer-id'
import type { NeighborSnapshotV1 } from '../src/index.js'

// What an over-long neighbor snapshot actually costs the receiver: the inbound snapshot-merge
// caps, on both the announce and the fetch path. Extracted from `rpc.handler-fuzz.spec.ts`,
// which owns the unit and service tiers of receive-side fault isolation and whose wire tier now
// lives in `rpc.handler-fuzz.wire.spec.ts`; this block is a distinct subject (a *bound* on
// accepted work, not stream release), so it owns its own file. Fixtures shared with those files
// live in `test/helpers/rpc-fuzz.ts`.

describe('RPC snapshot merge caps', function () {
	this.timeout(30000)

	// No case in this file may leak a rejection. Registered on this describe, not at file top
	// level (a top-level hook is a *root* hook and would run against the whole suite). Its twins
	// in each sibling file are deliberately copies, not a shared import — a shared one would
	// have to be installed by a root hook to cover them all.
	const unhandled: unknown[] = []
	const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }

	before(() => { process.on('unhandledRejection', onUnhandled) })
	after(() => { process.off('unhandledRejection', onUnhandled) })

	afterEach(async () => {
		await sleep(20) // detection is a tick behind the rejection
		const seen = unhandled.splice(0).map((r) => (r instanceof Error ? r.message : String(r)))
		expect(seen, 'unhandled rejection escaped').to.deep.equal([])
	})

	// -----------------------------------------------------------------------------------------
	// Service tier: what an over-long announce actually costs the receiver.
	//
	// `onAnnounce` is handed an *already-parsed* snapshot, so the parse + hash + upsert loop a
	// crafted announce drives is `FretService.mergeAnnounceSnapshot`, and its bound is
	// `FretService.mergeSnapshotCaps()` — enforced at the **snapshot parser**, which is the single
	// enforcement point. `makeSnapshotParser(mergeSnapshotCaps())` is handed to `registerNeighbors`
	// at the one registration site (announce) and to `fetchNeighbors` as its `parse` option (fetch),
	// and neither merge loop slices any more. So these tests drive the parser + merge pair the way
	// production drives it, and pin that an unparsed body is merged whole — which is what makes
	// "the parser is where the cap lives" a fact rather than a comment.
	//
	// The work is **counted** (`store.upsert` calls, by id and in order) rather than inferred from
	// "nothing crashed" — a cap that silently stopped applying would leave a passing no-crash test
	// and an unbounded per-message cost. Driven on unstarted services against
	// `mergeAnnounceSnapshot` directly, because `handleAnnounce` `detach`es the merge and a
	// detached merge cannot be counted deterministically. The one exception is the wiring test
	// that closes the block: it drives the *registered* handler, and buys determinism back by
	// wrapping `mergeAnnounceSnapshot` on the instance to capture and await the detached promise.
	//
	// The **fetch** path is the block's other half and shares every fixture: `fetchAndMergeSnapshot`
	// builds the same `makeSnapshotParser(mergeSnapshotCaps())` and hands it to `fetchNeighbors` as
	// `opts.parse`. It is driven through a stub reply stream (`fetchMerged`) rather than through
	// `fetchNeighbors` directly, because that sender's `parse` *defaults* to `Infinity` caps — a
	// test that called it would prove nothing about the caps the service supplies.
	// -----------------------------------------------------------------------------------------
	describe('snapshot merge caps', () => {
		interface Caps { successors: number; predecessors: number; sample: number }
		interface DrivableMerge {
			mergeAnnounceSnapshot(from: string, snap: NeighborSnapshotV1): Promise<void>
			mergeSnapshotCaps(): Caps
		}
		/** Only the one method the counter replaces — this spec never imports `DigitreeStore`. */
		interface CountableStore { upsert(id: string, coord: Uint8Array): unknown }

		/** `from` plus three lists of distinct, parseable ids (seeds stay under 256 to stay distinct). */
		const FROM = peerIdStr(60)
		const OVER_SUCC = Array.from({ length: 40 }, (_, i) => peerIdStr(61 + i))
		const OVER_PRED = Array.from({ length: 40 }, (_, i) => peerIdStr(101 + i))
		const OVER_SAMPLE = Array.from({ length: 20 }, (_, i) => ({ id: peerIdStr(141 + i), coord: sampleCoord(i + 1), relevance: 0.5 }))

		/** The raw announce body: every list far past any profile's cap. */
		function overCapBody(): Record<string, unknown> {
			return { v: 1, from: FROM, timestamp: Date.now(), successors: OVER_SUCC, predecessors: OVER_PRED, sample: OVER_SAMPLE, sig: '' }
		}

		/**
		 * Two usable sample ids for the per-entry tests below. Parseable, because the merge loops
		 * re-hash a sample entry's coordinate from its *id* rather than trusting `coord` — a
		 * synthetic non-peer-id string is dropped by that re-hash before any of the rules these
		 * tests are about can be observed.
		 */
		const GOOD_1 = peerIdStr(181)
		const GOOD_2 = peerIdStr(182)
		// A second usable pair, for a test that must exercise both merge paths against ids
		// neither path has seen — see the `relevance: null` case below.
		const GOOD_3 = peerIdStr(183)
		const GOOD_4 = peerIdStr(184)

		/** A three-entry sample whose middle coord decodes to 16 bytes instead of 32. */
		function shortCoordSample(): Array<Record<string, unknown>> {
			return [
				{ id: GOOD_1, coord: sampleCoord(4), relevance: 0.5 },
				{ id: 'short-coord', coord: wrongWidthCoord(16), relevance: 0.5 },
				{ id: GOOD_2, coord: sampleCoord(5), relevance: 0.5 },
			]
		}

		const merge = (s: CoreFretService, from: string, snap: NeighborSnapshotV1): Promise<void> =>
			(s as unknown as DrivableMerge).mergeAnnounceSnapshot(from, snap)
		const capsOf = (s: CoreFretService): Caps => (s as unknown as DrivableMerge).mergeSnapshotCaps()

		/**
		 * Run a raw announce body through the *same* parser the service wires in at registration —
		 * `makeSnapshotParser(mergeSnapshotCaps())`, built from the service's own caps rather than
		 * from literals — so these tests drive the parser + merge pair production drives, and a
		 * rejection fails loudly here instead of surfacing as a mystery zero count.
		 */
		function parsed(s: CoreFretService, body: Record<string, unknown>): NeighborSnapshotV1 {
			const out = makeSnapshotParser(capsOf(s))(body)
			expect(out, 'an over-long message is truncated, not rejected').to.not.equal(undefined)
			return out!
		}

		/**
		 * Record every id the merge loop upserts, in order.
		 *
		 * `applyTouch` opens with `getById(id) ?? upsert(id, coord)` and the loop has always just
		 * upserted that id, so it does not double-count — a doubled count is the first assumption
		 * to re-check if these numbers ever drift.
		 *
		 * NOTE: this **stacks** wrappers rather than replacing them, and nothing restores. A second
		 * call wraps the first, so a counter installed earlier keeps recording while a later one is
		 * live. Harmless while a test installs one counter (every test below but one), but a test
		 * that drives both merge paths must copy its first array out (`[...ids]`) before installing
		 * the second counter — see the `relevance: null` test. Left stacking deliberately: a
		 * restore handle would change all eight call sites for the benefit of one, and each test
		 * gets a fresh service from `beforeEach` so nothing leaks between them. Revisit if a second
		 * test needs two counters, or if any test ever reuses a service.
		 */
		function countUpserts(s: CoreFretService): string[] {
			const store = s.getStore()
			const holder = store as unknown as CountableStore
			const inner = holder.upsert.bind(store)
			const ids: string[] = []
			holder.upsert = (id: string, coord: Uint8Array): unknown => { ids.push(id); return inner(id, coord) }
			return ids
		}

		/**
		 * A stub stream serving exactly one framed reply.
		 *
		 * The fetch is the simplest of the five senders: `fetchNeighbors` passes no body and does
		 * not half-close, so `rpcRequest` runs open → read → release and `sendFramed` is never
		 * called. Only the async iterator and a resolving `close` are load-bearing — `send` exists
		 * to satisfy the `Stream` type, and `abort` is reached only if that close rejects.
		 */
		function replyStream(body: Record<string, unknown>): Stream {
			const chunks = [json(body)]
			let i = 0
			return {
				id: 'fetch-reply-stub',
				send: (): boolean => true,
				close: async (): Promise<void> => { /* released */ },
				abort: (): void => { /* released */ },
				[Symbol.asyncIterator]: () => ({
					next: async (): Promise<IteratorResult<Uint8Array>> => {
						const c = chunks[i++]
						return c === undefined ? { done: true, value: undefined } : { done: false, value: c }
					},
				}),
			} as unknown as Stream
		}

		/** The private fetch-path entry point — `async`, and it awaits its own merges. */
		interface DrivableFetch {
			fetchAndMergeSnapshot(id: string, signal: AbortSignal | undefined): Promise<string[]>
		}

		/**
		 * Drive one raw snapshot body through the *fetch* path; report the ids it upserted and
		 * the ids it reports as newly seen.
		 *
		 * `openRpcStream` picks an open connection out of `node.getConnections(pid)`, and the
		 * fetch dials `'never'` — so with no connection the whole call is `skipped` and upserts
		 * nothing, a zero count indistinguishable from a cap doing its job. Overriding
		 * `getConnections` on the block's real node is what makes the test prove anything; it is
		 * restored afterwards so teardown still sees the node's own connections. A bare
		 * `{status, newStream}` is not a limited connection (`isLimitedConnection` reads `limits`
		 * then `remoteAddr`), so it is the chosen one.
		 */
		async function fetchMerged(
			node: Libp2p,
			svc: CoreFretService,
			body: Record<string, unknown>
		): Promise<{ ids: string[]; announced: string[] }> {
			const stream = replyStream(body)
			const holder = node as unknown as { getConnections: (p?: PeerId) => Connection[] }
			const real = holder.getConnections.bind(node)
			holder.getConnections = () => [{ status: 'open', newStream: async () => stream }] as unknown as Connection[]
			const ids = countUpserts(svc)
			try {
				const announced = await (svc as unknown as DrivableFetch).fetchAndMergeSnapshot(FROM, undefined)
				return { ids, announced }
			} finally {
				holder.getConnections = real
			}
		}

		// Pinned literally rather than read back out of `mergeSnapshotCaps()`, so the expectation
		// is not derived from the thing under test.
		const profiles: Array<{ profile: 'core' | 'edge'; caps: Caps }> = [
			{ profile: 'core', caps: { successors: 16, predecessors: 16, sample: 8 } },
			{ profile: 'edge', caps: { successors: 8, predecessors: 8, sample: 6 } },
		]

		// Every count below is `1 + successors + predecessors + sample`, one upsert per list entry.
		// That arithmetic holds only while the four id sets are disjoint — a collision would merge
		// as one id and quietly shift every expectation. Pinned here rather than left to the seed
		// ranges above, which are easy to widen into an overlap.
		it('the fixture ids are distinct, which is what the merge-count arithmetic assumes', () => {
			const all = [FROM, ...OVER_SUCC, ...OVER_PRED, ...OVER_SAMPLE.map((e) => e.id)]
			expect(new Set(all).size, 'no id appears in two of the lists').to.equal(all.length)
		})

		for (const { profile, caps: expected } of profiles) {
			describe(profile, () => {
				let node: Libp2p
				let svc: CoreFretService

				beforeEach(async () => {
					node = await createMemNode()
					await node.start()
					// Deliberately left unstarted: no stabilization loops, no handlers registered
					// unless a test asks for them (only the wiring test does, by calling
					// `registerRpcHandlers` directly), and the merge's own detached tail is quiet — `announceToNewPeers` filters
					// targets by `hasAddresses` (empty on an unstarted service, so it dials
					// nothing) and `enforceCapacity` early-returns far below the 2048 capacity.
					svc = new CoreFretService(node, { profile, networkName: NETWORK })
				})

				afterEach(async () => { await stopAll([node]) })

				// `mergeSnapshotCaps()` is deep-equalled against these same literals by
				// `test/announce-rate-limit.spec.ts`, which owns the caps-are-one-source-of-truth
				// claim; re-asserting it here would be a second copy of the numbers to keep in
				// sync. The counts below still fail loudly if the caps drift.
				it('merges exactly 1 + successors + predecessors + sample ids, however long the lists', async () => {
					const ids = countUpserts(svc)

					await merge(svc, FROM, parsed(svc, overCapBody()))

					expect(ids.length, 'one upsert for `from`, then one per capped id').to.equal(
						1 + expected.successors + expected.predecessors + expected.sample
					)
					expect(ids, 'the first N of each list, in merge order').to.deep.equal([
						FROM,
						...OVER_SUCC.slice(0, expected.successors),
						...OVER_PRED.slice(0, expected.predecessors),
						...OVER_SAMPLE.slice(0, expected.sample).map((e) => e.id),
					])
				})

				it('never stores an id past the cap', async () => {
					await merge(svc, FROM, parsed(svc, overCapBody()))
					const store = svc.getStore()

					for (const id of OVER_SUCC.slice(expected.successors)) expect(store.getById(id), `successor past the cap: ${id}`).to.equal(undefined)
					for (const id of OVER_PRED.slice(expected.predecessors)) expect(store.getById(id), `predecessor past the cap: ${id}`).to.equal(undefined)
					for (const e of OVER_SAMPLE.slice(expected.sample)) expect(store.getById(e.id), `sample entry past the cap: ${e.id}`).to.equal(undefined)

					// ...and the last *admitted* id of each list is present, so the absences above
					// are the cap doing its job rather than nothing having been stored at all.
					expect(store.getById(OVER_SUCC[expected.successors - 1]!), 'last admitted successor').to.not.equal(undefined)
					expect(store.getById(OVER_PRED[expected.predecessors - 1]!), 'last admitted predecessor').to.not.equal(undefined)
					expect(store.getById(OVER_SAMPLE[expected.sample - 1]!.id), 'last admitted sample entry').to.not.equal(undefined)
				})

				it('leaves the cap entirely to the parser — a bypassed body is merged whole', async () => {
					// The other side of the single-enforcement-point claim. The merge loop no
					// longer slices, so handing it a raw over-cap body merges every id: proof that
					// the truncation the tests above observe came from the parser and from nowhere
					// else. Not a reachable production path — nothing calls the merge without the
					// parser in front of it — so this is a claim about *where* the cap lives, not
					// a tolerated hole.
					const raw = overCapBody()
					const ids = countUpserts(svc)

					await merge(svc, FROM, raw as unknown as NeighborSnapshotV1)

					expect(ids.length, 'every id, uncapped, once the parser is out of the way').to.equal(
						1 + OVER_SUCC.length + OVER_PRED.length + OVER_SAMPLE.length
					)
					expect(ids.length, 'and that is strictly more than the parsed route merges').to.be.greaterThan(
						1 + expected.successors + expected.predecessors + expected.sample
					)
				})

				it('drops a sample entry whose relevance is not a finite number', () => {
					// `parseSample` is stricter than the merge loops it replaces: the loops read
					// only `id` and `coord`, so a peer whose relevance encodes as `null` (a `NaN`
					// at the sender) used to merge fine. Keeping the strictness is a decision —
					// the wire type declares `relevance: number` as required, so `null` is
					// malformed — and this pins it on the path both merges now share.
					const out = parsed(svc, {
						v: 1, from: FROM, timestamp: Date.now(), successors: [], predecessors: [], sig: '',
						sample: [
							{ id: GOOD_1, coord: sampleCoord(6), relevance: 0.5 },
							{ id: 'null-relevance', coord: sampleCoord(7), relevance: null },
							{ id: GOOD_2, coord: sampleCoord(8), relevance: 0 },
						],
					})

					expect(out.sample?.map((e) => e.id), 'the unusable entry is gone; a relevance of 0 is fine').to.deep.equal([GOOD_1, GOOD_2])
				})

				it('drops a wrong-width sample coord at the parser, so it never reaches onAnnounce', () => {
					const out = parsed(svc, {
						v: 1, from: FROM, timestamp: Date.now(), successors: [], predecessors: [], sig: '',
						sample: shortCoordSample(),
					})

					expect(out.sample, 'the unusable entry is gone; the good ones survive, in order').to.deep.equal([
						{ id: GOOD_1, coord: sampleCoord(4), relevance: 0.5 },
						{ id: GOOD_2, coord: sampleCoord(5), relevance: 0.5 },
					])
				})

				it('re-hashes a sample coordinate from the id, so a bypassed wrong-width coord is merged and ignored', async () => {
					// The coord-width rule is the *parser's* alone. The merge loop never reads
					// `s.coord` — a ring coordinate is derivable from the id, so trusting the wire
					// field would let an authenticated sender place another peer's id anywhere on
					// the ring. Bypassing the parser therefore merges the short-coord entry like
					// any other, at the coordinate its id hashes to.
					const shortId = peerIdStr(183)
					const snap = {
						v: 1, from: FROM, timestamp: Date.now(), sig: '',
						successors: [], predecessors: [],
						sample: [{ id: shortId, coord: wrongWidthCoord(16), relevance: 0.5 }],
					}

					await merge(svc, FROM, snap as unknown as NeighborSnapshotV1)

					const stored = svc.getStore().getById(shortId)
					expect(stored, 'the entry merged; the coordinate was never read').to.not.equal(undefined)
					expect(stored!.coord, 're-hashed from the id, not decoded from the wire').to.deep.equal(
						await hashPeerId(peerIdFromString(shortId))
					)
				})

				it('skips a sample entry whose id will not parse, without costing the message its other ids', async () => {
					// The arm the merge loop's own per-entry try/catch exists for now that the
					// coordinate is re-hashed: `peerIdFromString` throws on an id that is not one,
					// and that entry must drop without costing the message its remaining ids or
					// failing the merge.
					const snap = {
						v: 1, from: FROM, timestamp: Date.now(), sig: '',
						successors: [OVER_SUCC[0]!], predecessors: [OVER_PRED[0]!],
						sample: [
							{ id: GOOD_1, coord: sampleCoord(4), relevance: 0.5 },
							{ id: 'not-a-peer-id', coord: sampleCoord(5), relevance: 0.5 },
							{ id: GOOD_2, coord: sampleCoord(6), relevance: 0.5 },
						],
					}
					const ids = countUpserts(svc)

					await merge(svc, FROM, snap as unknown as NeighborSnapshotV1)

					expect(ids, 'only the unusable entry is skipped').to.deep.equal([FROM, OVER_SUCC[0]!, OVER_PRED[0]!, GOOD_1, GOOD_2])
					expect(svc.getStore().getById('not-a-peer-id'), 'never reached the store write seam').to.equal(undefined)
				})

				it('applies the cap through the handler the service actually registers', async () => {
					// The wiring test, and the only one in this block that is one. Every test above
					// applies `makeSnapshotParser(...)` from the test body, which restates
					// `registerRpcHandlers`' 8th argument rather than proving it — unwire the parser at
					// the registration site and all of them still pass. This one registers the real
					// handlers on a node that records instead of registering, invokes the announce
					// protocol with a raw over-cap frame, and counts the same upserts, so the truncation
					// it observes can only have come from the parser the service wired in.
					const handlers = new Map<string, InboundHandler>()
					;(node as unknown as { handle: (p: string, h: InboundHandler) => Promise<void> }).handle =
						async (protocol, h) => { handlers.set(protocol, h) }
					// Private, and it registers all five protocols. Called directly rather than via
					// `start()`: stabilization and the peerStore seed drag their own upserts into the
					// counter, and this test is about one message's cost.
					await (svc as unknown as { registerRpcHandlers(): Promise<void> }).registerRpcHandlers()

					// The announce handler's `onInbound` hook runs `noteInboundRpc(from)`, which also
					// upserts `from` — detached, racing the merge's own first upsert. It is guarded by
					// `if (!getById(id))`, so seeding `from` first makes it a no-op and the count
					// deterministic. Seeded before the counter is installed so the seed is not itself
					// counted; the merge's own unconditional `upsert(from, ...)` still is.
					svc.getStore().upsert(FROM, new Uint8Array(32).fill(60))

					// `handleAnnounce` detaches the merge, so an upsert count taken around the handler
					// call is not deterministic. Wrap the method on the instance to capture and await
					// the promise it returns; the snapshot still arrives through the real parser, so
					// nothing on the path under test is replaced.
					const merges: Array<Promise<void>> = []
					const drivable = svc as unknown as DrivableMerge
					const innerMerge = drivable.mergeAnnounceSnapshot.bind(svc)
					drivable.mergeAnnounceSnapshot = (from: string, snap: NeighborSnapshotV1): Promise<void> => {
						const p = innerMerge(from, snap)
						merges.push(p)
						return p
					}

					const ids = countUpserts(svc)
					const handler = handlers.get(P.PROTOCOL_NEIGHBORS_ANNOUNCE)
					expect(handler, 'the service registered an announce handler').to.not.equal(undefined)

					// The transport-authenticated remote must equal the body's `from`: the handler drops
					// a mismatch without replying, and the merge would then never run — a silent zero
					// count rather than a visible failure.
					const s = inboundStub([json(overCapBody())])
					await handler!(s.stream, { remotePeer: { toString: () => FROM } } as unknown as Connection)

					expect(merges.length, 'the announce reached the merge at all').to.equal(1)
					await Promise.all(merges)

					expect(ids.length, 'truncated by the parser the service wired in, not by this test').to.equal(
						1 + expected.successors + expected.predecessors + expected.sample
					)
					expect(ids, 'the first N of each list, in merge order').to.deep.equal([
						FROM,
						...OVER_SUCC.slice(0, expected.successors),
						...OVER_PRED.slice(0, expected.predecessors),
						...OVER_SAMPLE.slice(0, expected.sample).map((e) => e.id),
					])

					// ...and nothing past the cap reached the store, so the count above is the cap
					// doing its job rather than the merge having stopped early for some other reason.
					const store = svc.getStore()
					for (const id of OVER_SUCC.slice(expected.successors)) expect(store.getById(id), `successor past the cap: ${id}`).to.equal(undefined)
					for (const id of OVER_PRED.slice(expected.predecessors)) expect(store.getById(id), `predecessor past the cap: ${id}`).to.equal(undefined)
					for (const e of OVER_SAMPLE.slice(expected.sample)) expect(store.getById(e.id), `sample entry past the cap: ${e.id}`).to.equal(undefined)
				})

				it('applies the same caps on the fetch path, and never upserts the snapshot sender', async () => {
					// The fetch path's own cap test — until now its truncation rested on reading
					// the code. Two differences from the announce path above, both load-bearing:
					//
					//   - `fetchAndMergeSnapshot` never upserts `snap.from`, so the expected list
					//     is `successors + predecessors + sample` with no leading `FROM`.
					//   - a body the parser refuses comes back as `decode-error`, which returns
					//     early having upserted nothing. So this deep-equals the full expected id
					//     list rather than asserting `<= cap` — under which a fixture rejected for
					//     some unrelated reason would pass as a cap doing its job.
					const expectedIds = [
						...OVER_SUCC.slice(0, expected.successors),
						...OVER_PRED.slice(0, expected.predecessors),
						...OVER_SAMPLE.slice(0, expected.sample).map((e) => e.id),
					]

					const { ids, announced } = await fetchMerged(node, svc, overCapBody())

					expect(ids, 'the first N of each list, in merge order').to.deep.equal(expectedIds)
					expect(ids, 'the fetch path never upserts the sender').to.not.include(FROM)
					// Every merged id was new to this empty store, so the method's own return
					// value is a second reading of the same truncation.
					expect(announced, 'every merged id was new to this store').to.deep.equal(expectedIds)

					// ...and the store agrees, so the list above is the cap doing its job rather
					// than the merge having stopped early for some other reason.
					const store = svc.getStore()
					expect(store.getById(OVER_SUCC[expected.successors - 1]!), 'last admitted successor').to.not.equal(undefined)
					expect(store.getById(OVER_SUCC[expected.successors]!), 'first successor past the cap').to.equal(undefined)
					expect(store.getById(OVER_PRED[expected.predecessors]!), 'first predecessor past the cap').to.equal(undefined)
					expect(store.getById(OVER_SAMPLE[expected.sample]!.id), 'first sample entry past the cap').to.equal(undefined)
					expect(store.getById(FROM), 'the sender itself was never stored').to.equal(undefined)
				})

				it('drops a `relevance: null` sample entry on both merge paths', async () => {
					// The parser test above pins the drop at the parser; this pins that both merge
					// paths inherit it — which is what makes "the parser is the single enforcement
					// point" a claim about the whole system rather than about one function. The
					// strictness is a decision, not an accident: the wire type declares
					// `relevance: number` as required, so `null` is malformed.
					const body = {
						v: 1, from: FROM, timestamp: Date.now(), successors: [], predecessors: [], sig: '',
						sample: [
							{ id: GOOD_1, coord: sampleCoord(6), relevance: 0.5 },
							{ id: 'null-relevance', coord: sampleCoord(7), relevance: null },
							{ id: GOOD_2, coord: sampleCoord(8), relevance: 0 },
						],
					}

					const counted = countUpserts(svc)
					await merge(svc, FROM, parsed(svc, body))
					// Copied out before the fetch below: `countUpserts` stacks wrappers rather
					// than replacing them, so a counter installed earlier keeps recording while a
					// later one is live.
					const announceIds = [...counted]
					expect(announceIds, 'announce: the sender, then the two usable entries').to.deep.equal([FROM, GOOD_1, GOOD_2])

					// The fetch phase names a *fresh* pair on purpose. Both merge paths record a
					// hearsay id through `noteDiscovered`, which writes only for an id the store
					// does not already hold — so re-merging the announce body would upsert
					// nothing and the assertion below would be measuring that rule instead of the
					// parser's drop, which is what this test is about.
					const fetchBody = {
						...body,
						sample: [
							{ id: GOOD_3, coord: sampleCoord(6), relevance: 0.5 },
							{ id: 'null-relevance-2', coord: sampleCoord(7), relevance: null },
							{ id: GOOD_4, coord: sampleCoord(8), relevance: 0 },
						],
					}
					const { ids: fetchIds } = await fetchMerged(node, svc, fetchBody)
					expect(fetchIds, 'fetch: the two usable entries, and no sender').to.deep.equal([GOOD_3, GOOD_4])

					const store = svc.getStore()
					expect(store.getById('null-relevance'), 'announce: never reached the store').to.equal(undefined)
					expect(store.getById('null-relevance-2'), 'fetch: never reached the store').to.equal(undefined)
				})
			})
		}
	})
})
