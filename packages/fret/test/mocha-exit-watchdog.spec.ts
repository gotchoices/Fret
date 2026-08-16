import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';

// The watchdog is a process-lifetime guard: it only means anything in a process that
// has finished its tests and is deciding whether to die. That is unobservable from
// inside the suite it guards, so each case runs a real child mocha process over a
// fixture and asserts on its exit code and stderr. The child picks up the same
// `.mocharc.json` this package ships, so the wiring is under test too, not just the
// module. `--exit` is deliberately absent: with it, mocha force-quits before the
// watchdog could ever fire.
const packageDir = fileURLToPath(new URL('..', import.meta.url));
const GRACE_MS = 500;

interface ChildResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runFixture(fixture: string): Promise<ChildResult> {
	const child = spawn(
		process.execPath,
		['--import', './register.mjs', 'node_modules/mocha/bin/mocha.js', `test/fixtures/${fixture}`],
		{ cwd: packageDir, env: { ...process.env, FRET_TEST_EXIT_GRACE_MS: String(GRACE_MS) } },
	);
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
	child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
	return new Promise((resolve, reject) => {
		child.on('error', reject);
		child.on('close', code => resolve({ code, stdout, stderr }));
	});
}

describe('mocha exit watchdog', function () {
	// Node startup plus ts-node compilation dominates; the grace period itself is 500ms.
	this.timeout(60_000);

	it('fails the run and names what is still open when the process cannot exit', async () => {
		const { code, stdout, stderr } = await runFixture('exit-watchdog-leak.fixture.ts');
		expect(stdout).to.contain('1 passing');
		expect(code, 'a hung run must fail, not pass').to.equal(1);
		expect(stderr).to.contain('[exit-watchdog]');
		// Proves the env override is honoured — the default would have been 10000ms.
		expect(stderr).to.contain(`${GRACE_MS}ms`);
		// The leaked `setInterval` is what `getActiveResourcesInfo()` should be reporting.
		expect(stderr).to.match(/resources:.*Timeout/);
	});

	it('stays silent and lets a clean run exit on its own', async () => {
		const { code, stdout, stderr } = await runFixture('exit-watchdog-clean.fixture.ts');
		expect(stdout).to.contain('1 passing');
		expect(stderr).to.not.contain('[exit-watchdog]');
		expect(code).to.equal(0);
	});
});
