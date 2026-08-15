----
description: Ring coordinates decoded from the wire are never checked for correct length, so a malformed coordinate can silently scramble the ordering of the routing table.
files: packages/fret/src/ring/hash.ts
difficulty: easy
----
The base64url-to-coordinate decoder never asserts that the result is the expected fixed coordinate byte length, and coordinates carried in snapshot sample entries flow straight into the routing store. Ring ordering relies on fixed-length sixty-four-character hex keys compared by lexicographic prefix; a wrong-length coordinate silently corrupts successor and predecessor order for the whole table. The hex-to-coordinate decoder has a companion gap: it coerces non-hex characters to zero bytes via NaN, turning garbage input into a valid-looking zero-ish coordinate.

This ticket is store-integrity length and charset validation at the decode boundary only. Full re-hash verification of provided coordinates against the peer id is separate planned security work and is out of scope here.

Expected behavior: decoding a coordinate of the wrong byte length throws rather than returning it; hex decoding rejects wrong-length or non-hex input instead of coercing it to zeros.

References: review store section, major finding "No coord length validation at the decode boundary" (hash.ts:45-47, 33-39; consumer at fret-service.ts:770). Fix hint: throw when the decoded length is not the coordinate byte count; validate hex length and charset.
