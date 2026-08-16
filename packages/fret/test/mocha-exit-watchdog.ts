import { writeSync } from 'node:fs';

const DEFAULT_GRACE_MS = 10_000;

interface ProcessInternals {
	_getActiveHandles?: () => unknown[];
	_getActiveRequests?: () => unknown[];
}

function graceMs(): number {
	const raw = process.env.FRET_TEST_EXIT_GRACE_MS;
	if (raw === undefined) return DEFAULT_GRACE_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GRACE_MS;
}

// Raw fd write, not process.stderr.write(): the leading hypothesis for these hangs
// is Mocha's own force-quit helper stalled waiting on a stream write callback that
// never fires, so routing through that same stream object would be invisible
// exactly when it matters most.
function log(line: string): void {
	writeSync(2, `${line}\n`);
}

function constructorName(value: unknown): string {
	if (value !== null && typeof value === 'object') {
		return value.constructor?.name || 'anonymous';
	}
	return value === null ? 'null' : typeof value;
}

function describeStillOpen(): string {
	const internals = process as unknown as ProcessInternals;
	const resources = process.getActiveResourcesInfo();
	// NOTE: verified against Node v24.2.0 — _getActiveHandles/_getActiveRequests are
	// present but always return [] there (long-deprecated internals with no stated
	// stability guarantee), so getActiveResourcesInfo() is the only one of the three
	// actually trustworthy on current Node. The other two are kept for older runtimes
	// and as a documented tally, not relied on as the primary diagnostic.
	const handles = (internals._getActiveHandles?.() ?? []).map(constructorName);
	const requests = (internals._getActiveRequests?.() ?? []).map(constructorName);
	return [
		`resources: ${resources.join(', ') || '(none)'}`,
		`handles: ${handles.join(', ') || '(none)'}`,
		`requests: ${requests.join(', ') || '(none)'}`,
	].join('\n');
}

// `process.exit(1)` alone is NOT enough, and silently so: without `--exit`, mocha ends a
// run via `exitMochaLater`, which registers `process.on('exit', () => process.exitCode = <test
// result>)`. That handler runs during our exit and stamps the passing code back over ours, so
// the watchdog would print its diagnosis and still report success — defeating its whole point.
// Exit handlers fire in registration order, so registering ours here (after mocha's, since the
// run has already finished) makes it the last writer and the winner.
function failExit(): never {
	process.on('exit', () => { process.exitCode = 1; });
	process.exit(1);
}

function armWatchdog(): void {
	const grace = graceMs();
	// Unref'd: a healthy run reaches process.exit() on its own once Mocha's summary
	// is printed, and an unreferenced timer cannot itself keep that process alive.
	const timer = setTimeout(() => {
		log(`\n[exit-watchdog] process still alive ${grace}ms after the last test finished. Still open:`);
		log(describeStillOpen());
		failExit();
	}, grace);
	timer.unref();
}

// NOTE: an unref'd timer only fires while the event loop is still turning. A
// process wedged by a synchronous infinite loop or a self-feeding microtask chain
// starves timers entirely, so no in-process watchdog can catch that case — only an
// external wall-clock limit can. This covers leaked-handle and stalled-flush
// hangs, not that one.
export const mochaHooks = {
	afterAll(): void {
		armWatchdog();
	},
};
