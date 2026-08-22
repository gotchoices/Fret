import type { FretService } from '../../src/service/fret-service.js';
import type { ProbeBackoff } from '../../src/service/probe-backoff.js';

/**
 * Test-only access to a service's private `backoff` field.
 *
 * The parameter is the concrete `FretService` rather than `unknown`: the cast has to be written
 * either way (the field is `private readonly`), but typing the parameter is what still catches
 * handing these the wrong object — the `Libp2pFretService` facade, say, which has no such field.
 * With `unknown` every argument compiles and the mistake surfaces as `undefined` at runtime,
 * which is the failure mode these helpers exist to remove from the specs.
 */
type WithBackoff = { backoff: ProbeBackoff };

export function backoffOf(svc: FretService): ProbeBackoff {
	return (svc as unknown as WithBackoff).backoff;
}

/** `backoff` is `readonly` in production; a spec installs a fake-clock instance through this. */
export function setBackoffOf(svc: FretService, pb: ProbeBackoff): void {
	(svc as unknown as WithBackoff).backoff = pb;
}
