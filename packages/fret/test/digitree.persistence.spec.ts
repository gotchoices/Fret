import { describe, it } from 'mocha'
import fc from 'fast-check'
import { expect } from 'chai'
import { DigitreeStore, type SerializedPeerEntry, type PeerEntry } from '../src/store/digitree-store.js'
import { coordToBase64url } from '../src/ring/hash.js'

function randomCoord(len = 32): Uint8Array {
	const u = new Uint8Array(len)
	for (let i = 0; i < len; i++) u[i] = Math.floor(Math.random() * 256)
	return u
}

function entriesEqual(a: PeerEntry, b: PeerEntry): boolean {
	if (a.id !== b.id) return false
	if (a.coord.length !== b.coord.length) return false
	for (let i = 0; i < a.coord.length; i++) {
		if (a.coord[i] !== b.coord[i]) return false
	}
	return (
		a.relevance === b.relevance &&
		a.lastAccess === b.lastAccess &&
		a.accessCount === b.accessCount &&
		a.successCount === b.successCount &&
		a.failureCount === b.failureCount &&
		a.avgLatencyMs === b.avgLatencyMs
	)
}

describe('DigitreeStore persistence', () => {
	it('round-trips through export/import with no data loss', () => {
		fc.assert(
			fc.property(
				fc.array(fc.string({ minLength: 1, maxLength: 32 }), { minLength: 1, maxLength: 100 }),
				(ids) => {
					const uniq = Array.from(new Set(ids.filter((s) => /^[0-9a-zA-Z]+$/.test(s))))
					if (uniq.length === 0) return true

					const store = new DigitreeStore()
					for (const id of uniq) {
						store.upsert(id, randomCoord())
						store.update(id, {
							relevance: Math.random() * 100,
							accessCount: Math.floor(Math.random() * 50),
							successCount: Math.floor(Math.random() * 30),
							failureCount: Math.floor(Math.random() * 10),
							// Unmeasured is a value the round-trip must preserve, not an absence:
							// restoring it as 0 would hand the peer a perfect-link measurement.
							avgLatencyMs: Math.random() < 0.25 ? null : Math.random() * 500,
						})
					}

					const original = store.list()
					const serialized = store.exportEntries()

					if (serialized.length !== original.length)
						throw new Error(`export length mismatch: ${serialized.length} vs ${original.length}`)

					const restored = new DigitreeStore()
					const count = restored.importEntries(serialized)

					if (count !== original.length)
						throw new Error(`import count mismatch: ${count} vs ${original.length}`)

					const restoredList = restored.list()
					if (restoredList.length !== original.length)
						throw new Error(`restored size mismatch: ${restoredList.length} vs ${original.length}`)

					for (const orig of original) {
						const found = restored.getById(orig.id)
						if (!found) throw new Error(`missing entry after import: ${orig.id}`)
						if (!entriesEqual(orig, found))
							throw new Error(`entry mismatch for ${orig.id}`)
					}

					return true
				}
			)
		)
	})

	it('preserves metadata through round-trip', () => {
		const store = new DigitreeStore()
		store.upsert('peer1', randomCoord())
		store.update('peer1', { metadata: { role: 'validator', version: 3 } })

		const exported = store.exportEntries()
		if (!exported[0]!.metadata || exported[0]!.metadata.role !== 'validator')
			throw new Error('metadata missing from export')

		const restored = new DigitreeStore()
		restored.importEntries(exported)

		const entry = restored.getById('peer1')
		if (!entry?.metadata) throw new Error('metadata missing after import')
		if (entry.metadata.role !== 'validator') throw new Error('metadata.role mismatch')
		if (entry.metadata.version !== 3) throw new Error('metadata.version mismatch')
	})

	it('imported entries have state forced to disconnected', () => {
		const store = new DigitreeStore()
		store.upsert('peer1', randomCoord())
		store.setState('peer1', 'connected')

		const exported = store.exportEntries()
		if (exported[0]!.state !== 'connected')
			throw new Error('expected connected in export')

		const restored = new DigitreeStore()
		restored.importEntries(exported)

		const entry = restored.getById('peer1')
		if (entry!.state !== 'disconnected')
			throw new Error(`expected disconnected after import, got ${entry!.state}`)
	})

	it('exported data survives JSON.stringify/parse round-trip', () => {
		const store = new DigitreeStore()
		for (let i = 0; i < 20; i++) store.upsert(`p${i}`, randomCoord())
		const exported = store.exportEntries()

		const json = JSON.stringify(exported)
		const parsed: SerializedPeerEntry[] = JSON.parse(json)

		const restored = new DigitreeStore()
		const count = restored.importEntries(parsed)
		if (count !== 20) throw new Error(`expected 20, got ${count}`)

		for (const orig of store.list()) {
			const found = restored.getById(orig.id)
			if (!found) throw new Error(`missing ${orig.id} after JSON round-trip`)
			if (!entriesEqual(orig, found))
				throw new Error(`mismatch for ${orig.id} after JSON round-trip`)
		}
	})

	it('neighbor ordering is preserved after import', () => {
		const store = new DigitreeStore()
		const coords: Uint8Array[] = []
		for (let i = 0; i < 10; i++) {
			const coord = new Uint8Array(32)
			coord[0] = i * 25
			coords.push(coord)
			store.upsert(`p${i}`, coord)
		}

		const center = coords[5]!
		const origRight = store.neighborsRight(center, 5)
		const origLeft = store.neighborsLeft(center, 5)

		const exported = store.exportEntries()
		const restored = new DigitreeStore()
		restored.importEntries(exported)

		const restoredRight = restored.neighborsRight(center, 5)
		const restoredLeft = restored.neighborsLeft(center, 5)

		if (JSON.stringify(origRight) !== JSON.stringify(restoredRight))
			throw new Error('right neighbors differ after import')
		if (JSON.stringify(origLeft) !== JSON.stringify(restoredLeft))
			throw new Error('left neighbors differ after import')
	})

	it('rejects a wrong-width coordinate at the write seam', () => {
		const store = new DigitreeStore()
		expect(() => store.upsert('short', randomCoord(31))).to.throw(/32 bytes/)
		expect(() => store.upsert('long', randomCoord(33))).to.throw(/32 bytes/)
		expect(store.size()).to.equal(0)
	})

	it('a malformed record rejects the whole snapshot without importing part of it', () => {
		const good: SerializedPeerEntry = {
			id: 'good',
			coord: coordToBase64url(randomCoord()),
			relevance: 1,
			lastAccess: 1,
			state: 'disconnected',
			accessCount: 0,
			successCount: 0,
			failureCount: 0,
			avgLatencyMs: 0,
		}
		const record = { envelope: 'AAEC', confirmedAt: 1 }
		// Every way a record can be structurally unrepresentable in the store. The service adds
		// its own rows (an envelope that is not a signed record for that peer) on top of these —
		// `service.table-persistence.spec.ts`.
		const corruptions: Array<[string, Partial<SerializedPeerEntry>]> = [
			['a wrong-width coordinate', { coord: coordToBase64url(randomCoord(31)) }],
			['an address-record envelope that is not base64url', { addressRecord: { ...record, envelope: 'not/base64url!' } }],
			['an address-record confirmedAt that is not a finite number', { addressRecord: { ...record, confirmedAt: Number.NaN } }],
		]

		for (const [what, patch] of corruptions) {
			const store = new DigitreeStore()
			// `good` sorts first, so a per-record throw would leave it behind.
			expect(() => store.importEntries([good, { ...good, id: 'bad', ...patch }]), what).to.throw()
			expect(store.size(), what).to.equal(0)
			expect(store.getById('good'), what).to.equal(undefined)
		}
	})

	// `avgLatencyMs: null` means "never measured". Round-tripping it as 0 would hand the
	// restored peer a fabricated perfect-link measurement it never earned.
	it('round-trips an unmeasured latency as null, and a measured 0 ms as 0', () => {
		const store = new DigitreeStore()
		store.upsert('never-pinged', randomCoord())
		store.upsert('instant', randomCoord())
		store.update('instant', { avgLatencyMs: 0 })

		const restored = new DigitreeStore()
		restored.importEntries(store.exportEntries())

		expect(restored.getById('never-pinged')?.avgLatencyMs).to.equal(null)
		expect(restored.getById('instant')?.avgLatencyMs).to.equal(0)
	})

	// A snapshot taken before the field was nullable simply omits it on entries it never
	// measured; there is nothing to restore, so it reads back as unmeasured.
	it('reads a missing avgLatencyMs as unmeasured', () => {
		const record = {
			id: 'legacy',
			coord: coordToBase64url(randomCoord()),
			relevance: 1,
			lastAccess: 1,
			state: 'disconnected',
			accessCount: 0,
			successCount: 0,
			failureCount: 0,
		} as unknown as SerializedPeerEntry

		const store = new DigitreeStore()
		store.importEntries([record])
		expect(store.getById('legacy')?.avgLatencyMs).to.equal(null)
	})
})
