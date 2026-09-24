#!/usr/bin/env node
/**
 * Release preflight — the reminder gate in front of `yarn bump && yarn pub && yarn await-published && yarn gh-release`.
 *
 * `yarn pub` publishes to npm: irreversible for a given version number. This script does NOT
 * run the checks itself (a release should not silently spend minutes rebuilding and re-testing
 * what you just built); it states what `yarn check` covers, reports the tree state it *can*
 * determine cheaply, and requires an explicit typed confirmation.
 *
 * Bypass for automation: `--yes` (or CI=1 in the environment). Without a TTY and without an
 * explicit bypass it aborts rather than assuming consent.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, env, exit } from 'node:process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIRM_WORD = 'release';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PENDING_NOTES = join(REPO_ROOT, '.release-notes.pending.md');

/** Cheap, objectively-determinable facts worth putting in front of the user before they confirm. */
function gitFacts() {
	const git = (...args) => execFileSync('git', args, { encoding: 'utf8', cwd: REPO_ROOT }).trim();
	try {
		return {
			ok: true,
			branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
			dirty: git('status', '--porcelain').length > 0,
			// A release from a branch behind its remote publishes code that isn't what origin has.
			ahead: git('rev-list', '--count', '@{upstream}..HEAD'),
			behind: git('rev-list', '--count', 'HEAD..@{upstream}')
		};
	} catch {
		// No repo, no upstream configured, or git absent — report rather than fail the release.
		return { ok: false };
	}
}

function report() {
	const facts = gitFacts();
	stdout.write('\nRelease preflight\n');
	stdout.write('─────────────────\n\n');
	stdout.write('`yarn pub` publishes p2p-fret to npm. A published version cannot be replaced.\n\n');
	stdout.write('Run `yarn check` first if you have not already. It covers:\n');
	stdout.write('  • yarn typecheck   tsc --noEmit over packages/fret\n');
	stdout.write('  • yarn build       the package compiles\n');
	stdout.write('  • yarn test        release-script tests, then mocha suites (with the exit watchdog)\n\n');

	if (facts.ok) {
		stdout.write(`Working tree: ${facts.dirty ? 'DIRTY — uncommitted changes present' : 'clean'}\n`);
		stdout.write(`Branch:       ${facts.branch}\n`);
		if (facts.behind !== '0') stdout.write(`Upstream:     ${facts.behind} commit(s) BEHIND origin\n`);
		else if (facts.ahead !== '0') stdout.write(`Upstream:     ${facts.ahead} commit(s) ahead of origin (bump will push)\n`);
		else stdout.write('Upstream:     in sync\n');
	}
	stdout.write(`Release notes: ${existsSync(PENDING_NOTES) ? '.release-notes.pending.md (will be consumed)' : 'none pending — GitHub will auto-generate'}\n\n`);

	return facts;
}

const bypass = argv.includes('--yes') || argv.includes('-y') || env['CI'] === '1' || env['CI'] === 'true';

if (bypass) {
	report();
	stdout.write('Preflight bypassed (--yes / CI). Proceeding.\n\n');
	exit(0);
}

const facts = report();

if (!stdin.isTTY) {
	stdout.write('No interactive terminal available, and no --yes flag. Aborting rather than\n');
	stdout.write('assuming consent to publish. Re-run with `--yes` if this is intentional.\n\n');
	exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
try {
	if (facts.ok && facts.dirty) {
		stdout.write('The working tree is dirty. `yarn bump` will commit whatever is staged.\n\n');
	}
	const answer = await rl.question(`Type "${CONFIRM_WORD}" to bump, tag, push, publish, and cut the GitHub release: `);
	if (answer.trim().toLowerCase() !== CONFIRM_WORD) {
		stdout.write('\nAborted. Nothing was bumped or published.\n\n');
		exit(1);
	}
	stdout.write('\n');
} finally {
	rl.close();
}
