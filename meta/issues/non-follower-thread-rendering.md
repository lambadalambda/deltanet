# Non-follower nodes: DM-only replies invisible in threads; own reactions lost on re-index

## Summary

QA on lain's node (lain does NOT follow carol) after the canonical-mid
migration:
- Thread of his own post shows no replies: carol's reply exists there ONLY
  as the DM copy, and reply edges register only from feed messages
  (the feed/DM dedupe rule assumed a feed twin always exists locally).
- His own ❤️ reaction vanished: the migration re-derives tallies from
  messages, but `deriveOnIngest` skips all SELF-authored messages — own
  outgoing reaction DMs never re-apply, so migration loses own reactions
  (they were only ever applied directly by the endpoints).

## Requirements

1. **Thread edges via canonical identity, not chat type.** replyChildren
   values become the child's CANONICAL mid (not msgId), registered from
   BOTH feed messages and Single-chat DM reply copies (reply-marker
   messages only; reaction/control DMs still register nothing). Both
   copies of one logical reply collapse to one child entry (set
   semantics). Rendering/context/count paths resolve each child mid
   canonical-first via resolveMid (feed copy when present, DM copy
   otherwise) and skip unresolvable ones. `aliasMid` re-keying must now
   also normalize/merge child VALUE lists (dedupe when an alias unifies
   two entries), and read paths canonicalize child mids (alias may be
   learned after registration).
2. **Own reactions re-derive.** SELF-authored reaction/unreaction control
   DMs apply/retract tally state during derivation (idempotent set-add;
   chronological order within a chat preserves react→unreact sequences).
   SELF messages still derive NO notifications and NO follow-back actions.
   The endpoints' direct-apply stays (idempotent double-apply is fine).
3. Store schema bumps to v2 (replyChildren value format changed); the
   existing migration machinery drops derived indices and re-indexes on
   restart. Same data-safety rules: nothing touches Delta Chat databases,
   no manual file surgery — QA nodes (lain's personal account) heal on a
   plain restart.

## Acceptance Criteria

- Integration test topology (fresh accounts, data/int-* dirs): B follows
  A, A does NOT follow B. A posts; B replies; A reacts to B's reply and
  replies to it. On A's node: thread of A's original shows B's reply
  (rendered from the DM copy) and the full chain; A's own reaction shows
  on B's reply. Then simulate the migration on A (fresh store, re-index
  via backfill): all of the above still true — own reaction included.
- On B's (follower) node the same thread still shows exactly ONE copy of
  each reply (no double-count regression) — assert counts.
- Unit tests: canonical-mid child registration from both copy types with
  dedupe, alias-later value merging, SELF reaction derivation (react +
  unreact ordering), migration v1→v2.
