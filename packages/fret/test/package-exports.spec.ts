import { describe, it } from 'mocha'
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fretIndex from '../src/index.js'
import type { Stream } from '../src/index.js'

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
		// The read side those two bracket, already public before this seam was exported.
		expect(fretIndex.readAllBounded).to.be.a('function')
	})

	it('exports the types the seam signature needs', () => {
		// Type-level, not runtime: a consumer must be able to name `openRpcStream`'s return type
		// without reaching past the package root. Fails `tsc --noEmit`, not mocha, if it regresses.
		const open: (
			...args: Parameters<typeof fretIndex.openRpcStream>
		) => Promise<Stream | undefined> = fretIndex.openRpcStream
		expect(open).to.equal(fretIndex.openRpcStream)
	})
})
