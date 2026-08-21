import type { PeerDiscovery, Startable } from '@libp2p/interface';
import { peerDiscoverySymbol } from '@libp2p/interface';
import type { Libp2p } from 'libp2p';
import type { FretConfig, FretService, RouteAndMaybeActV1, NearAnchorV1, ReportEvent, SerializedTable } from '../index.js';
import { FretService as CoreFretService } from './fret-service.js';
import { FretPeerDiscovery, type DiscoverySnapshotSource, type FretPeerDiscoveryConfig } from './peer-discovery.js';

type Components = { libp2p?: Libp2p };

/**
 * The subset of the public {@link FretService} surface this libp2p wrapper re-exposes.
 *
 * Declared as a `Pick` rather than left implicit because every method below is a hand-written
 * pass-through: without a structural tie the two surfaces drift silently, which is how the
 * wrapper ended up handing callers `Record<string, any>` metadata after the interface had been
 * tightened. Widening the wrapper means adding a name here, and a signature that no longer
 * matches the interface is now a compile error rather than a difference nobody notices.
 */
type FretServiceFacade = Pick<FretService,
	| 'start' | 'stop' | 'ready' | 'setMode'
	| 'routeAct' | 'neighborDistance' | 'getNeighbors' | 'assembleCohort' | 'expandCohort'
	| 'report' | 'setMetadata' | 'getMetadata' | 'listPeers'
	| 'exportTable' | 'importTable'>;

export class Libp2pFretService implements Startable, FretServiceFacade {
	private inner: CoreFretService | null = null;
	private nodeRef: Libp2p | null = null;
	/**
	 * Built here rather than on demand: libp2p reads `peerDiscoverySymbol` off each service while
	 * constructing the node, which is before {@link setLibp2p} can run. The store it scans is
	 * therefore resolved per tick (see {@link discoverySource}), not captured now.
	 */
	private readonly discovery: FretPeerDiscovery;

	constructor(private readonly components: Components, private readonly cfg?: Partial<FretConfig>, discoveryCfg?: FretPeerDiscoveryConfig) {
		// Profile-tuned debounce-map capacity, merged so an explicit caller value still wins.
		// Core 4096 / Edge 1024. At the default emission rate (batchSize 20 per 5 s = 4/s) the live
		// population under a 600 s debounce is ~2400, so Edge's cap binds before its TTL does: it
		// effectively shortens the debounce to ≈ maxTracked / (batchSize / emissionIntervalMs)
		// ≈ 256 s.
		// That is a memory ceiling and nothing more, which is why the split is kept rather than
		// collapsed: coverage comes from `FretPeerDiscovery`'s ring cursor, not from this map, so a
		// bound that binds early costs only an earlier re-announcement of an already-announced peer.
		// Re-announcement is idempotent in libp2p's peerStore and the outbound rate is hard-capped
		// at batchSize / emissionIntervalMs regardless, so Edge holding fewer entries than Core is
		// exactly what an edge profile should do.
		const profile = cfg?.profile ?? 'core';
		this.discovery = new FretPeerDiscovery(() => this.discoverySource(), {
			...discoveryCfg,
			maxTracked: discoveryCfg?.maxTracked ?? (profile === 'core' ? 4096 : 1024),
		});
	}

	get [Symbol.toStringTag](): string {
		return '@optimystic/fret';
	}

	/**
	 * Allows the hosting application to inject the libp2p node reference
	 * prior to start(). This avoids relying on a libp2p-provided "libp2p"
	 * component which may not exist in some environments.
	 */
	public setLibp2p(node: Libp2p): void {
		this.nodeRef = node;
	}

	/**
	 * The node this service runs on: the injected one, else the `libp2p` component if the host
	 * supplied one. The injection wins because it is the explicit, always-available path; the
	 * component is a fallback rather than the primary source precisely because it is absent in
	 * some environments. Reading it here is what keeps the constructor's `components` a used
	 * field instead of a stored-and-ignored one.
	 */
	private get node(): Libp2p | null {
		return this.nodeRef ?? this.components.libp2p ?? null;
	}

	private ensure(): CoreFretService {
		if (!this.inner) {
			const node = this.node;
			if (!node) {
				throw new Error('Libp2pFretService: libp2p node not injected');
			}
			this.inner = new CoreFretService(node, this.cfg);
		}
		return this.inner;
	}

	/**
	 * What one discovery scan needs, or `null` while the node has not been injected or the core
	 * service has not been built yet. Deliberately does not call {@link ensure} — that throws
	 * pre-injection, and this runs on a timer that must survive the not-ready window.
	 */
	private discoverySource(): DiscoverySnapshotSource | null {
		const core = this.inner as CoreFretService | null;
		const node = this.node;
		if (!core || !node) return null;
		return { store: core.getStore(), selfId: node.peerId.toString() };
	}

	/**
	 * How libp2p itself picks up FRET's discovery: it reads this symbol off each configured
	 * service during node construction and subscribes to the returned object's `peer` events,
	 * merging them into its peerStore. Must stay side-effect free and callable pre-injection.
	 */
	get [peerDiscoverySymbol](): PeerDiscovery {
		return this.discovery;
	}

	/** The same instance libp2p reaches via `peerDiscoverySymbol`, for applications that want to listen directly. */
	getPeerDiscovery(): PeerDiscovery {
		return this.discovery;
	}

	async start(): Promise<void> {
		// `ensure()` throws the not-injected error itself, so no second check is needed here.
		const core = this.ensure();
		await core.start();
		// After core.start(), so the first scan runs against a peerStore-seeded table. libp2p
		// registers a listener for symbol-provided discovery but does not start it, so the
		// explicit start/stop stay ours.
		await this.discovery.start();
	}

	async stop(): Promise<void> {
		await this.discovery.stop();
		await this.inner?.stop();
	}

	async routeAct(msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | { commitCertificate: string }> {
		return await this.ensure().routeAct(msg);
	}

	getNeighborsForKey(
		key: Uint8Array,
		direction: 'left' | 'right' | 'both',
		wants: number
	): string[] {
		return this.ensure().getNeighbors(key, direction, wants);
	}

	assembleCohortForKey(key: Uint8Array, wants: number): string[] {
		return this.ensure().assembleCohort(key, wants);
	}

	getDiagnostics(): ReturnType<CoreFretService['getDiagnostics']> {
		return this.ensure().getDiagnostics();
	}

	neighborDistance(selfId: string, key: Uint8Array, k: number): number {
		return this.ensure().neighborDistance(selfId, key, k);
	}

	getNeighbors(key: Uint8Array, direction: 'left' | 'right' | 'both', wants: number): string[] {
		return this.ensure().getNeighbors(key, direction, wants);
	}

	assembleCohort(key: Uint8Array, wants: number, exclude?: Set<string>): string[] {
		return this.ensure().assembleCohort(key, wants, exclude);
	}

	expandCohort(current: string[], key: Uint8Array, step: number, exclude?: Set<string>): string[] {
		return this.ensure().expandCohort(current, key, step, exclude);
	}

	async ready(): Promise<void> {
		await this.ensure().ready();
	}

	setMode(mode: 'active' | 'passive'): void {
		this.ensure().setMode(mode);
	}

	// Metadata pass-throughs for Arachnode adapter
	setMetadata(metadata: Record<string, unknown>): void {
		this.ensure().setMetadata(metadata);
	}

	report(evt: ReportEvent): void {
		this.ensure().report(evt);
	}

	getMetadata(peerId: string): Record<string, unknown> | undefined {
		return this.ensure().getMetadata(peerId);
	}

	listPeers(): Array<{ id: string; metadata?: Record<string, unknown> }> {
		return this.ensure().listPeers();
	}

	exportTable(): SerializedTable {
		return this.ensure().exportTable();
	}

	importTable(table: SerializedTable): Promise<number> {
		return this.ensure().importTable(table);
	}
}

export function fretService(cfg?: Partial<FretConfig>, discoveryCfg?: FretPeerDiscoveryConfig) {
	return (components: Components & { fret: Libp2pFretService }) => new Libp2pFretService(components as Components, cfg, discoveryCfg);
}
