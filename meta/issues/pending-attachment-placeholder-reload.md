# Show and reload pending attachment placeholders

## Summary

Render incoming Delta Chat attachments that have not finished downloading as an
honest filename-and-size placeholder instead of a broken image, and replace the
placeholder automatically when core finishes downloading the bytes.

## Requirements

- Preserve Delta Chat `fileName`, `fileBytes`, and `downloadState` through the
  Mastodon media attachment and frontend adapter models.
- Ask Delta Chat core to download attachments whose full message is available
  but not yet downloaded.
- Render pending images as a non-broken placeholder with filename and formatted
  size when known.
- Retry the authenticated, no-store blob URL with bounded backoff and replace
  the placeholder automatically after the image becomes available.
- Clean up retry timers when the attachment or component is removed.

## Acceptance Criteria

- A pending image never renders a broken-image icon and shows its known name and
  size.
- Opening the blob starts core's full-message download without duplicate
  unbounded requests.
- The placeholder changes to the real image without a page reload after the
  blob becomes available.
- Daemon unit/integration tests and focused frontend Playwright coverage pass.
