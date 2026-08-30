import { afterEach, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { Libp2p } from 'libp2p'
import type { StreamHandlerOptions } from '@libp2p/interface'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { registerRpcHandler } from '../src/index.js'

// Two properties of the registration seam that only hold at the *registrar*, so neither can be
// stated by spying on `node.handle`:
//
//  1. what libp2p ends up storing for a handler registered with no stream caps. libp2p's registrar
//     stores `{ maxInboundStreams: 32, maxOutboundStreams: 64, ...opts }`, so a key present with an
//     `undefined` value overwrites the default rather than falling through to it. A spy sees the
//     options object we passed; only the registrar sees what that spread produced.
//  2. that `runOnLimitedConnection` is really on the stored options — the field libp2p's inbound
//     path reads before invoking a handler over a relayed connection. `rpc.relay-limited-connection`
//     proves the behavior end to end over a real circuit; this proves the *value is stored*, which
//     is the cheap check that stays green on a machine where three-node relay rigs are slow.
//
// Plus a structural guard: `node.handle` must be called from exactly one place in `src/`. That is
// what makes the constant above a property of FRET rather than of five call sites that happen to
// agree today — a protocol registered directly, bypassing the seam, would silently reacquire the
// bug this spec exists to keep fixed.

const NETWORK = 'handler-registration-test'
const PROTOCOL = `/optimystic/${NETWORK}/fret/1.0.0/uncapped`

/** libp2p's own defaults (`DEFAULT_MAX_INBOUND_STREAMS` / `DEFAULT_MAX_OUTBOUND_STREAMS`). */
const LIBP2P_DEFAULT_INBOUND = 32
const LIBP2P_DEFAULT_OUTBOUND = 64

/**
 * The registrar is not on the public `Libp2p` interface, but it is what actually stores the
 * options — and the *stored* options are the thing under test, so reaching for it is the point
 * rather than a shortcut around a nicer API.
 */
function storedOptions(node: Libp2p, protocol: string): StreamHandlerOptions {
	const components = (node as unknown as {
		components?: { registrar?: { getHandler(p: string): { options: StreamHandlerOptions } } }
	}).components
	const registrar = components?.registrar
	if (registrar == null) throw new Error('libp2p node exposes no registrar - this rig needs updating')
	return registrar.getHandler(protocol).options
}

describe('inbound handler registration', function () {
	this.timeout(30000)

	let node: Libp2p

	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
	})

	afterEach(async () => {
		await stopAll([node])
	})

	it('opts every protocol in to relayed (limited) connections', async () => {
		await registerRpcHandler(node, PROTOCOL, async () => {})

		expect(storedOptions(node, PROTOCOL).runOnLimitedConnection,
			'the stored handler options opt in to limited connections').to.equal(true)
	})

	it("leaves libp2p's stream-cap defaults in place when the caller supplies none", async () => {
		// `registerRpcHandler` is public API and its options parameter defaults to `{}`, so this
		// is the shape an outside consumer gets. Passing the two cap keys through as `undefined`
		// would land `undefined` here instead of 32 / 64.
		await registerRpcHandler(node, PROTOCOL, async () => {})

		const options = storedOptions(node, PROTOCOL)
		expect(options.maxInboundStreams, "libp2p's inbound default survives").to.equal(LIBP2P_DEFAULT_INBOUND)
		expect(options.maxOutboundStreams, "libp2p's outbound default survives").to.equal(LIBP2P_DEFAULT_OUTBOUND)
	})

	it('still forwards caps the caller does supply', async () => {
		// The other half of the same rule: omitting *absent* keys must not drop present ones.
		await registerRpcHandler(node, PROTOCOL, async () => {}, { maxInboundStreams: 7 })

		const options = storedOptions(node, PROTOCOL)
		expect(options.maxInboundStreams, 'a supplied cap is forwarded').to.equal(7)
		expect(options.maxOutboundStreams, 'the unsupplied one still defaults').to.equal(LIBP2P_DEFAULT_OUTBOUND)
	})
})

// ---------------------------------------------------------------------------------------------
// Structural guard

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))
/** The one file allowed to call `node.handle`. */
const SEAM_FILE = join('rpc', 'protocols.ts')

function sourceFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) out.push(...sourceFiles(full))
		else if (entry.name.endsWith('.ts')) out.push(full)
	}
	return out
}

/** Every `<something>.handle(...)` call site in one file, as `file:line`. */
function handleCallSites(file: string): string[] {
	const text = readFileSync(file, 'utf-8')
	// A real parse rather than a regex: `.handle(` also appears in prose comments and in the
	// unrelated `unhandle`, and a text match would either miss a reformatted call or invent one.
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
	const sites: string[] = []
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
			&& node.expression.name.text === 'handle') {
			const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
			sites.push(`${relative(SRC_DIR, file).split(sep).join('/')}:${line + 1}`)
		}
		ts.forEachChild(node, visit)
	}
	visit(source)
	return sites
}

describe('registration seam is the only place that calls node.handle', function () {
	it('finds exactly one call site, in the seam', () => {
		const sites = sourceFiles(SRC_DIR).flatMap(handleCallSites)

		// A second site is not automatically wrong — but it is a second place that must remember
		// `runOnLimitedConnection`, and forgetting it there is precisely how a relay-only peer
		// stops answering one protocol while answering the rest. Route it through
		// `registerRpcHandler` (or `registerJsonHandler`) instead of widening this list.
		expect(sites, 'every protocol registers through registerRpcHandler').to.have.lengthOf(1)
		expect(sites[0], 'the one call site is the seam').to.match(
			new RegExp(`^${SEAM_FILE.split(sep).join('/').replaceAll('.', '\\.')}:\\d+$`))
	})
})
