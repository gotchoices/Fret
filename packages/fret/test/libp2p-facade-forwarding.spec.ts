import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { Libp2pFretService } from '../src/service/libp2p-fret-service.js'

function coreOf(svc: Libp2pFretService): { inner: unknown } {
	return svc as unknown as { inner: unknown }
}

const SKIP_LIST = ['constructor', 'start', 'beforeStop', 'stop', 'shutdown', 'setLibp2p', 'getPeerDiscovery', 'ensure', 'discoverySource']
// Wrappers whose body has `async` ahead of the ensure() call: a missing core surfaces as a
// rejected promise. Every other method (including importTable, whose wrapper forwards a promise
// but is not itself async) throws synchronously when uninjected.
const REJECTS = new Set(['routeAct', 'ready'])
// Methods whose wrapper returns a Promise that must be awaited to reach the mock's sentinel.
const ASYNC_UNWRAP = new Set(['routeAct', 'ready', 'importTable'])
// iterativeLookup returns a generator object synchronously (not in ASYNC_UNWRAP, so the loop
// below compares its return value directly) — identity-checked, never iterated.

type AnyFn = (...args: unknown[]) => unknown

function protoRecord(): Record<string, unknown> {
	return Libp2pFretService.prototype as unknown as Record<string, unknown>
}

// Uses property descriptors, never direct indexing: Libp2pFretService has a private `get node()`
// accessor whose body dereferences `this.components`, which is undefined on the bare prototype
// object — indexing `proto['node']` directly invokes it and throws.
function enumerateForwardingMethods(): string[] {
	const proto = protoRecord()
	return Object.getOwnPropertyNames(proto)
		.filter(name => typeof Object.getOwnPropertyDescriptor(proto, name)?.value === 'function')
		.filter(name => !SKIP_LIST.includes(name))
}

function sentinelArgs(fn: AnyFn): unknown[] {
	return Array.from({ length: fn.length }, (_, i) => ({ __arg: i }))
}

function call(svc: unknown, name: string, args: unknown[]): unknown {
	return (svc as Record<string, AnyFn>)[name]!(...args)
}

describe('Libp2pFretService — forwarding', function () {
	this.timeout(20_000)

	it('skip list entries all still exist on the prototype', () => {
		const proto = protoRecord()
		for (const name of SKIP_LIST) {
			if (name === 'constructor') continue
			expect(typeof Object.getOwnPropertyDescriptor(proto, name)?.value, name).to.equal('function')
		}
	})

	it('enumerates a non-empty, exactly-20-member forwarding set (getters excluded)', () => {
		const forwarding = enumerateForwardingMethods()
		expect(forwarding.length).to.equal(20)
		expect(forwarding).to.include('getDiagnostics')
		expect(forwarding).to.not.include.members(SKIP_LIST.filter(n => n !== 'constructor'))
	})

	it('forwards every non-skipped method to the core with exact args, order, and return identity', async () => {
		const node = await createMemNode(); await node.start()
		const svc = new Libp2pFretService({ libp2p: node }, { profile: 'core', k: 7 })
		try {
			svc.setMode('passive') // cheap real pass-through: forces ensure() to build the real core once
			const calls: Array<{ name: string; args: unknown[] }> = []
			const proto = protoRecord() as Record<string, AnyFn>
			const methods = enumerateForwardingMethods()
			const sentinels = new Map<string, unknown>()
			const mockCore: Record<string, AnyFn> = {}
			for (const name of methods) {
				const sentinel = { __sentinel: name }
				sentinels.set(name, sentinel)
				mockCore[name] = (...args: unknown[]) => {
					calls.push({ name, args })
					return ASYNC_UNWRAP.has(name) ? Promise.resolve(sentinel) : sentinel
				}
			}
			mockCore.stop = () => {}
			coreOf(svc).inner = mockCore

			for (const name of methods) {
				calls.length = 0
				const args = sentinelArgs(proto[name]!)
				let result = call(svc, name, args)
				if (ASYNC_UNWRAP.has(name)) result = await result
				expect(calls, `${name} called once`).to.have.length(1)
				expect(calls[0]!.name).to.equal(name)
				expect(calls[0]!.args, `${name} args in order`).to.deep.equal(args)
				expect(result, `${name} return identity`).to.equal(sentinels.get(name))
			}
		} finally {
			await svc.stop()
			await stopAll([node])
		}
	})

	it('every non-skipped method fails with the not-injected error when no core exists', async () => {
		const svc2 = new Libp2pFretService({})
		const proto = protoRecord() as Record<string, AnyFn>
		const methods = enumerateForwardingMethods()
		for (const name of methods) {
			const args = sentinelArgs(proto[name]!)
			if (REJECTS.has(name)) {
				let err: unknown
				try { await call(svc2, name, args) } catch (e) { err = e }
				expect(err, `${name} rejects`).to.be.instanceOf(Error)
				expect((err as Error).message, name).to.match(/libp2p node not injected/)
			} else {
				expect(() => call(svc2, name, args), name).to.throw(/libp2p node not injected/)
			}
		}
	})
})
