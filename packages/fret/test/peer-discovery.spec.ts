import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { FretPeerDiscovery } from '../src/service/peer-discovery.js';
import { DigitreeStore } from '../src/store/digitree-store.js';
import { peerDiscoverySymbol, type PeerInfo } from '@libp2p/interface';
import { hashPeerId } from '../src/ring/hash.js';
import { createMemNode, stopAll } from './helpers/libp2p.js';
import { FretService as CoreFretService } from '../src/service/fret-service.js';
import type { Libp2p } from 'libp2p';

function makeStore(ids: string[], coords: Uint8Array[]): DigitreeStore {
	const store = new DigitreeStore();
	for (let i = 0; i < ids.length; i++) {
		store.upsert(ids[i]!, coords[i]!);
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
