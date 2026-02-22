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
})
