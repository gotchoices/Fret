import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createDialOnlyMemNode, createMemNode, stopAll } from './helpers/libp2p.js'
import { waitFor } from './helpers/wait-for.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { hashPeerId } from '../src/ring/hash.js'
import { deadGraceMs, provenTenureMs } from '../src/store/tenure.js'

// A peer this node has watched stay up for a long time is given a grace before it is declared
// dead (`applyContactStrike`, `deadGraceMs`): a server down for a few minutes of maintenance keeps
// its place in the ring, while a peer that just appeared is retired on the usual third strike.
//
// The observer is never started, so its loop cannot race the strikes; each hand-driven pass books
// one uncontactable strike against every member of its window that has neither a connection nor
// an address, exactly as in `address-less-departure.spec.ts`. Long tenure is written into the
// entry's stamps rather than waited for, and the run start is rewound the way the spacing stamp is.
//
// Mutation-checked: dropping the grace condition from the dead verdict reddens the "held through
// its grace" assertions; restoring the old change rule (every strike on a live peer) reddens the
// "not a change" one.

const HOUR = 60 * 60_000

describe('dead-verdict grace for long-tenured peers', function () {
	this.timeout(20000)

	const nodes: Libp2p[] = []
	const svcs: CoreFretService[] = []

	afterEach(async () => {
		for (const s of svcs.splice(0)) {
			try { await s.stop() } catch { /* never started, or already stopped by the test */ }
		}
		await stopAll(nodes.splice(0))
	})

	it('holds a long-tenured peer through its grace, retires a newcomer at once, and lets the held peer resume its session', async () => {
		const b = await createMemNode()
		await b.start()
		nodes.push(b)
		const observer = new CoreFretService(b, { profile: 'core', k: 7, networkName: 'net-test' })
		svcs.push(observer)
		const store = observer.getStore()
		const bAddr = b.getMultiaddrs()[0]!

		// The server's FRET starts only when it comes back: stopped, it answers nothing and, unlike a
		// running service, does not redial the observer and end its own outage.
		const server = await createDialOnlyMemNode()
		await server.start()
		nodes.push(server)
		const serverFret = new CoreFretService(server, { profile: 'core', k: 7, networkName: 'net-test' })
		svcs.push(serverFret)
		const phone = await createDialOnlyMemNode()
		await phone.start()
		nodes.push(phone)
		const serverId = server.peerId.toString()
		const phoneId = phone.peerId.toString()

		for (const n of [server, phone]) {
			await n.dial(bAddr)
			// Stands in for the `peer:connect` and inbound RPC that admit and label a real peer: the
			// observer is not started, and memory nodes run no identify.
			store.upsert(n.peerId.toString(), await hashPeerId(n.peerId))
			store.setMembership(n.peerId.toString(), 'member')
		}
		const sessionStart = Date.now() - 2 * HOUR
		store.update(serverId, { sessionStartedAt: sessionStart, lastProvenAliveAt: Date.now() })
		const grace = deadGraceMs(provenTenureMs(store.getById(serverId)!), 300_000)
		expect(grace, 'premise: two hours watched up earns the full default grace').to.equal(300_000)

		const entry = (id: string) => store.getById(id)!
		const ringViews = async (): Promise<string[]> => observer.getNeighbors(await hashPeerId(b.peerId), 'both', 8)
		const hangUp = async (n: Libp2p): Promise<void> => {
			await n.hangUp(b.peerId)
			await waitFor(() => b.getConnections(n.peerId).length === 0, 5000, 25, 'the observer saw the connection close')
		}
		/** One pass, landing as the independent observation a 1.5 s passive pass would be. */
		const pass = async (): Promise<void> => {
			for (const id of [serverId, phoneId]) store.update(id, { lastContactFailureAt: 0 })
			await (observer as any).stabilizeOnce()
		}

		// ----- outage: both go silent -----
		await hangUp(server)
		await hangUp(phone)
		for (let i = 0; i < 3; i++) await pass()

		expect(entry(phoneId).state, 'a newcomer is retired on the third strike, as before').to.equal('dead')
		expect(entry(serverId).contactFailures, 'the server\'s run reached the threshold').to.equal(3)
		expect(entry(serverId).state, 'but it is held through its grace').to.not.equal('dead')
		expect(await ringViews(), 'and is still a live member of the ring').to.include(serverId)
		expect(observer.getDiagnostics().deadGraceHeld, 'the threshold strike was held').to.equal(1)

		// A held strike at the clamped threshold repeats every pass for the whole grace; were it a
		// change, the idle backoff would stay pinned at its base for minutes.
		const changes = (): number => (observer as any).idle.changes
		const changesBefore = changes()
		await pass()
		expect(observer.getDiagnostics().deadGraceHeld, 'premise: another held strike').to.equal(2)
		expect(changes(), 'a held strike is not a change for the idle backoff').to.equal(changesBefore)

		// ----- maintenance over: the server answers within its grace -----
		await serverFret.start()
		await server.dial(bAddr)
		await waitFor(() => b.getConnections(server.peerId).length > 0, 5000, 25, 'the observer saw the server reconnect')
		const recoveredAt = Date.now()
		await pass() // the near pass pings it over the new connection, and it answers

		expect(entry(serverId).contactFailures, 'the answer cleared the run').to.equal(0)
		expect(entry(serverId).contactRunStartedAt, 'and its start stamp').to.equal(0)
		expect(entry(serverId).state).to.not.equal('dead')
		expect(entry(serverId).sessionStartedAt, 'the session continued rather than restarting').to.equal(sessionStart)

		// ----- a second outage measures its own grace, and the verdict lands once it has lasted it -----
		await serverFret.stop()
		await hangUp(server)
		for (let i = 0; i < 3; i++) await pass()

		expect(entry(serverId).state, 'held again').to.not.equal('dead')
		expect(entry(serverId).contactRunStartedAt, 'from this run\'s first strike, not the last run\'s').to.be.at.least(recoveredAt)

		store.update(serverId, { contactRunStartedAt: Date.now() - grace })
		await pass()

		expect(entry(serverId).state, 'a run that has lasted the grace is a completed one').to.equal('dead')
		expect(await ringViews(), 'out of the ring views').to.not.include(serverId)
	})
})
