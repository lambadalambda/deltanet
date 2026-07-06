# Dual-copy identity split: canonical-mid unification

## Summary

A reply is sent twice — feed broadcast copy + DM copy to the parent's
author — with two different rfc724 Message-IDs. Anyone who only has the DM
copy (a non-follower parent, like lain not following carol) references the
DM copy's mid in their replies/reactions, so those interactions never show
on the feed copy that timelines and threads render. Verified live: carol's
"cool pic" feed copy (msg 86, mid 9344…) has no children/reactions while
its DM twin (msg 87, mid 77db…) carries the reply child AND lain's ❤️;
thread ancestors even route through the DM chat (conv 19).

## Design: canonical mids

The feed copy's mid is the post's canonical identity. DM copies declare it;
everything else normalizes to it.

1. **Protocol**: DM copies of replies carry an extra marker line declaring
   the canonical (feed-copy) mid — builder + tolerant parser, round-trip
   tested. Pick a glyph/format consistent with the existing markers and
   readable-ish in vanilla Delta Chat.
2. **Send path**: post the feed copy first, fetch its mid, build the DM
   copy with the canonical marker appended.
3. **Store**: `canonicalByMid` alias map (dmMid → feedMid). Populated (a)
   on our own reply sends, (b) on ingesting any DM carrying the canonical
   marker, (c) during (re)index for HISTORICAL self-authored copies: a
   SELF DM (Single-chat) message with a reply marker whose full text
   equals a SELF feed message's text → alias (pre-fix copies are exact
   text twins).
4. **Normalization everywhere**: a single `canonicalize(mid)` used by
   reaction apply/retract + tallies lookup, replyChildren registration +
   children/count lookups, reply/boost ref resolution (in_reply_to,
   context ancestors/descendants), resolveMid (aliased mid resolves to the
   feed message when present locally), and notification statusMsgId.
5. **Acting on a DM copy**: when the user replies/reacts/boosts a message
   whose text carries a canonical marker, the outgoing ref uses the
   canonical mid (this is what makes a non-follower's interactions
   resolvable by third parties who only have feed copies).
6. **Migration without data surgery**: add a store schema `version`. On
   loading an older store, drop the derived indices (mid maps, edges,
   tallies, ingestedMsgIds) but KEEP notifications + notificationDedupeKeys
   (so re-derivation can't duplicate-notify), and let the startup backfill
   re-index with aliasing. Must NOT require deleting any files or touching
   the Delta Chat databases — QA nodes (lain's personal account) must heal
   on a simple daemon restart + upgrade.

## Acceptance Criteria

- The QA scenario end-to-end (integration test, fresh accounts + own
  data/int-* dirs): B follows A (A does NOT follow back); A posts, B
  replies; A reacts ❤ and replies to B's reply (A only has the DM copy).
  On B's node: the feed copy of B's reply shows replies_count 1 and the
  reaction; thread view of A's original post shows the full chain
  (original → B's reply → A's reply); context ancestors never route
  through Single-chat copies.
- After upgrade + restart with a pre-fix store, carol's historical
  "cool pic" (86) shows its reply count and lain's reaction (aliasing via
  identical-text matching during re-index).
- Unit tests: marker round-trip, canonicalize normalization at every
  listed touchpoint, migration re-index trigger, identical-text aliasing.
