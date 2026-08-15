----
description: When reading a multi-part message off the wire, the node gives up if the next piece does not arrive within a tenth of a second, so large messages over slow or relayed links are truncated, fail to parse, and the sending peer is wrongly penalized as unhealthy.
files: packages/fret/src/rpc/protocols.ts
difficulty: easy
----
The RPC read loop treats a 100 ms gap between chunks as end-of-message. After the first chunk arrives, if the next chunk does not come within 100 ms the read is considered complete; the truncated buffer then fails `JSON.parse`, the RPC errors, and the remote peer gets failure-scored. Snapshots of 128-512 KiB over relayed or congested links routinely exceed this idle gap, so healthy peers are demoted for slow transport.

libp2p v3's `close()` is a proper half-close, so end-of-stream propagates cleanly without an idle-timeout hack — the timeout is unnecessary as well as harmful.

Expected behavior: a large message that arrives in bursts spread over more than 100 ms is read to completion and parsed successfully; peers are not failure-scored for slow-but-complete transfers.

Requirements:
- Drop the idle-read timeout, or raise it to at least 1 s and make it configurable.

References: review RPC-section "100 ms idle-read timeout truncates slow multi-chunk messages" (protocols.ts:78-83). Recommended fix: rely on proper EOF from half-close; if an idle guard is kept, default it >=1 s and expose it as an option.
