----
description: The package's main public entry point uses loose catch-all types where precise ones are available, weakening type safety at the surface most users touch.
files: packages/fret/src/index.ts
difficulty: easy
----
The headline public API has several avoidable type shortcuts.

- The main factory takes its node argument as `any` when it should be the libp2p type — the value is passed straight into a class that already requires that type, so nothing is lost by tightening it and callers gain real checking.
- Peer metadata is typed as a record of `any` values throughout; it should be a record of `unknown` values so consumers must narrow before use.
- The same class is imported and re-exported twice; this should be a single aliased import.

Expected outcome: the factory's node parameter is the proper libp2p type, metadata values are `unknown` rather than `any`, and the duplicate import/re-export is collapsed to one.

References: review "Discovery & libp2p glue" minor finding (public API type laziness). index.ts factory node arg (~140), metadata typing (~20-24, 101-103), double import/re-export (~123-124).
