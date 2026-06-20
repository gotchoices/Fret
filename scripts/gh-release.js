#!/usr/bin/env node

// Creates the GitHub release for the current version.
//
// Release notes source:
//   - If an untracked `.release-notes.pending.md` exists at the repo root, its
//     contents become the release body (curated notes accumulated during the
//     cycle), and the file is consumed (deleted) on success — the published
//     GitHub release becomes the canonical copy.
//   - Otherwise we fall back to GitHub's auto-generated notes (`--generate-notes`).
//
// The pending file is intentionally optional: a release with no curated notes
// still succeeds with generated notes.
//
// Assumes the version tag (`v<version>`) already exists and is pushed — `yarn
// bump` (bumpp) creates and pushes it before this runs.

import { execSync } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const { version } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const tag = `v${version}`;
const pendingPath = join(rootDir, '.release-notes.pending.md');

const usePending = existsSync(pendingPath) && readFileSync(pendingPath, 'utf8').trim().length > 0;

const notesFlag = usePending ? `--notes-file "${pendingPath}"` : '--generate-notes';

if (usePending) {
	console.log(`Creating release ${tag} from .release-notes.pending.md`);
} else {
	console.log(`Creating release ${tag} with auto-generated notes (no .release-notes.pending.md)`);
}

try {
	execSync(`gh release create ${tag} --title ${tag} ${notesFlag}`, { stdio: 'inherit' });
} catch (error) {
	console.error(`Failed to create GitHub release ${tag}:`, error.message);
	process.exit(1);
}

if (usePending) {
	rmSync(pendingPath);
	console.log('Consumed .release-notes.pending.md (the GitHub release now holds the notes).');
}
