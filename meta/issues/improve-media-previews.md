# Improve composer and sensitive-media previews

## Summary

Show local previews for staged Headwater images and allow incoming sensitive
media to be explicitly revealed instead of discarding it from the view model.

## Requirements

- Share one image-preview component between Home and inline reply composers.
- Use and revoke local object URLs through every success, failure, cancellation,
  route, session, and teardown path.
- Preserve upload progress, errors, alt text, removal, capability gating, and
  daemon staged-media deletion.
- Retain incoming sensitive attachments and hide them behind an accessible
  status-level reveal when there is no content warning.
- Do not add sensitive-media authoring or audio/video upload controls.

## Acceptance Criteria

- Selected and uploaded images render uncropped previews in both composers.
- Object URLs and staged uploads are cleaned up deterministically.
- Sensitive media can be revealed while body text stays visible.
- Content-warning posts retain the existing single reveal flow.
- Focused adapter and Playwright tests pass.
