# "Direct" visibility: mentioned-people-only delivery

## Summary

Noted during visibility part 1. The composer's fourth visibility,
`direct`, still posts publicly. With mention delivery built, direct maps
naturally: NO channel post at all — sign the envelope and DM-copy it to
each mentioned key-contact only (the existing deliverMentionCopies path),
render it as visibility 'direct' locally.

## Requirements

- Until direct delivery is implemented end to end, the daemon must reject
  `visibility: 'direct'` and the frontend must hide or clearly disable the
  option. It must never silently fall through to the public channel.
- Once implemented, direct posts must be delivered only to explicitly
  mentioned key-contacts and must not enter a feed channel.

## Decisions

- No non-self key-contact mentions on a direct root returns 422; direct is
  not a self-note surface.
- A direct post is reachable through its status/thread and recipient mention
  notifications, but never enters home, public, profile, or search feeds.
- Direct posts have their own persisted UUID guard and are never served,
  held, boosted, thread-subscribed, or thread-republished.
- Every recipient is resolved before sending. Independent DM sends cannot be
  transactional; if only some later sends fail, successful local copies remain
  indexed and the API reports an explicit `partial_delivery` error.

## Acceptance Criteria

- At every intermediate state, selecting or submitting `direct` cannot
  publish the post to the public or locked feed channel.
- Direct post reaches exactly the mentioned key-contacts, appears in no
  feed, renders visibility 'direct', notifies recipients, and is refused
  by serve/boost guards.
