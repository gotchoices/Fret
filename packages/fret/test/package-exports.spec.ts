import { describe, it } from 'mocha'
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fretIndex from '../src/index.js'
import type { NearAnchorV1, Stream } from '../src/index.js'

// `openRpcStream` is the one place FRET opens an outbound protocol stream, and it is meant to be
// reusable by consumers. These checks pin the three things that make it actually reachable, not
// merely present somewhere in `src/`:
//   1. the package's `exports` map resolves `.` to a single root entry, with no restrictive
//      subpath that would hide it,
//   2. the build maps `src/index.ts` onto exactly that entry (outDir/rootDir), so the surface
//      asserted below is the surface a consumer resolves, and
//   3. that root entry's export surface includes the whole stream seam.
// A self-name `import ... from 'p2p-fret'` would exercise Node's real module resolution, but it
// resolves through the gitignored `dist/` build output — on a fresh clone `yarn typecheck` runs
// before `yarn build` (see root package.json's `check` script), so a test file doing that would
// break typecheck before dist exists. Asserting the exports map + build mapping + root-entry
// surface instead covers the same reachability claim without that build-order hazard.
interface PackageJson {
	main: string
	types: string
	exports: Record<string, { types: string; import: string }>
}
interface TsConfig {
	compilerOptions: { outDir: string; rootDir: string; declaration: boolean }
}

const readJson = <T>(rel: string): T =>
	JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')) as T

describe('package public surface', () => {
	it('exports map resolves "." to the root entry with no restrictive subpath', () => {
		const pkg = readJson<PackageJson>('../package.json')
		expect(Object.keys(pkg.exports)).to.deep.equal(['.'])
		expect(pkg.exports['.'].types).to.equal('./dist/src/index.d.ts')
		expect(pkg.exports['.'].import).to.equal('./dist/src/index.js')
		// `main`/`types` are what a pre-`exports` resolver reads; they must name the same file or
		// the surface a consumer sees depends on its resolver.
		expect(pkg.main).to.equal('dist/src/index.js')
		expect(pkg.types).to.equal('./dist/src/index.d.ts')
	})

	it('build maps src/index.ts onto that entry', () => {
		const tsconfig = readJson<TsConfig>('../tsconfig.json')
		// outDir `dist` + rootDir `.` is what puts `src/index.ts` at `dist/src/index.js`; either
		// one moving silently repoints the exports map at a file that is never emitted.
		expect(tsconfig.compilerOptions.outDir).to.equal('dist')
		expect(tsconfig.compilerOptions.rootDir).to.equal('.')
		expect(tsconfig.compilerOptions.declaration).to.equal(true)
	})

	it('root entry exports the outbound stream seam', () => {
		// Both halves: an opened stream must be released, and the release rule is the half a
		// consumer hand-rolls wrongly when only the opener is reachable.
		expect(fretIndex.openRpcStream).to.be.a('function')
		expect(fretIndex.releaseRpcStream).to.be.a('function')
		// The framed message codec those two bracket: one length-prefixed write, one framed read.
		expect(fretIndex.sendFramed).to.be.a('function')
		expect(fretIndex.readFramed).to.be.a('function')
		// The helper that owns the whole sequence those four compose.
		expect(fretIndex.rpcRequest).to.be.a('function')
	})

	it('root entry exports the wire-shape parsers', () => {
		// Same rationale as the seam above: a consumer registering its own handler over this node
		// otherwise re-derives the shape rules by hand. One spot-check per parser — the module is
		// behaviourally pinned by `test/rpc.codec-properties.spec.ts`, not here.
		expect(fretIndex.parseRouteAndMaybeAct).to.be.a('function')
		expect(fretIndex.parseLeaveNotice).to.be.a('function')
		expect(fretIndex.makeSnapshotParser).to.be.a('function')
		expect(fretIndex.parsePingResponse).to.be.a('function')
		expect(fretIndex.parseNearAnchor).to.be.a('function')
		expect(fretIndex.parseMaybeActReply).to.be.a('function')
		expect(fretIndex.sanitizeReplacements).to.be.a('function')
		// The adapter that wires one of those parsers into `rpcRequest`'s `decode`, plus the way
		// to recognise its rejection. It belongs with the parsers because passing a parser in raw
		// is a silent bug (an `ok` carrying `undefined`), not a compile error.
		expect(fretIndex.parseOrThrow).to.be.a('function')
		expect(fretIndex.ReplyRejectedError).to.be.a('function')
		expect(fretIndex.isReplyRejectedError).to.be.a('function')
		// The pair behaves: a rejection throws the named error, a pass returns the normalized value.
		expect(() => fretIndex.parseOrThrow(fretIndex.parsePingResponse, { ok: 'yes' })).to.throw()
		try {
			fretIndex.parseOrThrow(fretIndex.parsePingResponse, { ok: 'yes' })
			expect.fail('parseOrThrow must throw on a rejected reply')
		} catch (err) {
			expect(fretIndex.isReplyRejectedError(err), 'rejection recognised by identity').to.equal(true)
			expect(err).to.be.instanceOf(fretIndex.ReplyRejectedError)
		}
		expect(fretIndex.parseOrThrow(fretIndex.parsePingResponse, { ok: true })).to.deep.equal({ ok: true })
		// The primitives they are spelled with stay module-scoped — implementation detail, not
		// surface — so a consumer cannot depend on them and they can change without a major.
		expect(fretIndex).to.not.have.property('isPeerIdString')
		expect(fretIndex).to.not.have.property('boundedStringArray')
	})

	it('root entry exports the inbound handler seam', () => {
		// The receive-side mirror of the outbound seam above, and the same argument: a consumer
		// wrapping its own protocol over this node otherwise hand-rolls the release rule, and the
		// hand-rolled copy is what leaks inbound streams. Both halves ship — the raw seam that
		// owns the budgeted close / error abort, and the framed-JSON layer stacked on it.
		expect(fretIndex.registerRpcHandler).to.be.a('function')
		expect(fretIndex.registerJsonHandler).to.be.a('function')
	})

	it('exports the types the seam signature needs', () => {
		// Type-level, not runtime: a consumer must be able to name `openRpcStream`'s return type
		// without reaching past the package root. Fails `tsc --noEmit`, not mocha, if it regresses.
		const open: (
			...args: Parameters<typeof fretIndex.openRpcStream>
		) => Promise<Stream | undefined> = fretIndex.openRpcStream
		expect(open).to.equal(fretIndex.openRpcStream)
		// Same for the request helper's own two types. The parameters are named one by one rather
		// than spread from `Parameters<typeof rpcRequest>`: that tuple instantiates the generic at
		// `T = unknown`, so the assignment would not check what a caller actually writes. Naming
		// `opts` as `RpcRequestOptions<undefined>` drives inference to `T = undefined` instead.
		const req: (
			node: Parameters<typeof fretIndex.rpcRequest>[0],
			peer: string,
			protocol: string,
			opts?: fretIndex.RpcRequestOptions<undefined>
		) => Promise<fretIndex.RpcOutcome<undefined>> = fretIndex.rpcRequest
		expect(req).to.equal(fretIndex.rpcRequest)
		const o: fretIndex.RpcRequestOptions<number> = { maxBytes: 1024 }
		expect(o.maxBytes).to.equal(1024)
		// `Parser<T>` is the one type the parser surface needs a consumer to be able to name: it
		// is what says `undefined` means "rejected" rather than "no value here".
		const parse: fretIndex.Parser<NearAnchorV1> = fretIndex.parseNearAnchor
		expect(parse).to.equal(fretIndex.parseNearAnchor)
		// The inbound seam's two option shapes: without them a consumer can call
		// `registerJsonHandler` but cannot name the object it is passing, so it cannot build one
		// in a typed helper of its own. Naming both also pins which overload each selects — the
		// request shape carries `parse`, the reply-only shape has no `parse` key at all.
		const jsonReq: fretIndex.JsonRequestHandlerOpts<NearAnchorV1, NearAnchorV1> = {
			maxBytes: 1024,
			parse: fretIndex.parseNearAnchor,
			serve: (msg) => msg,
		}
		expect(jsonReq.maxBytes).to.equal(1024)
		const jsonReplyOnly: fretIndex.JsonReplyOnlyHandlerOpts<{ ok: boolean }> = { serve: () => ({ ok: true }) }
		expect(jsonReplyOnly).to.not.have.property('parse')
	})
})
