# Preview replied-to posts

## Summary

Show a compact authenticated preview of a reply's parent on hover, keyboard
focus, and touch.

## Requirements

- Preserve parent status IDs through all render-facing post models.
- Load previews lazily and cache them per authenticated session.
- Use a short negative-cache lifetime because Headwater backfill may obtain a
  missing parent later.
- Preserve chosen-name, petname, content-warning, and direct-parent context.
- Keep previews static, viewport-contained, and unavailable anonymously.

## Acceptance Criteria

- Hover, focus, and touch expose the same safe parent preview.
- Reopening a loaded preview does not refetch it.
- Content-warning bodies remain hidden.
- Missing parents can be retried after the negative-cache lifetime.
- Home, profile, and thread Playwright tests pass.
