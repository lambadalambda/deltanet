# Wire up avatar/banner upload in the settings UI

## Summary

Sub-issue of [Profile editing (name, bio, avatar)](profile-editing.md). The
daemon already accepts avatar/header File uploads on
`PATCH /api/v1/accounts/update_credentials` (multipart form-data), but the
frontend's "Choose avatar" / "Choose banner" buttons on the profile settings
page (`src/routes/app/[...path]/+page.svelte`) are inert. Wire them to real
file pickers, local previews, and a multipart save path.

## Requirements

- Each button opens a file picker restricted to
  `image/png,image/jpeg,image/webp,image/gif`. Selecting a file shows a local
  object-URL preview in the settings page, replacing the current image, with a
  way to discard the pending choice before saving.
- On save, when image files are pending, send ONE multipart
  `PATCH /api/v1/accounts/update_credentials` request carrying `avatar` and/or
  `header` File objects plus `display_name`/`note` (and other profile fields)
  as regular form fields. When no files are pending, keep today's JSON path
  unchanged. Extend `updateAccountProfile`/client, staying with the existing
  client/request architecture (auth header, error normalization).
- On success, update session/account state from the returned account JSON as
  the existing save flow does. Avatar/header URLs come back as daemon URLs and
  the avatar URL is stable per contact id, so cache-bust when updating in-place
  so the new image actually shows without a hard reload.
- Client-side file-size guard reusing `COMPOSER_MAX_UPLOAD_BYTES`; violations
  raise the standard error toast and do not submit.

## Acceptance Criteria

- Choosing an avatar file shows a preview, and saving sends multipart with the
  file; account state updates. Same for banner.
- JSON-only save path unchanged when no files are pending.
- Oversized file shows an error and does not submit.
- Playwright coverage in `app-settings.e2e.ts`; full `pnpm test` and
  `pnpm check` green.

## Notes

- Daemon contract (read-only): multipart body reads `display_name`, `note`,
  `avatar` (File), `header` (File); ignores extra fields. Non-image
  avatar/header → 422; blank display_name → 422.
