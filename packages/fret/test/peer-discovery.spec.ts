import { describe, it, before, afterEach } from 'mocha';
import { expect } from 'chai';
import fc from 'fast-check';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { FretPeerDiscovery, type DiscoverySnapshotSource } from '../src/service/peer-discovery.js';
import { DigitreeStore } from '../src/store/digitree-store.js';
import { peerDiscoverySymbol, type PeerInfo } from '@libp2p/interface';
import { hashPeerId, coordToBase64url } from '../src/ring/hash.js';
import { createMemNode, stopAll } from './helpers/libp2p.js';
import { starMesh, type Mesh } from './helpers/mesh.js';
import { FretService as CoreFretService } from '../src/service/fret-service.js';
import { Libp2pFretService, fretService } from '../src/service/libp2p-fret-service.js';
import type { SerializedPeerEntry, SerializedTable } from '../src/index.js';
import { createLibp2p, type Libp2p } from 'libp2p';
import { memory } from '@libp2p/memory';
import { plaintext } from '@libp2p/plaintext';
import { yamux } from '@chainsafe/libp2p-yamux';

// Discovery is member-scoped: FretPeerDiscovery.scanOnce only emits peers labeled `member`
// (same-network). These fixtures represent confirmed same-network peers, so mark them member.
function makeStore(ids: string[], coords: Uint8Array[]): DigitreeStore {
	const store = new DigitreeStore();
	for (let i = 0; i < ids.length; i++) {
		store.upsert(ids[i]!, coords[i]!);
		store.setMembership(ids[i]!, 'member');
	}
	return store;
}

/** Collect peer events. Listener is attached BEFORE start, matching libp2p usage. */
async function startAndCollect(
	discovery: FretPeerDiscovery,
	durationMs: number
): Promise<PeerInfo[]> {
	const peers: PeerInfo[] = [];
	const handler = (evt: CustomEvent<PeerInfo>) => { peers.push(evt.detail); };
	discovery.addEventListener('peer', handler);
	await discovery.start();
	await new Promise(r => setTimeout(r, durationMs));
	discovery.removeEventListener('peer', handler);
	return peers;
}

describe('FretPeerDiscovery', function () {
	this.timeout(15000);

	it('implements PeerDiscovery via peerDiscoverySymbol', async () => {
		const store = new DigitreeStore();
		const disc = new FretPeerDiscovery(store);
		expect(disc[peerDiscoverySymbol]).to.equal(disc);
	});

	it('has correct Symbol.toStringTag', () => {
		const store = new DigitreeStore();
		const disc = new FretPeerDiscovery(store);
		expect(disc[Symbol.toStringTag]).to.equal('@optimystic/fret-peer-discovery');
	});

	it('emits peer events for store entries on start', async () => {
		const nodes = await Promise.all([createMemNode(), createMemNode(), createMemNode()]);
		await Promise.all(nodes.map(n => n.start()));

		const ids = nodes.map(n => n.peerId.toString());
		const coords = await Promise.all(nodes.map(n => hashPeerId(n.peerId)));
		const store = makeStore(ids, coords);

		const disc = new FretPeerDiscovery(store, {
			emissionIntervalMs: 200,
			batchSize: 10,
			debounceMs: 60_000,
		});

		const peers = await startAndCollect(disc, 500);
		await disc.stop();
		await stopAll(nodes);

		expect(peers.length).to.be.at.least(3, 'should emit all 3 peers');
		const emittedIds = peers.map(p => p.id.toString());
		for (const id of ids) {
			expect(emittedIds).to.include(id);
		}
	});

	it('does not emit dead peers', async () => {
		const nodes = await Promise.all([createMemNode(), createMemNode()]);
		await Promise.all(nodes.map(n => n.start()));

		const ids = nodes.map(n => n.peerId.toString());
		const coords = await Promise.all(nodes.map(n => hashPeerId(n.peerId)));
		const store = makeStore(ids, coords);
		store.setState(ids[1]!, 'dead');

		const disc = new FretPeerDiscovery(store, {
			emissionIntervalMs: 200,
			batchSize: 10,
			debounceMs: 60_000,
		});

		const peers = await startAndCollect(disc, 500);
		await disc.stop();
		await stopAll(nodes);

		const emittedIds = peers.map(p => p.id.toString());
		expect(emittedIds).to.include(ids[0]!);
		expect(emittedIds).to.not.include(ids[1]!);
	});

	it('emits only member peers, never foreign ones', async () => {
		const nodes = await Promise.all([createMemNode(), createMemNode()]);
		await Promise.all(nodes.map(n => n.start()));

		const ids = nodes.map(n => n.peerId.toString());
		const coords = await Promise.all(nodes.map(n => hashPeerId(n.peerId)));
		const store = new DigitreeStore();
		store.upsert(ids[0]!, coords[0]!); store.setMembership(ids[0]!, 'member');
		store.upsert(ids[1]!, coords[1]!); store.setMembership(ids[1]!, 'foreign');

		const disc = new FretPeerDiscovery(store, {
			emissionIntervalMs: 200,
			batchSize: 10,
			debounceMs: 60_000,
		});

		const peers = await startAndCollect(disc, 500);
		await disc.stop();
		await stopAll(nodes);

		const emittedIds = peers.map(p => p.id.toString());
		expect(emittedIds).to.include(ids[0]!, 'member peer should be emitted');
		expect(emittedIds).to.not.include(ids[1]!, 'foreign peer must never be emitted');
	});

	it('debounces: does not re-emit within debounce window', async () => {
		const nodes = [await createMemNode()];
		await nodes[0]!.start();

		const id = nodes[0]!.peerId.toString();
		const coord = await hashPeerId(nodes[0]!.peerId);
		const store = makeStore([id], [coord]);

		const disc = new FretPeerDiscovery(store, {
			emissionIntervalMs: 100,
			batchSize: 10,
			debounceMs: 60_000,
		});

		const peers = await startAndCollect(disc, 500);
		await disc.stop();
		await stopAll(nodes);

		const matches = peers.filter(p => p.id.toString() === id);
		expect(matches.length).to.equal(1, 'peer should only be emitted once within debounce window');
	});

	it('re-emits after debounce window expires', async () => {
		const nodes = [await createMemNode()];
		await nodes[0]!.start();

		const id = nodes[0]!.peerId.toString();
		const coord = await hashPeerId(nodes[0]!.peerId);
		const store = makeStore([id], [coord]);

		const disc = new FretPeerDiscovery(store, {
			emissionIntervalMs: 100,
			batchSize: 10,
			debounceMs: 300,
		});

		const peers = await startAndCollect(disc, 700);
		await disc.stop();
		await stopAll(nodes);

		const matches = peers.filter(p => p.id.toString() === id);
		expect(matches.length).to.be.at.least(2, 'peer should be re-emitted after debounce expires');
	});

	it('respects batchSize limit per scan', async () => {
		const count = 10;
		const nodes = await Promise.all(Array.from({ length: count }, () => createMemNode()));
		await Promise.all(nodes.map(n => n.start()));

		const ids = nodes.map(n => n.peerId.toString());
		const coords = await Promise.all(nodes.map(n => hashPeerId(n.peerId)));
		const store = makeStore(ids, coords);

		const disc = new FretPeerDiscovery(store, {
			emissionIntervalMs: 60_000,
			batchSize: 3,
			debounceMs: 60_000,
		});

		const peers: PeerInfo[] = [];
		const handler = (evt: CustomEvent<PeerInfo>) => { peers.push(evt.detail); };
		disc.addEventListener('peer', handler);
		await disc.start();
		// Wait briefly for initial scan to complete (synchronous)
		await new Promise(r => setTimeout(r, 50));
		disc.removeEventListener('peer', handler);
		await disc.stop();
		await stopAll(nodes);

		expect(peers.length).to.equal(3, 'first scan should emit exactly batchSize peers');
	});

	// `maxTracked: 2` is deliberately *below* the 5-member population, so the debounce map can
	// never hold the whole ring at once. That is the configuration the old cursorless scan
	// starved on — it restarted at ring index 0 every tick, so members past roughly
	// `maxTracked + batchSize` were emitted never. With the resumed sweep the capacity is a pure
	// memory bound and every member still gets emitted.
	it('debounce map caps at maxTracked and evicts, so an evicted peer is emitted again later', async () => {
		const count = 5;
		const nodes = await Promise.all(Array.from({ length: count }, () => createMemNode()));
		await Promise.all(nodes.map(n => n.start()));
		const ids = nodes.map(n => n.peerId.toString());
		const coords = await Promise.all(nodes.map(n => hashPeerId(n.peerId)));
		const store = makeStore(ids, coords);

		const disc = new FretPeerDiscovery(store, {
			emissionIntervalMs: 100,
			batchSize: 2,
			debounceMs: 60_000,
			maxTracked: 2,
		});

		const emitted: string[] = [];
		const handler = (evt: CustomEvent<PeerInfo>) => { emitted.push(evt.detail.id.toString()); };
		disc.addEventListener('peer', handler);
		await disc.start();
		await new Promise(r => setTimeout(r, 1800));
		disc.removeEventListener('peer', handler);
		await disc.stop();
		await stopAll(nodes);

		const emittedSet = new Set(emitted);
		for (const id of ids) expect(emittedSet.has(id)).to.equal(true, `${id} must eventually be emitted`);

		const counts = new Map<string, number>();
		for (const id of emitted) counts.set(id, (counts.get(id) ?? 0) + 1);
		expect(Array.from(counts.values()).some(c => c > 1)).to.equal(true,
			'an evicted peer must be re-emitted, not dropped forever');
	});

	it('never emits self when the source supplies a self id', async () => {
		const nodes = await Promise.all([createMemNode(), createMemNode()]);
		await Promise.all(nodes.map(n => n.start()));

		const ids = nodes.map(n => n.peerId.toString());
		const coords = await Promise.all(nodes.map(n => hashPeerId(n.peerId)));
		// Self is seeded `member` and lives in the store like any other peer, so only the
		// self filter keeps it out of the emission.
		const store = makeStore(ids, coords);
		const source: DiscoverySnapshotSource = { store, selfId: ids[0]! };

		const disc = new FretPeerDiscovery(() => source, {
			emissionIntervalMs: 100,
			batchSize: 10,
			debounceMs: 60_000,
		});

		const peers = await startAndCollect(disc, 400);
		await disc.stop();
		await stopAll(nodes);

		const emittedIds = peers.map(p => p.id.toString());
		expect(emittedIds).to.not.include(ids[0]!, 'self must never be emitted');
		expect(emittedIds).to.include(ids[1]!, 'the other member should still be emitted');
	});

	it('tolerates a not-yet-ready source, then emits once it resolves', async () => {
		const nodes = [await createMemNode()];
		await nodes[0]!.start();

		const id = nodes[0]!.peerId.toString();
		const coord = await hashPeerId(nodes[0]!.peerId);
		const store = makeStore([id], [coord]);

		// `null` is the state between libp2p node construction and Libp2pFretService.start().
		let source: DiscoverySnapshotSource | null = null;

		const peers: PeerInfo[] = [];
		const handler = (evt: CustomEvent<PeerInfo>) => { peers.push(evt.detail); };
		const disc = new FretPeerDiscovery(() => source, {
			emissionIntervalMs: 100,
			batchSize: 10,
			debounceMs: 60_000,
		});
		disc.addEventListener('peer', handler);
		await disc.start();
		await new Promise(r => setTimeout(r, 250));
		expect(peers.length).to.equal(0, 'no emission while the source is unresolved');

		// Interval must have survived the not-ready ticks.
		source = { store, selfId: 'not-a-peer-in-this-store' };
		await new Promise(r => setTimeout(r, 250));
		disc.removeEventListener('peer', handler);
		await disc.stop();
		await stopAll(nodes);

		expect(peers.map(p => p.id.toString())).to.include(id, 'should emit once the source resolves');
	});

	it('survives a throwing source thunk', async () => {
		const nodes = [await createMemNode()];
		await nodes[0]!.start();

		const id = nodes[0]!.peerId.toString();
		const coord = await hashPeerId(nodes[0]!.peerId);
		const store = makeStore([id], [coord]);

		let boom = true;
		const peers: PeerInfo[] = [];
		const handler = (evt: CustomEvent<PeerInfo>) => { peers.push(evt.detail); };
		const disc = new FretPeerDiscovery(() => {
			if (boom) throw new Error('source not ready');
			return { store, selfId: 'other' };
		}, { emissionIntervalMs: 100, batchSize: 10, debounceMs: 60_000 });
		disc.addEventListener('peer', handler);
		await disc.start();
		await new Promise(r => setTimeout(r, 250));
		expect(peers.length).to.equal(0);

		boom = false;
		await new Promise(r => setTimeout(r, 250));
		disc.removeEventListener('peer', handler);
		await disc.stop();
		await stopAll(nodes);

		expect(peers.map(p => p.id.toString())).to.include(id);
	});

	it('start is idempotent', async () => {
		const store = new DigitreeStore();
		const disc = new FretPeerDiscovery(store, { emissionIntervalMs: 200 });
		await disc.start();
		await disc.start();
		await disc.stop();
	});

	it('stop clears emitted cache and timer', async () => {
		const nodes = [await createMemNode()];
		await nodes[0]!.start();

		const id = nodes[0]!.peerId.toString();
		const coord = await hashPeerId(nodes[0]!.peerId);
		const store = makeStore([id], [coord]);

		const disc = new FretPeerDiscovery(store, {
			emissionIntervalMs: 100,
			batchSize: 10,
			debounceMs: 60_000,
		});

		// Start, wait, stop
		await disc.start();
		await new Promise(r => setTimeout(r, 200));
		await disc.stop();

		// After stop, re-start should re-emit (debounce state cleared)
		const peers = await startAndCollect(disc, 200);
		await disc.stop();
		await stopAll(nodes);

		expect(peers.length).to.be.at.least(1, 'should re-emit after stop/start cycle');
	});

	// `stop` clears the debounce map *and* the sweep cursor. Clearing only the map would still
	// let the test above pass — a 1-peer ring has nowhere else to resume — so this drives ticks
	// directly over a 3-peer ring at `batchSize: 1`, where a retained cursor is visible: it would
	// resume at the third member instead of the first.
	it('stop resets the sweep cursor to the ring start', async () => {
		const nodes = await Promise.all([createMemNode(), createMemNode(), createMemNode()]);
		await Promise.all(nodes.map(n => n.start()));

		const ids = nodes.map(n => n.peerId.toString());
		const coords = await Promise.all(nodes.map(n => hashPeerId(n.peerId)));
		const store = makeStore(ids, coords);
		const ringOrder = store.list().map(e => e.id);

		const disc = new FretPeerDiscovery(store, {
			// Never started, so no timer is armed and the tick source is the calls below.
			emissionIntervalMs: 1_000_000,
			batchSize: 1,
			debounceMs: 60_000,
		});
		const emitted: string[] = [];
		disc.addEventListener('peer', (evt: CustomEvent<PeerInfo>) => {
			emitted.push(evt.detail.id.toString());
		});

		disc.scanOnce();
		disc.scanOnce();
		expect(emitted).to.deep.equal([ringOrder[0]!, ringOrder[1]!], 'sweep should advance in ring order');

		await disc.stop();
		disc.scanOnce();
		await stopAll(nodes);

		expect(emitted[2], 'a fresh run restarts at the ring start').to.equal(ringOrder[0]!);
	});
});

// Coverage is a property over the whole parameter space, not one tuned case — a single tuned
// case is exactly what let the starvation bug ship. The rule: with N live members, a debounce
// capacity of C and a batch of B, *every* member is emitted within a bounded number of ticks,
// for any (N, C, B) — including the N > C region where the old cursorless scan permanently
// starved the ring tail.
//
// Ticks are driven directly rather than through `setInterval`: timing this through the scheduler
// would assert on setTimeout overshoot instead of on the sweep rule, and would turn a ~200-case
// property into minutes of wall clock. Same argument as `ExpiringMap`'s injectable `Clock`.
describe('FretPeerDiscovery ring coverage (property)', function () {
	this.timeout(120_000);

	const POOL = 200;
	/**
	 * Real Ed25519 ids, minted once: `scanOnce` runs `peerIdFromString` on every emission, and
	 * generating 200 keypairs per property case would dominate the run.
	 */
	const pool: Array<{ id: string; coord: Uint8Array }> = [];

	before(async function () {
		this.timeout(120_000);
		for (let i = 0; i < POOL; i++) {
			const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
			pool.push({ id: peerId.toString(), coord: await hashPeerId(peerId) });
		}
	});

	it('emits every live member within a bounded number of ticks, for any (population, maxTracked, batchSize)', () => {
		// A correct sweep covers the ring in one lap plus the partial lap it started mid-way
		// through, so twice the minimum plus slack is comfortable — and a starving sweep never
		// converges at all, so no bound rescues it.
		const tickBound = (n: number, batchSize: number) => 2 * Math.ceil(n / batchSize) + 2;
		const region = { overCapacity: 0, withinCapacity: 0 };

		fc.assert(fc.property(
			fc.integer({ min: 1, max: POOL }),
			fc.integer({ min: 1, max: 200 }),
			fc.integer({ min: 1, max: 50 }),
			(n, maxTracked, batchSize) => {
				const members = pool.slice(0, n);
				const store = makeStore(members.map(m => m.id), members.map(m => m.coord));

				const disc = new FretPeerDiscovery(store, {
					// Never fires — the loop below is the tick source. Not started, so no timer is
					// ever armed and the exit watchdog stays happy.
					emissionIntervalMs: 1_000_000,
					batchSize,
					// Long enough never to lapse, so the capacity rule is what is under test rather
					// than wall-clock expiry (the debounce is driven by real time inside `emitted`).
					debounceMs: 3_600_000,
					maxTracked,
				});

				const emitted = new Set<string>();
				disc.addEventListener('peer', (evt: CustomEvent<PeerInfo>) => {
					emitted.add(evt.detail.id.toString());
				});

				if (n > maxTracked) region.overCapacity++; else region.withinCapacity++;

				const ticks = tickBound(n, batchSize);
				for (let t = 0; t < ticks; t++) disc.scanOnce();

				return emitted.size === n;
			}
		), { numRuns: 200 });

		// Assert on the generated distribution, following `test/nexthop-cost.spec.ts`: a green run
		// that never reached N > maxTracked would say nothing about the region the bug lived in.
		expect(region.overCapacity, 'no over-capacity (population > maxTracked) case was generated')
			.to.be.greaterThan(0);
		expect(region.withinCapacity, 'no within-capacity case was generated').to.be.greaterThan(0);
	});
});

describe('FretPeerDiscovery integration with CoreFretService', function () {
	this.timeout(20000);

	let mesh: Mesh | undefined;

	afterEach(async () => {
		await mesh?.stop();
		mesh = undefined;
	});

	it('emits peers discovered by FretService stabilization', async () => {
		mesh = await starMesh(3);
		const { nodes, services } = mesh;

		await new Promise(r => setTimeout(r, 4000));

		const disc = new FretPeerDiscovery(services[0]!.getStore(), {
			emissionIntervalMs: 200,
			batchSize: 20,
			debounceMs: 60_000,
		});

		const peers = await startAndCollect(disc, 500);
		await disc.stop();

		expect(peers.length).to.be.at.least(2, 'should emit peers from stabilized store');
		const emittedIds = new Set(peers.map(p => p.id.toString()));
		for (let i = 0; i < 3; i++) {
			expect(emittedIds.has(nodes[i]!.peerId.toString())).to.equal(true,
				`should emit node ${i}`);
		}
	});
});

describe('Libp2pFretService discovery wiring', function () {
	this.timeout(20000);

	function serialized(id: string, coord: Uint8Array, membership: 'member' | 'foreign' | 'unknown'): SerializedPeerEntry {
		return {
			id,
			coord: coordToBase64url(coord),
			relevance: 1,
			lastAccess: Date.now(),
			state: 'disconnected',
			membership,
			accessCount: 1,
			successCount: 1,
			failureCount: 0,
			avgLatencyMs: null,
		};
	}

	// libp2p reads this symbol off each service while constructing the node — i.e. before
	// setLibp2p can run — so reading it must not throw and must not build a second instance.
	it('exposes a PeerDiscovery via peerDiscoverySymbol before the node is injected', async () => {
		const svc = new Libp2pFretService({});
		const disc = svc[peerDiscoverySymbol];
		expect(disc).to.be.instanceOf(FretPeerDiscovery);
		expect(typeof disc.addEventListener).to.equal('function');

		const node = await createMemNode();
		await node.start();
		svc.setLibp2p(node);
		expect(svc.getPeerDiscovery()).to.equal(disc, 'getPeerDiscovery must return the same instance');
		await stopAll([node]);
	});

	it('never leaks a foreign or dead peer from a restored routing table', async () => {
		const host = await createMemNode();
		await host.start();
		const others = await Promise.all([createMemNode(), createMemNode(), createMemNode()]);
		const [memberId, foreignId, deadId] = others.map(n => n.peerId.toString()) as [string, string, string];
		const coords = await Promise.all(others.map(n => hashPeerId(n.peerId)));

		const svc = new Libp2pFretService({}, { profile: 'edge', k: 7 }, {
			emissionIntervalMs: 100,
			batchSize: 20,
			debounceMs: 60_000,
		});
		svc.setLibp2p(host);

		const table: SerializedTable = {
			v: 1,
			peerId: host.peerId.toString(),
			timestamp: Date.now(),
			entries: [
				serialized(memberId, coords[0]!, 'member'),
				serialized(foreignId, coords[1]!, 'foreign'),
				serialized(deadId, coords[2]!, 'member'),
			],
		};
		await svc.importTable(table);
		// importTable forces every restored entry to `disconnected` (liveness cannot survive a
		// restart), so the dead arm is applied to the store after import rather than through
		// the snapshot.
		(svc as unknown as { inner: CoreFretService }).inner.getStore().setState(deadId, 'dead');

		const emitted: string[] = [];
		const handler = (evt: CustomEvent<PeerInfo>) => { emitted.push(evt.detail.id.toString()); };
		const disc = svc[peerDiscoverySymbol];
		disc.addEventListener('peer', handler);
		await svc.start();
		await new Promise(r => setTimeout(r, 400));
		disc.removeEventListener('peer', handler);
		await svc.stop();
		await stopAll([...others, host]);

		expect(emitted).to.include(memberId, 'restored member should be emitted');
		expect(emitted).to.not.include(foreignId, 'restored foreign peer must never be emitted');
		expect(emitted).to.not.include(deadId, 'dead peer must never be emitted');
		expect(emitted).to.not.include(host.peerId.toString(), 'self must never be emitted');
	});

	// The claim the whole `peerDiscoverySymbol` wiring rests on: libp2p subscribes to the
	// symbol-provided object during node construction and merges what it hears into its own
	// peerStore. Asserting on the `peer` event alone is one layer short of that, so this test
	// registers FRET the way an application would — in the `services` map — and reads the
	// peerStore. It also pins that a foreign peer never gets there.
	it('a symbol-registered service lands emitted members in libp2p\'s own peerStore', async () => {
		const others = await Promise.all([createMemNode(), createMemNode()]);
		await Promise.all(others.map(n => n.start()));
		const [member, foreign] = others as [Libp2p, Libp2p];
		const coords = await Promise.all(others.map(n => hashPeerId(n.peerId)));

		// `start: false` because the node cannot start until setLibp2p has run — see
		// tickets/plan/21-libp2p-fret-service-cleanup (the service never reads its components).
		const node = await createLibp2p({
			start: false,
			addresses: { listen: [`/memory/fret-symbol-${Date.now()}`] },
			transports: [memory()],
			connectionEncrypters: [plaintext()],
			streamMuxers: [yamux()],
			services: {
				fret: fretService(
					{ profile: 'edge', k: 7 },
					{ emissionIntervalMs: 100, batchSize: 20, debounceMs: 60_000 }
				)
			}
		});
		try {
			const svc = node.services.fret as unknown as Libp2pFretService;
			svc.setLibp2p(node);
			await svc.importTable({
				v: 1,
				peerId: node.peerId.toString(),
				timestamp: Date.now(),
				entries: [
					serialized(member.peerId.toString(), coords[0]!, 'member'),
					serialized(foreign.peerId.toString(), coords[1]!, 'foreign'),
				],
			});
			await node.start();

			// libp2p's discovery handler merges without awaiting, so poll rather than assume.
			let merged = false;
			for (let i = 0; i < 40 && !merged; i++) {
				await new Promise(r => setTimeout(r, 100));
				merged = await node.peerStore.has(member.peerId);
			}
			expect(merged).to.equal(true, 'emitted member must reach libp2p\'s peerStore');
			expect(await node.peerStore.has(foreign.peerId)).to.equal(false,
				'a foreign peer must never reach libp2p\'s peerStore');
		} finally {
			await node.stop();
			await stopAll(others);
		}
	});
});
