# Implement persisted bookmarks

## Summary

Add real bookmark mutation and listing semantics before enabling saved-post UI.

## Requirements

- Persist bookmarks across restarts and define behavior for unavailable posts.
- Implement bookmark, unbookmark, and paginated bookmark-list endpoints.
- Advertise `configuration.headwater.capabilities.bookmarks: true` only with the
  complete contract.

## Acceptance Criteria

- Daemon contract and frontend integration tests cover mutation, persistence, pagination, and removal.
