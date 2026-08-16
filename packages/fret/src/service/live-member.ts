import type { PeerEntry } from '../store/digitree-store.js';

/**
 * Does this peer participate in *this* network's ring right now?
 *
 * Ring views are scoped to this network **and to peers we still believe are alive**: a peer is a
 * neighbor, cohort member, routing candidate, size-estimate contributor, snapshot sample entry or
 * discovery emission only once it is confirmed to serve this network's FRET protocol, and only
 * while it is not marked `dead`.
 *
 * Self is seeded `member` and is never marked dead, so it always passes. `unknown` peers are
 * excluded until the classification probe pass (`FretService.classifyUnknownPeers`) resolves them —
 * typically within ~1 tick — so they are not permanently starved; `dead` peers are excluded until
 * the dead arm of the re-probe pass (`FretService.reprobeOffRing`) finds one alive again.
 *
 * Both exclusions are **one predicate** rather than a second guard bolted onto each reader, so
 * every ring-shaped read inherits them at once and a reader added later cannot forget one. That is
 * also why this lives in its own module rather than inside `FretService`: `FretPeerDiscovery` is a
 * ring-shaped reader too, and while it held its own copy of the two conditions the invariant was
 * only a convention. The store stays network-agnostic — it never names `membership` — so the
 * predicate is passed *into* its walks rather than living there.
 *
 * Two consequences fall out rather than needing code of their own: FRET stores no separate
 * successor/predecessor *set* — those windows are this filtered walk — so exclusion here **is**
 * removal from S/P; and `enforceCapacity` protects only the peers this predicate returns around
 * self, so a dead peer loses its protected slot and, with a decayed relevance, becomes a preferred
 * eviction victim.
 */
export const isLiveMember = (e: PeerEntry): boolean => e.membership === 'member' && e.state !== 'dead';
