# Retain Home timeline state across navigation

## Summary

Preserve Home timeline pages, pagination, queued updates, and browser scroll
when navigating into another app route and returning.

## Requirements

- Keep Home state scoped to the exact authenticated session.
- Stop inactive streaming and reconnect once on return without refetching valid
  cached data.
- Prevent stale requests and actions from mutating replaced sessions.
- Preserve Headwater composer and staged-upload cleanup independently.
- Add an opt-in setting that inserts streamed posts automatically only while at
  the top of the timeline.

## Acceptance Criteria

- Home to thread to Back restores loaded pages and scroll without an initial
  refetch.
- Sign-out or session replacement clears retained data.
- Auto-insert never steals position while reading older posts.
- Existing manual new-post indication remains available.
- Focused timeline, streaming, pagination, and history tests pass.
