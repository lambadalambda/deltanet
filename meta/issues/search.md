# Search: users and posts we know about

## Summary

The search page (and header search) is fully built in the frontend and
calls Mastodon's `GET /api/v2/search` — which the daemon doesn't serve, so
search returns nothing. Implement it over what a node actually knows:

- **Users we know about, through whatever way**: every contact row core
  holds (followed feed owners, people who replied/reacted, securejoined
  contacts, mentioned-and-met people), deduped by address (the key-contact
  row wins over a keyless address row), ranked petname > their name >
  address like the mention autocomplete — but WITHOUT the key-contact-only
  filter (search is discovery, not deliverability). SELF excluded.
- **Posts we know about**: core's own full-text `searchMessages` across
  all chats, filtered to CONTENT messages (posts/replies/boosts — never
  reaction/invite/backfill control DMs), deduped so a reply's feed copy
  and DM copy collapse to one logical post (post-key resolution via the
  store, preferring the feed copy) — plus VERIFIED held envelopes
  (backfilled/thread content we never received directly) matching the
  query, rendered through the existing verify-at-render `heldStatus`
  ladder as `orig-<uuid>` statuses.

`hashtags` stays `[]` (no hashtag system).

## Acceptance Criteria

- `/api/v2/search?q=` returns `{accounts, statuses, hashtags}`; `type=`
  narrows to accounts/statuses; blank q → empty result, no errors.
- Searching a petname, their chosen name, or an address fragment finds
  the contact; searching post text finds the post exactly once (no
  DM-copy duplicates), newest first; control DMs never surface.
- A verified held envelope matching the query surfaces as its
  `orig-<uuid>` status; unverifiable held content never does.
- The existing frontend search page works against the live daemon with no
  frontend changes (header search + /app/search).
