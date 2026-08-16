// Not part of the suite: the name is deliberately outside the `test/**/*.spec.ts`
// glob so only `test/mocha-exit-watchdog.spec.ts` runs it, as a child mocha process.
// Leaks a *referenced* interval on purpose, so the exit watchdog has something real
// to catch and name.
it('leaks a referenced timer', () => {
	setInterval(() => { /* never cleared — that is the point */ }, 1_000);
});

export {};
