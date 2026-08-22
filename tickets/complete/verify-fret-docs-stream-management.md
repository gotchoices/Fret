description: Final check confirming the design doc's "inbound handlers release their stream on every path" paragraph matches the code — closes a five-pass verification series.
files: docs/fret.md, packages/fret/src/rpc/protocols.ts (registerRpcHandler)
difficulty: easy
---

Continuation/completion of a multi-pass read-and-correct verification of `docs/fret.md`'s
**Stream management** section against code (prior passes: 34/35/36/37, all deleted after landing
here). All prior bullets confirmed matching in earlier passes; this pass covered the one remaining
item.

## Review findings

Re-read the "inbound handlers release their stream on every path" paragraph in `docs/fret.md`
against `registerRpcHandler` (`packages/fret/src/rpc/protocols.ts:122-155`) with fresh eyes. Each
specific sub-claim checked against the implementation:

- **Success-path close is budgeted, its own deadline separate from the RPC timeout** — confirmed.
  `closeBudgetMs = opts.closeBudgetMs ?? RPC_TIMEOUT_MS` (line 128), and a fresh `deadline()` is
  minted per successful `serve()` call (line 137) — an independent `AbortController` from any
  outbound RPC timeout, exactly as documented.
- **A close that exhausts its budget lands in the same catch arm as a thrown handler, but is
  logged distinctly** — confirmed. Both paths hit the same `catch (err)` (lines 144-149); the
  discriminator is `closeBudget?.signal.aborted === true`, logging "remote stopped reading" vs
  "handler error" accordingly.
- **The error arm is skipped for a stream whose write end the handler already closed, and for one
  already reset by the remote** — confirmed, and the doc's own note about which field is
  load-bearing checks out: the guard is `stream.status === 'open' && stream.writeStatus !== 'closed'`
  (line 150). `status` alone would misfire (a half-closed stream stays `'open'` until the remote
  closes too), so `writeStatus` is the field actually doing the work, matching the doc's claim.
- **Identity-mismatch drops (leave/announce) close rather than abort** — confirmed. `serve`
  returning `undefined` in `registerJsonHandler` (lines 234-238, 241) returns normally without
  replying, which takes the success path's budgeted `close()`, not the error arm's `abort()`.

No discrepancies found. No code or doc change required — the paragraph in `docs/fret.md` is
accurate as written. This closes the "Stream management" verification series; no further
continuation ticket needed.
