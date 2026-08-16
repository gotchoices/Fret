import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { FretPeerDiscovery, type DiscoverySnapshotSource } from '../src/service/peer-discovery.js';
import { DigitreeStore } from '../src/store/digitree-store.js';
import { peerDiscoverySymbol, type PeerInfo } from '@libp2p/interface';
import { hashPeerId, coordToBase64url } from '../src/ring/hash.js';
import { createMemNode, stopAll } from './helpers/libp2p.js';
import { FretService as CoreFretService } from '../src/service/fret-service.js';
import { Libp2pFretService, fretService } from '../src/service/libp2p-fret-service.js';
import type { SerializedPeerEntry, SerializedTable } from '../src/index.js';
import { createLibp2p, type Libp2p } from 'libp2p';
import { memory } from '@libp2p/memory';
import { plaintext } from '@libp2p/plaintext';
import { yamux } from '@chainsafe/libp2p-yamux';

// Discovery is now member-scoped: FretPeerDiscovery.scan only emits peers labeled `member`
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

	// NOTE: `maxTracked: 4` against 5 members is deliberate and load-bearing, not an arbitrary
	// number. `scan` restarts at ring index 0 every tick and breaks once `batchSize` peers have
	// been emitted, so for some (population, maxTracked, batchSize) combinations the
	// evict/re-emit churn settles into a stable cycle that never advances far enough to reach
	// the ring-order-last member — at `maxTracked: 3` this exact test starves member #5 forever.
	// That is a real defect in `scan`, tracked by `tickets/fix/bug-discovery-scan-starves-ring-tail`;
	// once the resumable cursor lands, any capacity works and this comment can go.
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
			maxTracked: 4,
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
});

describe('FretPeerDiscovery integration with CoreFretService', function () {
	this.timeout(20000);

	let nodes: Libp2p[] = [];
	let services: CoreFretService[] = [];

	afterEach(async () => {
		for (const s of services) {
			if (!s) continue;
			try { await s.stop(); } catch {}
		}
		await stopAll(nodes.filter(Boolean));
		nodes = [];
		services = [];
	});

	it('emits peers discovered by FretService stabilization', async () => {
		for (let i = 0; i < 3; i++) {
			const node = await createMemNode();
			await node.start();
			nodes.push(node);
		}
		for (let i = 0; i < 3; i++) {
			const boot = i === 0 ? [] : [nodes[0]!.peerId.toString()];
			const svc = new CoreFretService(nodes[i]!, { profile: 'edge', k: 7, bootstraps: boot });
			await svc.start();
			services.push(svc);
		}
		for (let i = 1; i < 3; i++) {
			const ma = nodes[0]!.getMultiaddrs()[0]!;
			await nodes[i]!.dial(ma);
		}

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
