import { describe, it } from 'mocha'
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fretIndex from '../src/index.js'

// `openRpcStream` is the one place FRET opens an outbound protocol stream, and it is meant to be
// reusable by consumers. These checks pin the two things that make it actually reachable, not
// merely present somewhere in `src/`:
//   1. the package's `exports` map resolves `.` to the root entry — the file `src/index.ts`
//      re-exports from — with no restrictive subpath that would hide it, and
//   2. that root entry's runtime export surface includes it.
// A self-name `import ... from 'p2p-fret'` would exercise Node's real module resolution, but it
// resolves through the gitignored `dist/` build output — on a fresh clone `yarn typecheck` runs
// before `yarn build` (see root package.json's `check` script), so a test file doing that would
// break typecheck before dist exists. Asserting the `exports` map + root-entry surface instead
// covers the same reachability claim without that build-order hazard.
describe('package public surface', () => {
	it('exports map resolves "." to the root entry with no restrictive subpath', () => {
		const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
		expect(Object.keys(pkg.exports)).to.deep.equal(['.'])
		expect(pkg.exports['.'].types).to.equal('./dist/src/index.d.ts')
		expect(pkg.exports['.'].import).to.equal('./dist/src/index.js')
	})

	it('root entry exports openRpcStream', () => {
		expect(fretIndex.openRpcStream).to.be.a('function')
	})
})
