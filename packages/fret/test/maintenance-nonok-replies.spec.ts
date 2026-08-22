import { expect } from 'chai';
import { buildMaintenanceRig, type MaintenanceRig } from './helpers/maintenance-rig.js';
import { backoffOf } from './helpers/backoff.js';

/**
 * The near maintenance pass against a peer that **answers badly**.
 *
 * Headline: *an answer that is not a good answer is still an answer.* A `busy` refusal, a negative
 * pong (`ok: false`) and a framed-but-undecodable reply all arrived over this network's namespaced
 * protocol, so each confirms membership, each clears any contact-failure run, and **none** books a
 * contact strike. A strike leaking in is the regression this spec exists to catch: three of them
 * mark the peer `dead`, which silently drops it out of every ring view.
 *
 * Deliberately a new spec rather than an addition to an existing one. `failure-recovery.spec.ts`
 * owns the unreachable / timeout arc across two real nodes with a fake clock and does not use the
 * rig; `stabilize-concurrency.spec.ts` owns pool shape (cap, ordering, disjointness, budgets)
 * rather than per-arm scoring; `fetch-snapshot-failure-arms.spec.ts` calls `fetchAndMergeSnapshot`
 * directly, one arm at a time, against its own connection stub. The fourth case below is the
 * whole-tick composition none of those cover: the ping half scores while the fetch half stays
 * silent, both observed through one `stabilizeOnce`.
 *
 * All four cases seed **one** near peer as a live `member` (well inside the near budget of 4, so
 * nothing is truncated out of the tick and misread as "scored nothing") and drive exactly one
 * `stabilizeOnce`. The rig never starts the service, so the tick is driven directly — a live loop
 * would race the assertions. Phase 2 still runs, but with no `unknown` / `foreign` / `dead` entry
 * seeded it selects no targets, so every recorded contact belongs to the near pass.
 *
 * Two measurement rules these cases must follow, each learned by writing the assertion the other
 * way first:
 *
 * - **Read diagnostics as scalars, never as an object snapshot.** `getDiagnostics()` returns the
 *   service's live `diag` object, not a copy, so a "before" reference and an "after" reference are
 *   the same object and every delta computes as 0 — an assertion that passes vacuously in the one
 *   direction it was written to catch.
 * - **The decay arms are asserted on `failureCount`, not on `relevance`.** Stored relevance is only
 *   ever written by a scoring call, so a freshly seeded entry sits at 0 and the *first* call raises
 *   it whatever the arm — `applyFailure` recomputes `base · S(x)` from the counters rather than
 *   multiplying the stored value down. `failureCount` is the input that actually distinguishes the
 *   decay arms from the credit arm, and the strike counter (`contactFailures`) is what distinguishes
 *   both from an escalation. Relevance is still asserted where it is unambiguous: exactly unchanged
 *   on the busy ping (which scores nothing at all), and raised on the answering ping of case four.
 */
describe('maintenance: replies that are answers but not good answers', () => {
	let r: MaintenanceRig;

	// Core for the scoring assertions: its near budget (4) and pool cap (6) both sit above the one
	// peer these cases seed, so neither can truncate the arm under test. The arms themselves are
	// profile-independent.
	beforeEach(async () => { r = await buildMaintenanceRig('core'); });
	afterEach(async () => { await r.teardown(); });

	interface Snap { relevance: number; contactFailures: number; successCount: number; failureCount: number }

	/** Everything an arm asserts against, read as scalars so a later read cannot alias this one. */
	function snap(id: string): Snap {
		const e = r.store.getById(id);
		expect(e, 'seeded peer is in the store').to.not.equal(undefined);
		return {
			relevance: e!.relevance,
			contactFailures: e!.contactFailures ?? 0,
			successCount: e!.successCount,
			failureCount: e!.failureCount,
		};
	}

	/** Ping counters as scalars — see the diagnostics rule in the file header. */
	function pings(): { sent: number; ok: number; fail: number; fetched: number } {
		const d = r.svc.getDiagnostics();
		return { sent: d.pingsSent, ok: d.pingsOk, fail: d.pingsFail, fetched: d.snapshotsFetched };
	}

	async function tick(): Promise<void> {
		await (r.svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce();
	}

	/**
	 * The assertions every arm shares: the peer answered, so it is a confirmed member with its
	 * contact-failure run cleared and no escalation — and the fetch was still attempted after the
	 * ping, because `probeAndFetch` skips the fetch only for a peer that did *not* answer.
	 */
	function expectAnsweredNotStruck(id: string): void {
		const after = r.store.getById(id)!;
		expect(after.contactFailures ?? 0, 'an answer clears the contact-failure run and books no strike').to.equal(0);
		expect(after.membership, 'an answer on our protocol confirms membership').to.equal('member');
		expect(after.state, 'no strike, so no escalation to dead').to.not.equal('dead');

		// Per-peer ordering only: `opened` is append-ordered per peer, and pool overlap can reorder
		// recordings across peers.
		const seen = r.rig.protocolsSeenBy(id);
		expect(seen, 'the ping ran').to.include(r.ping());
		expect(seen, 'the peer answered, so the fetch still runs').to.include(r.neighbors());
		expect(seen.indexOf(r.ping()), 'ping precedes fetch for this peer').to.be.lessThan(seen.indexOf(r.neighbors()));
	}

	it('a busy ping records backoff, clears the contact-failure run, and books no strike', async () => {
		// A pre-seeded run is what makes "clears the run" observable at all: seeding 0 would assert
		// it vacuously.
		const [id] = await r.seedPeers(1, 'member', { contactFailures: 2 });
		r.rig.setProtocolBehavior(id!, r.ping(), 'busy');
		const before = snap(id!);
		expect(before.contactFailures, 'pre-seeded run is observable').to.equal(2);
		const p0 = pings();

		await tick();

		const after = snap(id!);
		// Busy is the one near-pass arm that records backoff — the peer said it is overloaded. Only
		// that a window was opened is asserted; the factor it lands on is
		// `debt-backoff-map-test-surface`.
		expect(backoffOf(r.svc).factor(id!), 'busy records probe backoff').to.be.greaterThan(0);
		// Busy scores nothing at all — no credit, no decay — so the stored value is untouched. This
		// is the one arm where relevance itself is an unambiguous assertion.
		expect(after.relevance, 'busy neither credits nor decays relevance').to.equal(before.relevance);
		expect(after.successCount, 'busy is not a good reply').to.equal(before.successCount);
		expect(after.failureCount, 'busy takes no decay arm either').to.equal(before.failureCount);
		expectAnsweredNotStruck(id!);

		const p = pings();
		expect(p.sent - p0.sent, 'the ping was sent').to.equal(1);
		expect(p.fail - p0.fail, 'busy counts as a failed ping').to.equal(1);
		expect(p.ok - p0.ok, 'busy is not a good ping').to.equal(0);
	});

	it('a negative pong (ok: false) takes the decay arm, books no strike, and records no backoff', async () => {
		const [id] = await r.seedPeers(1, 'member', { contactFailures: 2 });
		r.rig.setProtocolBehavior(id!, r.ping(), 'not-ok');
		const before = snap(id!);
		const p0 = pings();

		await tick();

		const after = snap(id!);
		// `applyFailure`: the peer's own negative pong is a bad reply, so it is scored down rather
		// than credited. See the file header for why the counter, not the score, is the assertion.
		expect(after.failureCount, "the peer's own negative pong takes the decay arm").to.equal(before.failureCount + 1);
		expect(after.successCount, 'a negative pong is not a success').to.equal(before.successCount);
		expect(backoffOf(r.svc).factor(id!), 'only busy records backoff in the near pass').to.equal(0);
		expectAnsweredNotStruck(id!);

		const p = pings();
		expect(p.sent - p0.sent, 'the ping was sent').to.equal(1);
		expect(p.fail - p0.fail, 'a negative pong counts as a failed ping').to.equal(1);
		expect(p.ok - p0.ok, 'a negative pong is not a good ping').to.equal(0);
	});

	it('an undecodable ping reply takes the decay arm, books no strike, and records no backoff', async () => {
		const [id] = await r.seedPeers(1, 'member', { contactFailures: 2 });
		r.rig.setProtocolBehavior(id!, r.ping(), 'undecodable');
		const before = snap(id!);
		const p0 = pings();

		await tick();

		const after = snap(id!);
		// `decode-error` takes the decay-only arm of `noteRpcFailure`: the bytes were unusable, but
		// they arrived over a protocol only this network's peers serve, so it is decay without a
		// strike — the distinction this whole spec exists to hold.
		expect(after.failureCount, 'a decode error takes the decay arm').to.equal(before.failureCount + 1);
		expect(after.successCount, 'a decode error is not a success').to.equal(before.successCount);
		expect(backoffOf(r.svc).factor(id!), 'only busy records backoff in the near pass').to.equal(0);
		expectAnsweredNotStruck(id!);

		const p = pings();
		expect(p.sent - p0.sent, 'the ping was sent').to.equal(1);
		expect(p.fail - p0.fail, 'a decode error counts as a failed ping').to.equal(1);
	});

	it('a busy neighbors fetch behind an answering ping is silent: the ping scores, the fetch does not', async () => {
		const [id] = await r.seedPeers(1, 'member', { contactFailures: 2 });
		// Ping answers normally (the rig default); only the fetch refuses.
		r.rig.setProtocolBehavior(id!, r.neighbors(), 'busy');
		const before = snap(id!);
		const p0 = pings();

		await tick();

		const after = snap(id!);
		// Ping half: an `ok: true` pong is the good-reply path, so it is credited and no backoff is
		// recorded. Relevance rising is unambiguous here — the credit arm is the only one that ran.
		expect(after.successCount, 'the ping half scores normally').to.equal(before.successCount + 1);
		expect(after.relevance, 'a credited ping raises relevance').to.be.greaterThan(before.relevance);
		expect(backoffOf(r.svc).factor(id!), 'the ping answered well, so no backoff').to.equal(0);

		const p = pings();
		expect(p.sent - p0.sent, 'the ping was sent').to.equal(1);
		expect(p.ok - p0.ok, 'the ping answered well').to.equal(1);

		// Fetch half: `fetchAndMergeSnapshot`'s `busy` arm is deliberately silent — it preserves the
		// bookkeeping of the old fabricated-empty-snapshot path. It scores nothing and does not count
		// the fetch. (Its sibling `decode-error` arm behaves identically; both are owned arm-by-arm by
		// `fetch-snapshot-failure-arms.spec.ts`. What this case pins is the whole-tick composition:
		// one half scoring while the other stays silent.)
		expect(p.fetched - p0.fetched, 'a busy fetch is not a fetched snapshot').to.equal(0);
		expect(after.failureCount, 'the busy fetch scored nothing against the peer').to.equal(before.failureCount);
		expectAnsweredNotStruck(id!);
	});
});
