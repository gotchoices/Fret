import type { ProbeBackoff } from '../../src/service/probe-backoff.js';

export function backoffOf(svc: unknown): ProbeBackoff {
	return (svc as unknown as { backoff: ProbeBackoff }).backoff;
}

export function setBackoffOf(svc: unknown, pb: ProbeBackoff): void {
	(svc as unknown as { backoff: ProbeBackoff }).backoff = pb;
}
