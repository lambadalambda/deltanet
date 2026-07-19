# Integrate honest discovery and route-specific rails

## Summary

Replace unfinished Explore content with working Headwater search and remove
unrelated right-rail placeholders from routes without real secondary content.

## Requirements

- Keep one prominent Explore search surface and existing feed-invite handling.
- Describe search as known people and locally held posts, not federation-wide
  discovery.
- Omit the right rail on Explore, Search, Notifications, Messages, and
  Bookmarks.

## Acceptance Criteria

- Explore has no topics, communities, fake instances, or discovery feed.
- Search submission opens the encoded full-results route.
- Affected routes expand without unrelated profile placeholder cards.
- Focused Playwright tests pass at desktop and mobile widths.
