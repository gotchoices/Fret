description: Cap outbound work triggered by leave handling to limit amplification factor
dependencies: 4-leave-authentication (stronger with authenticated leaves but independently valuable)
files: src/service/fret-service.ts (handleLeave ~line 473-534)
----

### Problem

Each accepted `handleLeave` invocation triggers up to 6 replacement pings, 4 neighbor snapshot fetches, and announcements to 4 neighbors — roughly 14 outbound operations per leave notice. An attacker sending N leave notices with different `from` values triggers ~14N outbound operations. If replacements point to slow/unresponsive hosts, each warming operation blocks on timeouts, compounding the amplification.

The `bucketLeave` rate limits leave handling to 20/10 per second, but each accepted leave generates far more outbound traffic than the single inbound message.

### Expected behavior

Leave-triggered outbound work shares tokens with outbound rate budgets. The total outbound operations spawned by leave handling are bounded per time window — not just the inbound leave acceptance rate. If the outbound budget is exhausted, replacement warming is deferred or skipped. The amplification factor per accepted leave should be capped to a configurable maximum (e.g., 4 total outbound operations rather than 14).

### Threat references

- threat-analysis.md §4.2 (High): Leave storm amplification (~7x factor per leave)
- threat-rir-mitigated.md §4.2: Unchanged by RiR; RiR ejections may worsen this
