----
description: The limit on how many requests the service handles at once is currently checked by poking its internal counter directly, so the real behavior — that the counter goes up and back down correctly even when a request fails partway — is never verified.
files: packages/fret/test/profile.behavior.spec.ts
difficulty: medium
----
The inflight concurrency cap is "tested" by assigning the private inflight counter to a value and observing the response. That verifies nothing about the increment/decrement pairing around real request handling — precisely the class of bug counters accumulate, especially on the exception path where a decrement is easy to skip.

What the tests should assert:
- Firing N concurrent request-handling calls with a slow stubbed activity produces busy / retry responses once the cap is exceeded.
- After all calls settle, the counter returns to zero.
- The counter still returns to zero when the stubbed activity throws, proving the decrement runs on the error path.

References: review.html:425-429 "Concurrency tested by writing the private counter"; profile.behavior.spec.ts inflight test (around lines 249-271).
