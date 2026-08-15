import { describe, it } from 'mocha'
import { DedupCache } from '../src/service/dedup-cache.js'

describe('DedupCache', () => {
	it('caches and retrieves a value by key', () => {
		const cache = new DedupCache<string>()
		cache.set('a', 'hello')
		if (cache.get('a') !== 'hello') throw new Error('expected cached value')
		if (!cache.has('a')) throw new Error('expected has() to be true')
	})

	it('returns undefined for missing keys', () => {
		const cache = new DedupCache<string>()
		if (cache.get('missing') !== undefined) throw new Error('expected undefined')
		if (cache.has('missing')) throw new Error('expected has() to be false')
	})

	it('expires entries after TTL', async () => {
		const cache = new DedupCache<string>(50) // 50ms TTL
		cache.set('a', 'val')
		if (cache.get('a') !== 'val') throw new Error('expected cached value before TTL')
		await new Promise(r => setTimeout(r, 80))
		if (cache.get('a') !== undefined) throw new Error('expected undefined after TTL')
	})

	it('evicts oldest when at capacity', () => {
		const cache = new DedupCache<number>(30_000, 3)
		cache.set('a', 1)
		cache.set('b', 2)
		cache.set('c', 3)
		cache.set('d', 4) // should evict 'a'
		if (cache.has('a')) throw new Error('expected "a" to be evicted')
		if (cache.get('d') !== 4) throw new Error('expected "d" to be present')
	})

	it('overwrites existing key with new value', () => {
		const cache = new DedupCache<string>()
		cache.set('k', 'v1')
		cache.set('k', 'v2')
		if (cache.get('k') !== 'v2') throw new Error('expected updated value')
	})

	// The refreshed key must NOT be the oldest one. Refreshing the oldest key is the one case the
	// old (buggy) `set` got right by accident — it evicted that key as "oldest" and immediately
	// re-inserted it, so no unrelated entry was lost and a spec written that way passes against
	// the bug it is meant to pin.
	it('refreshing a non-oldest key at capacity does not evict an unrelated entry', () => {
		const cache = new DedupCache<number>(30_000, 3)
		cache.set('a', 1)
		cache.set('b', 2)
		cache.set('c', 3)
		cache.set('b', 22) // overwrite: the map does not grow, so nothing may be evicted
		if (cache.get('b') !== 22) throw new Error('expected refreshed value')
		if (!cache.has('a')) throw new Error('expected "a" to survive refresh of "b"')
		if (!cache.has('c')) throw new Error('expected "c" to survive refresh of "b"')
	})

	// Guards the other half: the refresh must re-insert (delete-then-set), not plain `Map.set`,
	// which leaves the key at its original iteration slot and picks it as the next victim.
	it('a refreshed entry is not treated as the oldest for eviction', () => {
		const cache = new DedupCache<number>(30_000, 3)
		cache.set('a', 1)
		cache.set('b', 2)
		cache.set('c', 3)
		cache.set('a', 11) // refresh 'a' — it should no longer be "oldest"
		cache.set('d', 4) // at capacity: must evict 'b' (now oldest), not 'a'
		if (!cache.has('a')) throw new Error('expected refreshed "a" to survive')
		if (cache.has('b')) throw new Error('expected "b" to be evicted as oldest')
		if (!cache.has('d')) throw new Error('expected "d" to be present')
	})

	it('repeatedly refreshing one key never evicts the others', () => {
		const cache = new DedupCache<number>(30_000, 3)
		cache.set('a', 1)
		cache.set('b', 2)
		cache.set('c', 3)
		for (let i = 0; i < 10; i++) cache.set('b', 100 + i)
		if (cache.get('b') !== 109) throw new Error('expected last refreshed value')
		if (!cache.has('a')) throw new Error('expected "a" to survive repeated refreshes')
		if (!cache.has('c')) throw new Error('expected "c" to survive repeated refreshes')
	})

	// `evictOldest` no longer sweeps for expired entries; its O(1) correctness rests on insertion
	// order and expiry order agreeing under a constant ttlMs. Pin that: at capacity the victim is
	// the oldest-inserted entry, which is therefore also the expired one — never a live entry.
	it('evicts an expired entry rather than a live one when at capacity', async () => {
		const cache = new DedupCache<number>(150, 3)
		cache.set('a', 1) // expires ~t+150
		await new Promise(r => setTimeout(r, 100))
		cache.set('b', 2) // expires ~t+250
		cache.set('c', 3)
		await new Promise(r => setTimeout(r, 80)) // t~180: 'a' expired, 'b'/'c' still live
		cache.set('d', 4) // at capacity: the victim must be the expired 'a'
		if (cache.has('a')) throw new Error('expected expired "a" to be gone')
		if (!cache.has('b')) throw new Error('expected live "b" to survive')
		if (!cache.has('c')) throw new Error('expected live "c" to survive')
		if (!cache.has('d')) throw new Error('expected "d" to be present')
	})

	it('refreshing a key restarts its TTL', async () => {
		const cache = new DedupCache<string>(200)
		cache.set('k', 'v1')
		await new Promise(r => setTimeout(r, 120))
		cache.set('k', 'v2') // restarts the 200ms window
		await new Promise(r => setTimeout(r, 120)) // past 200ms from the first set, not the second
		if (cache.get('k') !== 'v2') throw new Error('expected refreshed entry to still be live')
	})
})
