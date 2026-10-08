import type { PeerDiscovery, PrivateKey, Startable } from '@libp2p/interface';
import { peerDiscoverySymbol } from '@libp2p/interface';
import type { Libp2p } from 'libp2p';
import type { FretConfig, FretMode, FretService, RouteAndMaybeActV1, NearAnchorV1, ReportEvent, SerializedTable, ActivityHandler, LookupOptions, RouteProgress } from '../index.js';
import { FretService as CoreFretService } from './fret-service.js';
import { FretPeerDiscovery, type DiscoverySnapshotSource, type FretPeerDiscoveryConfig } from './peer-discovery.js';

/**
 * What this facade reads off the components libp2p hands every service. `privateKey` is the
 * node's own key (libp2p always supplies it), which the core needs to seal this node's signed
 * address record; taking it from here is what lets the ordinary
 * `libp2p({ services: { fret: fretService() } })` registration sign with no extra wiring.
 */
type Components = { libp2p?: Libp2p; privateKey?: PrivateKey };

/**
 * A libp2p-hosted FRET service: a thin facade whose every method below is a hand-written
 * pass-through to the core service.
 *
 * It implements the whole of {@link FretService} rather than a `Pick` of chosen names, because
 * the two surfaces drift in two independent directions and a `Pick` only catches one of them. A
 * named key list does flag a *signature* that no longer matches — which is how the facade was
 * caught handing callers `Record<string, any>` metadata after the interface had been tightened.
 * But it is structurally blind to the interface *growing*: `Pick<FretService, 'a' | 'b'>` keeps
 * compiling when `FretService` gains a `c`, so a member added to the interface and forgotten here
 * is silent — which is precisely how six members (network-size reporting, churn, partition
 * detection, activity handler, iterative lookup) ended up unreachable through the wrapper.
 * Implementing the interface outright makes that case a compile error at this clause, so both
 * directions of drift are caught by the same rule and neither depends on anyone remembering to
 * edit a key list.
 *
 * One method sits outside the interface by necessity: `getDiagnostics` is not on the public
 * {@link FretService} surface at all, so it is tied to the core the other available way —
 * {@link ensure} is typed as the concrete core class, and the return type is declared as
 * `ReturnType<CoreFretService['getDiagnostics']>`. Casting the receiver to `any` and calling it
 * optionally is the same untied-drift bug in a second dress: it compiles whether or not the core
 * still has the method, and it hands callers an untyped result.
 */
export class Libp2pFretService implements Startable, FretService {
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
			// An explicit config key wins over the component, matching how the node source resolves.
			const privateKey = this.cfg?.privateKey ?? this.components.privateKey;
			this.inner = new CoreFretService(node, { ...this.cfg, ...(privateKey ? { privateKey } : {}) });
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

	/**
	 * Runs the whole shutdown here, ahead of {@link stop}, because this is the last point at which
	 * the leave notices can still go out. libp2p's `stop()` runs every component's `beforeStop()`
	 * first, then every component's `stop()` under one `Promise.all` — and the connection manager's
	 * `stop()` closes every connection inside that same `Promise.all`. A leave fan-out started from
	 * our `stop()` therefore races the closing connections and loses: a peer that listens nowhere
	 * can reach its neighbours only over connections it already holds, so its notices were sent to
	 * nobody. The registrar is still live here, so unhandling works too.
	 */
	async beforeStop(): Promise<void> {
		await this.shutdown();
	}

	/**
	 * A no-op after {@link beforeStop} under libp2p (both halves are idempotent), and the whole
	 * shutdown for a host that drives this facade by hand without a `beforeStop` call.
	 */
	async stop(): Promise<void> {
		await this.shutdown();
	}

	private async shutdown(): Promise<void> {
		await this.discovery.stop();
		await this.inner?.stop();
	}

	async routeAct(msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | { commitCertificate: string }> {
		return await this.ensure().routeAct(msg);
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

	// NOTE: the `return` on the `void`-declared pass-throughs below (`ready`, `setMode`,
	// `setMetadata`, `report`, `reportNetworkSize`, `setActivityHandler`) is deliberate and is
	// load-bearing for a test, not for production: the real core declares these `void` too, so
	// dropping the `return` changes nothing a caller can observe. What it does change is
	// `test/libp2p-facade-forwarding.spec.ts`, which injects a mock core returning a distinct
	// sentinel from *every* method and asserts each facade method hands that exact object back —
	// one uniform exact-forwarding rule over all 20 members rather than a per-method judgement
	// about which returns are worth checking. Deleting a `return` here fails that spec with
	// "<method> return identity"; keep them.
	async ready(): Promise<void> {
		return this.ensure().ready();
	}

	setMode(mode: FretMode): void {
		return this.ensure().setMode(mode);
	}

	// Metadata pass-throughs for Arachnode adapter
	setMetadata(metadata: Record<string, unknown>): void {
		return this.ensure().setMetadata(metadata);
	}

	report(evt: ReportEvent): void {
		return this.ensure().report(evt);
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

	reportNetworkSize(estimate: number, confidence: number, source?: string): void {
		return this.ensure().reportNetworkSize(estimate, confidence, source);
	}

	getNetworkSizeEstimate(): { size_estimate: number; confidence: number; sources: number } {
		return this.ensure().getNetworkSizeEstimate();
	}

	getNetworkChurn(): number {
		return this.ensure().getNetworkChurn();
	}

	detectPartition(): boolean {
		return this.ensure().detectPartition();
	}

	setActivityHandler(handler: ActivityHandler): void {
		return this.ensure().setActivityHandler(handler);
	}

	iterativeLookup(key: Uint8Array, options: LookupOptions): AsyncGenerator<RouteProgress> {
		return this.ensure().iterativeLookup(key, options);
	}
}

export function fretService(cfg?: Partial<FretConfig>, discoveryCfg?: FretPeerDiscoveryConfig) {
	return (components: Components & { fret: Libp2pFretService }) => new Libp2pFretService(components as Components, cfg, discoveryCfg);
}
