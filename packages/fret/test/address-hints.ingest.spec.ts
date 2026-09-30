import { after, before, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { PeerId, PrivateKey } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id'
import { PeerRecord, RecordEnvelope } from '@libp2p/peer-record'
import { multiaddr } from '@multiformats/multiaddr'
import { toString as u8ToString } from 'uint8arrays/to-string'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { hashPeerId } from '../src/ring/hash.js'
import type { NeighborSnapshotV1 } from '../src/index.js'

// What a received address hint has to prove before it may touch the peerStore.
//
// A hint is `{ id, record }`, where `record` is a libp2p signed peer record. libp2p's own
// `consumePeerRecord` verifies the signature and checks the *signer* against the id we expect —
// but it then patches the record's *payload* peer id blindly, so a peer could sign a record that
// rewrites another peer's addresses. FRET therefore checks `signer === payload.peerId === id`
// itself, before the peerStore ever sees the bytes, and only spends a signature verification on a
// record newer than the one it already holds. This spec pins that contract at the ingestion seam
// (`ingestAddressHints`, driven directly on an unstarted service so no loop can race it):
//
//   - three forgeries, one `it`: a tampered signature, a record about B signed by C, and a genuine
//     C record labelled as B. All three are refused, counted, and leave the peerStore empty.
//   - the positive control, without which the refusals would prove nothing: a genuine record
//     lands in the peerStore and on the entry; a resend and an older record are then skipped with
//     **no** call into `consumePeerRecord` (the no-crypto-on-the-common-path rule), and a newer one
//     replaces the addresses.
//
// The parser-level rules (a hint must name an id the snapshot names, one per id, a decodable
// record under the size cap) live in `rpc.codec-properties.spec.ts`; the end-to-end reproduction
// of Optimystic#11 is `address-hints.relay.spec.ts`.

interface DrivableIngest {
	ingestAddressHints(snap: NeighborSnapshotV1): Promise<void>
	hasAddresses(id: string): boolean
}

describe('address hints — ingestion contract', function () {
	this.timeout(20_000)

	let node: Libp2p
	let svc: CoreFretService
	let keyB: PrivateKey
	let keyC: PrivateKey
	let pidB: PeerId
	let pidC: PeerId
	let idB: string
	let idC: string

	before(async () => {
		node = await createMemNode()
		svc = new CoreFretService(node, { networkName: 'address-hints-ingest', profile: 'core' })
		keyB = await generateKeyPair('Ed25519')
		keyC = await generateKeyPair('Ed25519')
		pidB = peerIdFromPrivateKey(keyB)
		pidC = peerIdFromPrivateKey(keyC)
		idB = pidB.toString()
		idC = pidC.toString()
		// A hint only lands on an entry that exists — ingestion never creates one.
		svc.getStore().upsert(idB, await hashPeerId(pidB))
		svc.getStore().upsert(idC, await hashPeerId(pidC))
	})

	after(async () => {
		await stopAll([node])
	})

	/** A marshaled envelope over a peer record *about* `subject`, signed by `signer`. */
	async function sealRecord(signer: PrivateKey, subject: PeerId, seq: bigint, addr = '/ip4/127.0.0.1/tcp/4001'): Promise<Uint8Array> {
		const record = new PeerRecord({ peerId: subject, multiaddrs: [multiaddr(addr)], seqNumber: seq })
		return (await RecordEnvelope.seal(record, signer)).marshal()
	}

	const hint = (id: string, bytes: Uint8Array): { id: string; record: string } => ({ id, record: u8ToString(bytes, 'base64url') })

	const snapWith = (hints: Array<{ id: string; record: string }>): NeighborSnapshotV1 => ({
		v: 1, from: idB, timestamp: Date.now(), successors: [], predecessors: [], sig: '', hints,
	})

	const ingest = (snap: NeighborSnapshotV1): Promise<void> => (svc as unknown as DrivableIngest).ingestAddressHints(snap)

	/** Addresses the peerStore holds for `id`; `[]` when it has never heard of the peer. */
	async function addressesOf(id: string): Promise<string[]> {
		try {
			return (await node.peerStore.get(peerIdFromString(id))).addresses.map((a) => a.multiaddr.toString())
		} catch (err) {
			if ((err as { name?: string }).name === 'NotFoundError') return []
			throw err
		}
	}

	it('refuses a tampered, a mis-signed and a mislabelled record — none reaches the peerStore', async () => {
		const genuineB = await sealRecord(keyB, pidB, 10n)
		// The signature is the envelope's last protobuf field, so the last byte is signature
		// material: the envelope still decodes, the peek still says "signed by B", and the
		// refusal has to come from the verification itself.
		const tampered = genuineB.slice()
		tampered[tampered.length - 1]! ^= 0xff
		// C signs a record whose payload says it describes B — the case `consumePeerRecord`
		// alone would let through under C's label.
		const signerMismatch = await sealRecord(keyC, pidB, 11n)
		// A perfectly genuine record for C, presented as a hint for B.
		const genuineC = await sealRecord(keyC, pidC, 12n)

		const before = svc.getDiagnostics().rejected.addressHint
		await ingest(snapWith([hint(idB, tampered), hint(idB, signerMismatch), hint(idB, genuineC)]))

		expect(svc.getDiagnostics().rejected.addressHint - before, 'each forgery counted once').to.equal(3)
		expect(await addressesOf(idB), 'no address for B').to.deep.equal([])
		expect(await addressesOf(idC), 'no address for C either — the genuine C record was mislabelled, not accepted under C').to.deep.equal([])
		expect(svc.getStore().getById(idB)?.addressRecord, 'nothing recorded on B').to.equal(undefined)
		expect(svc.getStore().getById(idC)?.addressRecord, 'nothing recorded on C').to.equal(undefined)
	})

	it('accepts a genuine record, skips a resend and an older one without any verification, and takes a newer one', async () => {
		const peerStore = node.peerStore
		const original = peerStore.consumePeerRecord.bind(peerStore)
		let verifications = 0
		peerStore.consumePeerRecord = (async (...args: Parameters<typeof original>) => {
			verifications++
			return original(...args)
		}) as typeof peerStore.consumePeerRecord
		const rejectedBefore = svc.getDiagnostics().rejected.addressHint

		try {
			const genuine = await sealRecord(keyB, pidB, 20n, '/ip4/127.0.0.1/tcp/4001')
			await ingest(snapWith([hint(idB, genuine)]))
			expect(await addressesOf(idB), 'the record\'s address is in the peerStore').to.deep.equal(['/ip4/127.0.0.1/tcp/4001'])
			expect(svc.getStore().getById(idB)?.addressRecord?.envelope, 'the accepted bytes ride on the entry').to.deep.equal(genuine)
			expect((svc as unknown as DrivableIngest).hasAddresses(idB), 'dialable before the next tick').to.equal(true)
			expect(verifications, 'one verification for one new record').to.equal(1)

			// The common path: neighbours re-send the records they hold every tick.
			const older = await sealRecord(keyB, pidB, 19n, '/ip4/10.0.0.1/tcp/1')
			await ingest(snapWith([hint(idB, genuine)]))
			await ingest(snapWith([hint(idB, older)]))
			expect(verifications, 'a resend and an older record cost no verification').to.equal(1)
			expect(await addressesOf(idB), 'and change nothing').to.deep.equal(['/ip4/127.0.0.1/tcp/4001'])

			const newer = await sealRecord(keyB, pidB, 21n, '/ip4/10.0.0.1/tcp/1')
			await ingest(snapWith([hint(idB, newer)]))
			expect(verifications, 'a newer record is verified').to.equal(2)
			expect(await addressesOf(idB), 'and replaces the addresses — the peer\'s own newer statement').to.deep.equal(['/ip4/10.0.0.1/tcp/1'])
			expect(svc.getStore().getById(idB)?.addressRecord?.envelope).to.deep.equal(newer)
			expect(svc.getDiagnostics().rejected.addressHint, 'a stale record is not a rejection').to.equal(rejectedBefore)
		} finally {
			peerStore.consumePeerRecord = original as typeof peerStore.consumePeerRecord
		}
	})
})
