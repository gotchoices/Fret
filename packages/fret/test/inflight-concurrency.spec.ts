import { describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import type { RouteAndMaybeActV1, NearAnchorV1, BusyResponseV1 } from '../src/index.js'

// `handleMaybeAct` bounds how many inbound maybeAct messages it works on at once with a private
// counter, `inflightAct`: it answers `{busy: true, retry_after_ms: 500}` at the profile limit
// (Core 16 / Edge 4), otherwise increments, routes, and decrements in a `finally`. These tests
// pin that counter by *driving real calls through it* rather than by assigning the field — the
// failure modes are that the counter drifts upward until the service answers busy forever, or
// that the decrement is skipped on the exception path, and neither is observable from a write.
//
// Three facts make this fully deterministic with one node and no network:
//
//  1. A single-node service is in-cluster for every key — after `start()` the store holds only
//     self, seeded `member`, so the key's cohort is `[self]` and `routeAct` awaits the installed
//     activity handler. A handler that blocks on a gate is therefore the lever that holds the
//     counter up.
//  2. Every guard from the token-bucket take down to `inflightAct++` is synchronous, so calling
//     `handleMaybeAct` N times in a plain loop *without awaiting* leaves the counter at exactly
//     the cap when the loop returns, with the surplus already resolved busy. No sleeps, no
//     polling, no timing assumptions — and no `setTimeout` anywhere in this file.
//  3. The maybeAct token bucket (Core 32 / Edge 8) is taken *before* the inflight check and a
//     bucket rejection increments the same `diag.rejected.rateLimited` counter, so the two kinds
//     of busy are indistinguishable in diagnostics. Keeping each fan-out inside bucket capacity
//     is therefore load-bearing for the diagnostic assertion, not a convenience. That fixes the
//     sizes below: Edge 6 (cap 4, 8 tokens) and Core 20 (cap 16, 32 tokens).
//
// Deliberate boundary: these cases call `handleMaybeAct` directly rather than driving real
// streams between two nodes. The counter and its guard live entirely inside that method; the
// inbound stream/handler layer is already pinned by `rpc.handler-fuzz.spec.ts` and
// `rpc.stream-errors.spec.ts`, and a two-node variant would add dial latency and flake without
// observing anything new about the counter.

type ActResult = NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }

const isBusyReply = (r: ActResult): r is BusyResponseV1 => 'busy' in r && r.busy === true
const isCertificate = (r: ActResult): r is { commitCertificate: string } => 'commitCertificate' in r

/**
 * Reading the private counter is the observation this spec is about; *writing* it is what the
 * spec replaces. Narrow structural casts rather than `any` so a rename fails to compile here.
 */
function inflight(svc: CoreFretService): number {
	return (svc as unknown as { inflightAct: number }).inflightAct
}

function dispatch(svc: CoreFretService, msg: RouteAndMaybeActV1): Promise<ActResult> {
	const handler = svc as unknown as { handleMaybeAct(m: RouteAndMaybeActV1): Promise<ActResult> }
	return handler.handleMaybeAct(msg)
}

let correlationSeq = 0

/**
 * Activity-bearing message with a **distinct correlation id per call**: the dedup cache is
 * consulted before the inflight check, so a reused id would return a cached answer without ever
 * touching the counter, silently turning a fan-out of N into a fan-out of 1.
 */
function makeActMsg(): RouteAndMaybeActV1 {
	return {
		v: 1,
		key: 'YWJjZGVm',
		want_k: 3,
		ttl: 5,
		min_sigs: 1,
		activity: 'YWN0aXZpdHk',
		breadcrumbs: [],
		correlation_id: `inflight-${++correlationSeq}`,
		timestamp: Date.now(),
		signature: '',
	}
}

interface Rig {
	svc: CoreFretService
	node: Libp2p
	/** Resolves when {@link Rig.openGate} is called; the activity handler awaits it. */
	gate: Promise<void>
	openGate: () => void
	/** Fan out `n` calls synchronously, without awaiting — see fact 2 in the header. */
	fanOut: (n: number) => Array<Promise<ActResult>>
	teardown: () => Promise<void>
}

async function buildRig(profile: 'core' | 'edge'): Promise<Rig> {
	const node = await createMemNode()
	await node.start()
	const svc = new CoreFretService(node, { profile, k: 7, m: 4 })
	await svc.start()

	let openGate!: () => void
	const gate = new Promise<void>((resolve) => { openGate = resolve })
	const pending: Array<Promise<ActResult>> = []

	const fanOut = (n: number): Array<Promise<ActResult>> => {
		const wave: Array<Promise<ActResult>> = []
		for (let i = 0; i < n; i++) wave.push(dispatch(svc, makeActMsg()))
		pending.push(...wave)
		return wave
	}

	// Teardown always opens the gate first: a failed assertion would otherwise leave the
	// in-flight `handleMaybeAct` promises pending forever and the suite would hang instead of
	// reporting. Stopping the service/node here (rather than on the last line of each case) is
	// what keeps a failure from also tripping the mocha exit watchdog on live timers.
	const teardown = async (): Promise<void> => {
		openGate()
		await Promise.allSettled(pending)
		await svc.stop()
		await node.stop()
	}

	return { svc, node, gate, openGate, fanOut, teardown }
}

interface HandlerLog {
	/** Handler entries, total. */
	calls: number
	/** High-water mark of concurrent entries — equals the cap only if the calls truly overlap. */
	peak: number
}

/** `entered` / `peak` are mutated only from the handler body, which runs on the single JS thread. */
function installGatedHandler(rig: Rig, mode: 'certificate' | 'throw'): HandlerLog {
	const seen: HandlerLog = { calls: 0, peak: 0 }
	let entered = 0
	rig.svc.setActivityHandler(async () => {
		seen.calls++
		entered++
		seen.peak = Math.max(seen.peak, entered)
		try {
			await rig.gate
			if (mode === 'throw') throw new Error('activity handler failed')
			return { commitCertificate: 'ok' }
		} finally {
			entered--
		}
	})
	return seen
}

describe('inbound maybeAct inflight cap', function () {
	this.timeout(10000)

	const profiles: Array<{ profile: 'core' | 'edge'; limit: number; fanOut: number }> = [
		{ profile: 'edge', limit: 4, fanOut: 6 },
		{ profile: 'core', limit: 16, fanOut: 20 },
	]

	for (const p of profiles) {
		it(`${p.profile}: admits exactly ${p.limit} concurrent calls and refuses the surplus`, async () => {
			const rig = await buildRig(p.profile)
			try {
				const seen = installGatedHandler(rig, 'certificate')
				const rateLimitedBefore = rig.svc.getDiagnostics().rejected.rateLimited

				const wave = rig.fanOut(p.fanOut)
				// Still inside the same synchronous turn: no microtask has run, so the counter
				// sits at exactly the cap. A busy reply returns *before* the increment, so this
				// is equality, never `limit + (N - limit)`.
				expect(inflight(rig.svc)).to.equal(p.limit)

				rig.openGate()
				const results = await Promise.all(wave)

				const busy = results.filter(isBusyReply)
				expect(busy).to.have.lengthOf(p.fanOut - p.limit)
				// 500 is the fixed inflight sentinel; the bucket returns its own computed value.
				for (const b of busy) expect(b.retry_after_ms).to.equal(500)

				expect(results.filter(isCertificate)).to.have.lengthOf(p.limit)
				// Equality, not `<=`: the admitted calls were genuinely concurrent inside the
				// handler rather than serialized. This also guards the single-node in-cluster
				// premise the whole spec rests on — if a lone node ever stopped acting for its
				// own keys, every case here would go green-but-vacuous with zero entries.
				expect(seen.peak).to.equal(p.limit)
				// Attributable to the inflight cap because the fan-out stayed inside the bucket.
				expect(rig.svc.getDiagnostics().rejected.rateLimited - rateLimitedBefore)
					.to.equal(p.fanOut - p.limit)
			} finally {
				await rig.teardown()
			}
		})
	}

	it('edge: the counter returns to zero once every call has settled', async () => {
		const rig = await buildRig('edge')
		try {
			const seen = installGatedHandler(rig, 'certificate')
			const wave = rig.fanOut(6)
			expect(inflight(rig.svc)).to.equal(4)

			rig.openGate()
			await Promise.all(wave)

			expect(inflight(rig.svc)).to.equal(0)
			expect(seen.calls).to.equal(4)
		} finally {
			await rig.teardown()
		}
	})

	it('edge: the counter returns to zero when the activity handler throws', async () => {
		const rig = await buildRig('edge')
		try {
			// Gated the same way as the healthy arm: a handler that threw synchronously on entry
			// would free each slot before the next call arrived and the cap would never be reached.
			const seen = installGatedHandler(rig, 'throw')
			const wave = rig.fanOut(6)
			expect(inflight(rig.svc)).to.equal(4)

			rig.openGate()
			const settled = await Promise.allSettled(wave)

			// Every call *resolves*: the handler's throw must not escape `handleMaybeAct`, which
			// catches it and answers via `nearAnchorOnly`. Asserted explicitly rather than only
			// checking the counter — `finally` would decrement even on a rejecting call.
			expect(settled.map((r) => r.status)).to.deep.equal(new Array(6).fill('fulfilled'))
			const results = settled.map((r) => (r as PromiseFulfilledResult<ActResult>).value)

			const admitted = results.filter((r) => !isBusyReply(r))
			expect(admitted).to.have.lengthOf(4)
			for (const r of admitted) {
				expect(isCertificate(r)).to.equal(false)
				expect((r as NearAnchorV1).anchors).to.be.an('array')
			}

			expect(seen.calls).to.equal(4)
			expect(inflight(rig.svc)).to.equal(0)
		} finally {
			await rig.teardown()
		}
	})

	it('edge: a slot freed by a settled call is reusable', async () => {
		const rig = await buildRig('edge')
		try {
			const seen = installGatedHandler(rig, 'certificate')
			const wave = rig.fanOut(6)
			rig.openGate()
			await Promise.all(wave)
			expect(inflight(rig.svc)).to.equal(0)

			// One further call, deliberately not a second full wave of 6: the maybeAct bucket
			// (Edge capacity 8) does not refill fast enough to fund two waves, and draining it
			// would make bucket-busy replies indistinguishable from inflight-busy ones — exactly
			// the ambiguity the fan-out sizes avoid. Do not "strengthen" this into a second wave.
			const [again] = rig.fanOut(1)
			const result = await again!

			// Distinguishes "the counter came back to 0" from "came back to 0 but the service is
			// wedged for some other reason".
			expect(isBusyReply(result)).to.equal(false)
			expect(isCertificate(result)).to.equal(true)
			expect(seen.calls).to.equal(5)
		} finally {
			await rig.teardown()
		}
	})
})
