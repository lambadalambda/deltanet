# Visibility part 2: leak prevention across the sharing machinery

## Summary

Part 1 ([[visibility-channels]] / issues/visibility-channels.md) shipped
the locked channel with LOCAL guards only (own backfill serving refuses
locked posts; boosting one's own locked post is refused). Everything that
makes deltanet posts *shareable* still needs locked-awareness so
"Followers" isn't leakable through machinery:

## Decisions (2026-07-09, picked up)

- **Marker: UNSIGNED `visibility: 'private'` field on content envelopes.**
  Same trust argument as the `invite` field: it rides outside the dn3
  canonical payload (no dn4 bump, no downgrade analysis), and stripping it
  requires a peer who could equally leak the content itself — the marker
  guards honest machinery, not malicious holders. Tolerant parse: any
  value other than 'private' drops to absent (= public).
- **Reply inheritance: server-ENFORCED.** A reply to a private-marked (or
  own-locked) parent goes to the replier's locked channel regardless of
  the requested visibility — stricter than Mastodon's default-but-
  overridable. Documented caveat: the replier's locked audience is THEIR
  followers, not the original author's.
- **Mention delivery of locked posts stays ON**: DM-copying a mentioned
  key-contact is the author deliberately addressing them.
- **Thread channels: locked roots are not subscribable** (scoped requests
  refused, subscribe endpoint refuses, republication skips private
  replies) — v1 simplicity over locked-membership-gated channels.
- **Revocation: API-level now** (`POST
  /api/v1/accounts/:id/remove_from_followers`, removes from BOTH
  channels), profile UI deferred until relationships compute
  `followed_by`.

## Deferred surfaces (from part 1, documented not silent)

- **Envelope visibility marker + remote honoring**: receivers can't tell
  a locked post from a public one, so THEIR daemons will happily boost it
  (re-embedding the signed envelope into a public feed) or serve it via
  backfill. Add a visibility field on content envelopes; receivers refuse
  to boost/serve marked posts and their UI disables the boost button
  (statuses of marked posts render `visibility: private` on follower
  nodes too). Decision needed: unsigned field (strippable only by someone
  already leaking deliberately — my lean) vs signed (dn4 canonical bump +
  downgrade analysis).
- **Thread channels**: a locked root's thread channel must not auto-grant
  subscriptions/thread-so-far to strangers (gate on locked-channel
  membership via `getChatContacts`, or refuse thread-subscribe for locked
  roots outright). Same for the in-band `invite` stamped on locked
  envelopes (currently stamps the author's contact invite — harmless in
  itself, but reconsider).
- **Reply privacy inheritance**: a locked follower's REPLY to a locked
  post goes to their own PUBLIC feed today, leaking reply content + the
  root ref. Mastodon behavior: replies default to the parent's
  visibility. Requires the receiver to KNOW the parent was locked → needs
  the envelope marker above.
- **Mention delivery of locked posts**: a locked post mentioning a
  non-follower DM-copies them the envelope (deliberate addressing by the
  author — arguably fine, Mastodon 'private' does notify mentioned
  non-followers ambiguously). Decide + document.
- **Search/backfill on follower nodes**: locked posts a follower holds
  surface in THEIR search (fine — they have access) but must not be
  served onward once the marker exists.
- **Revocation**: `removeContactFromChat` on the locked broadcast +
  a "remove from followers" affordance (Mastodon
  /api/v1/accounts/:id/remove_from_followers). Removal stops FUTURE
  delivery only (honest caveat: already-delivered posts stay).

## Honest limits (document in UI copy)

Once a locked follower holds a post, technical enforcement ends — the
measures above keep OUR machinery and honest peers from leaking; they are
not DRM.
