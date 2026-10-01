/**
 * Tests for the post-publish wait's pure half (`scripts/published-visibility.js`), run by node's
 * built-in test runner (`yarn test:scripts`, part of `yarn test`). The wait itself —
 * `scripts/await-published.js`, which runs npm and sets the exit code — is not imported here.
 *
 * No test touches the network: the `npm view` outputs below are copied from real runs against the
 * public registry, and the registry question the wait asks is injected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
	NOT_YET_VISIBLE,
	TARBALL_NOT_YET_DOWNLOADABLE,
	expectedPackages,
	npmViewCommand,
	publishedPackageDirs,
	readTarballAnswer,
	readViewAnswer,
	waitForVisibility
} from './published-visibility.js';

const FRET = { name: 'p2p-fret', version: '1.0.0-beta.4' };
const OTHER = { name: '@example/other', version: '1.0.0-beta.4' };
const THIRD = { name: 'third', version: '1.0.0-beta.4' };

describe('publishedPackageDirs', () => {
	it('reads the directories this repository\'s own `pub` publishes', () => {
		const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

		assert.deepEqual(publishedPackageDirs(scripts), ['fret']);
	});

	it('follows `yarn pub:*` steps, in order, and accepts a direct publish step', () => {
		const scripts = {
			pub: 'yarn pub:core && node scripts/publish-package.js tools/viz',
			'pub:core': 'node scripts/publish-package.js core'
		};

		assert.deepEqual(publishedPackageDirs(scripts), ['core', 'tools/viz']);
	});

	it('refuses a step it cannot read rather than waiting for less than `pub` publishes', () => {
		assert.throws(() => publishedPackageDirs({ pub: 'yarn build && yarn pub:core', 'pub:core': 'node scripts/publish-package.js core' }), /cannot tell what it publishes/);
		assert.throws(() => publishedPackageDirs({ pub: 'yarn pub:gone' }), /'pub' runs 'pub:gone', which is not a script/);
		assert.throws(() => publishedPackageDirs({}), /no 'pub' script/);
	});
});

describe('expectedPackages', () => {
	it('pairs each directory with the name and version in its own manifest', () => {
		const manifests = { fret: { name: FRET.name, version: FRET.version } };

		assert.deepEqual(expectedPackages(['fret'], (dir) => manifests[dir]), [FRET]);
	});

	it('refuses a manifest with no version to wait for', () => {
		assert.throws(() => expectedPackages(['fret'], () => ({ name: FRET.name })), /names no publishable version/);
	});
});

describe('npmViewCommand', () => {
	it('refuses a version carrying a character cmd.exe would interpret', () => {
		assert.throws(() => npmViewCommand({ name: FRET.name, version: '1.0.0&calc' }, 'win32'), /is not a version/);
	});
});

describe('readViewAnswer', () => {
	const E404 = JSON.stringify({ error: { code: 'E404', summary: 'No match found for version 1.0.0-beta.4' } }, null, 2);

	it('reads the version echoed back as listed, with the URL of its tarball', () => {
		const tarball = 'https://registry.npmjs.org/p2p-fret/-/p2p-fret-1.0.0-beta.4.tgz';
		const listing = JSON.stringify({ version: '1.0.0-beta.4', 'dist.tarball': tarball }, null, 2);

		assert.deepEqual(readViewAnswer({ status: 0, stdout: `${listing}\n`, stderr: '' }, FRET), { listed: true, tarball });
	});

	it('does not count the version as listed while npm names no tarball for it', () => {
		// npm prints a lone field's value bare, so a listing without dist.tarball is just the version.
		const answer = readViewAnswer({ status: 0, stdout: '"1.0.0-beta.4"\n', stderr: '' }, FRET);

		assert.equal(answer.listed, false);
		assert.match(answer.reason, /dist\.tarball/);
	});

	it('does not count a dist.tarball that is not an http(s) URL', () => {
		// fetch answers a data: URL with 200 without asking anyone.
		const listing = JSON.stringify({ version: '1.0.0-beta.4', 'dist.tarball': 'data:,x' });

		const answer = readViewAnswer({ status: 0, stdout: listing, stderr: '' }, FRET);

		assert.equal(answer.listed, false);
		assert.match(answer.reason, /not an http\(s\) URL/);
	});

	it('counts both ways npm says a version is not there as not yet visible', () => {
		// Current npm: exit 1 with an E404 object. Older npm: exit 0 and no output.
		assert.deepEqual(readViewAnswer({ status: 1, stdout: E404, stderr: 'npm error code E404' }, FRET), { listed: false, reason: NOT_YET_VISIBLE });
		assert.deepEqual(readViewAnswer({ status: 0, stdout: '', stderr: '' }, FRET), { listed: false, reason: NOT_YET_VISIBLE });
	});

	it('keeps npm\'s own summary for any other failure', () => {
		const refused = JSON.stringify({ error: { code: 'ECONNREFUSED', summary: 'FetchError: request to http://127.0.0.1:9/p2p-fret failed' } });

		const answer = readViewAnswer({ status: 1, stdout: refused, stderr: '' }, FRET);

		assert.equal(answer.listed, false);
		assert.match(answer.reason, /^npm view failed with ECONNREFUSED: FetchError/);
	});

	it('throws on an answer to some other question rather than reading past it', () => {
		const other = JSON.stringify({ version: '1.0.0-beta.3', 'dist.tarball': 'https://registry.npmjs.org/p2p-fret/-/p2p-fret-1.0.0-beta.3.tgz' });

		assert.throws(() => readViewAnswer({ status: 0, stdout: other, stderr: '' }, FRET), /does not understand/);
		assert.throws(() => readViewAnswer({ status: 0, stdout: 'npm notice New major version', stderr: '' }, FRET), /not JSON/);
	});
});

describe('readTarballAnswer', () => {
	it('counts a listed version as published only once its tarball answers 200', () => {
		assert.deepEqual(readTarballAnswer(200), { visible: true });
		assert.deepEqual(readTarballAnswer(404), { visible: false, reason: TARBALL_NOT_YET_DOWNLOADABLE });
	});
});

/**
 * A wait over a fake clock: `sleep` advances it, and `probe` answers from `script` — for each package,
 * one answer per round in which it is asked, repeating the last.
 *
 * @param {Record<string, import('./published-visibility.js').Visibility[]>} script
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 */
async function scriptedWait(script, { timeoutMs = 60_000, intervalMs = 5_000 } = {}) {
	let clock = 0;
	/** @type {{ name: string, at: number }[]} */
	const asked = [];
	const stragglers = await waitForVisibility({
		expected: Object.keys(script).map((name) => ({ name, version: FRET.version })),
		probe: async (spec) => {
			const answers = script[spec.name];
			const askedBefore = asked.filter((entry) => entry.name === spec.name).length;
			asked.push({ name: spec.name, at: clock });
			return answers[Math.min(askedBefore, answers.length - 1)];
		},
		timeoutMs,
		intervalMs,
		now: () => clock,
		sleep: async (ms) => { clock += ms; }
	});
	return { stragglers, asked, clock };
}

const SEEN = { visible: true };
const NOT_YET = { visible: false, reason: NOT_YET_VISIBLE };

describe('waitForVisibility', () => {
	it('finishes once every package has been seen, asking again only about the ones not yet seen', async () => {
		const { stragglers, asked, clock } = await scriptedWait({
			[FRET.name]: [NOT_YET, NOT_YET, SEEN],
			[OTHER.name]: [NOT_YET, SEEN],
			[THIRD.name]: [SEEN]
		});

		assert.deepEqual(stragglers, []);
		assert.equal(clock, 10_000);
		assert.deepEqual(asked.map(({ name }) => name).sort(), [FRET.name, FRET.name, FRET.name, OTHER.name, OTHER.name, THIRD.name].sort());
	});

	it('gives up at the deadline, after one last round, naming each straggler with its latest reason', async () => {
		const refused = { visible: false, reason: 'npm view failed with ECONNREFUSED' };

		const { stragglers, asked } = await scriptedWait({
			[FRET.name]: [SEEN],
			[OTHER.name]: [NOT_YET, refused]
		}, { timeoutMs: 12_000 });

		assert.deepEqual(stragglers, [{ spec: OTHER, reason: refused.reason }]);
		assert.deepEqual(asked.filter(({ name }) => name === OTHER.name).map(({ at }) => at), [0, 5_000, 10_000, 12_000]);
	});
});
