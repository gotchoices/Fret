import { describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { PrivateKey } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { MAX_SELF_RECORD_ADDRS, SelfAddressRecord, decodeAddressRecord, peekPeerRecord, selfRecordAddrs } from '../src/service/address-records.js'

// This node's own signed address record — the rules `docs/fret.md` states under *Address hints*
// that the relay reproduction (`address-hints.relay.spec.ts`) cannot see: there, every node holds
// its reservation *before* FRET starts, so the first seal already carries the reserved address and
// no placeholder is ever listed. What is pinned here instead, against a stub node whose address
// list the test controls:
//
//   - the projection: `/p2p/<self>` stripped, duplicates dropped, the bare `/p2p-circuit`
//     placeholder dropped (nobody can dial it), reserved circuit addresses ahead of direct ones so
//     they survive the `MAX_SELF_RECORD_ADDRS` cap;
//   - the seal: nothing to advertise → no record; a changed list → a new record with a strictly
//     higher sequence number; an unchanged list → the cached string, no new signature;
//   - and the defect found in review: a seal overtaken while signing by a seal for a newer list
//     must not land in the cache last.

const RELAY = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKuF1dLpjNSRUbMhiCsoL'

function stubNode(peerId: PrivateKey, addrs: () => string[]): Libp2p {
	return { peerId: peerIdFromPrivateKey(peerId), getMultiaddrs: () => addrs().map((a) => multiaddr(a)) } as unknown as Libp2p
}

describe('address records — this node\'s own record', () => {
	it('projects the address list: /p2p suffix stripped, deduped, placeholder dropped, reserved circuits first, capped', async () => {
		const key = await generateKeyPair('Ed25519')
		const self = peerIdFromPrivateKey(key).toString()
		const direct = Array.from({ length: MAX_SELF_RECORD_ADDRS }, (_, i) => `/ip4/10.0.0.${i}/tcp/4001`)
		const reserved = `/ip4/127.0.0.1/tcp/9/p2p/${RELAY}/p2p-circuit`
		const node = stubNode(key, () => [
			`/p2p-circuit/p2p/${self}`,        // listen placeholder, no relay hop: undialable
			...direct.map((a) => `${a}/p2p/${self}`),
			direct[0]!,                         // same address without the suffix: a duplicate
			`${reserved}/p2p/${self}`,          // listed last, must come out first
		])
		const out = selfRecordAddrs(node).map((a) => a.toString())
		expect(out).to.have.lengthOf(MAX_SELF_RECORD_ADDRS)
		expect(out[0], 'the reserved circuit address survives the cap').to.equal(reserved)
		expect(out.slice(1)).to.deep.equal(direct.slice(0, MAX_SELF_RECORD_ADDRS - 1))
		expect(out.some((a) => a.includes(`/p2p/${self}`)), 'no address names self').to.equal(false)
	})

	it('seals nothing before a dialable address exists, reseals on change with a higher sequence number, and reuses the cache otherwise', async () => {
		const key = await generateKeyPair('Ed25519')
		const self = peerIdFromPrivateKey(key).toString()
		let addrs: string[] = ['/p2p-circuit']
		const node = stubNode(key, () => addrs)
		const record = new SelfAddressRecord()

		expect(await record.current(node, key), 'a relay-only node before its reservation').to.equal(undefined)

		addrs = [`/ip4/127.0.0.1/tcp/9/p2p/${RELAY}/p2p-circuit/p2p/${self}`]
		const first = await record.current(node, key)
		expect(first, 'a record once the reservation lands').to.be.a('string')
		const peekedFirst = peekPeerRecord(decodeAddressRecord(first!))!
		expect(peekedFirst.signer).to.equal(self)
		expect(peekedFirst.peerId).to.equal(self)
		expect(await record.current(node, key), 'same list, same string').to.equal(first)

		addrs = [...addrs, `/ip4/10.0.0.1/tcp/4001/p2p/${self}`]
		const second = await record.current(node, key)
		expect(second).to.not.equal(first)
		expect(peekPeerRecord(decodeAddressRecord(second!))!.seq > peekedFirst.seq, 'strictly newer, so receivers replace').to.equal(true)
	})

	it('a seal overtaken while signing by a seal for a newer list does not land in the cache last', async () => {
		const key = await generateKeyPair('Ed25519')
		const self = peerIdFromPrivateKey(key).toString()
		// A key whose signature waits on a gate per call, so the test decides which seal
		// finishes first. Everything but `sign` is the real key.
		const gates: Array<() => void> = []
		const gated = new Proxy(key, {
			get(target, prop) {
				if (prop !== 'sign') return Reflect.get(target, prop)
				return async (data: Uint8Array) => {
					await new Promise<void>((resolve) => gates.push(resolve))
					return target.sign(data)
				}
			},
		})
		let addrs = [`/ip4/10.0.0.1/tcp/4001/p2p/${self}`]
		const node = stubNode(key, () => addrs)
		const record = new SelfAddressRecord()

		const older = record.current(node, gated)          // seals list 1; its signature is gated
		addrs = [...addrs, `/ip4/127.0.0.1/tcp/9/p2p/${RELAY}/p2p-circuit/p2p/${self}`]
		const newer = record.current(node, gated)          // seals list 2 while list 1 is in flight
		expect(gates, 'two signatures in flight').to.have.lengthOf(2)
		gates[1]!()                                          // the newer seal finishes first …
		const newerRecord = await newer
		gates[0]!()                                          // … then the overtaken one
		const olderResult = await older

		expect(olderResult, 'the overtaken build gets the newer record, not a stale one').to.equal(newerRecord)
		// A reseal would carry a fresh sequence number and so a different string.
		expect(await record.current(node, key), 'the cache holds the newer record and needs no reseal').to.equal(newerRecord)
	})
})
