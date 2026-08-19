description: One section of the project's design document was not re-checked against the code during a recent review, so it may describe behavior that has since changed.
files: docs/fret.md, packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/request.ts, packages/fret/src/rpc/outcome.ts
difficulty: easy
tradeoffs: The section was written alongside the code it describes and every constant it names was already confirmed correct, so a maintainer may reasonably judge a full re-read low value until the next change touches that area.
----

The design document `docs/fret.md` is meant to describe the system as it actually is. Its
**Stream management** bullets — the ones covering read deadlines, stream release, the inbound
handler seam, and the agreement between the five outbound senders — were rewritten as part of the
network-sender rewrite and have not since been read back against the code.

Three separate inaccuracies were found and fixed elsewhere in the same document during that
rewrite's review, which is why the remainder is treated as unverified rather than assumed correct.
The constants those bullets name (the 5-second whole-request budget, the 2-second maintenance
timeout, the 3-second shutdown budget, the 1.5-second per-leave-notice budget) were each confirmed against the code and are correct; what is unchecked is the
prose around them — the described sequencing, the stated stream-release rules, and the claims about
what each sender does and does not guarantee.

The work is a read-and-correct pass, not a code change: read each bullet, find the code it
describes, and either confirm it or correct the text. Anything that turns out to be a genuine code
defect rather than a stale sentence should be filed on its own.
