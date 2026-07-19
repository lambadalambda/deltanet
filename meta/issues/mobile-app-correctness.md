# Integrate mobile app correctness improvements

## Summary

Port PleromaNet's finalized mobile layout, overlay, lightbox, input, and action
fixes to Headwater.

## Requirements

- Use a focus-trapped, focus-restoring modal navigation drawer.
- Remove the redundant bottom navigation and details sheet.
- Prevent mobile focus zoom and keep post actions, overlays, notifications, and
  lightboxes inside the visual viewport down to 320 px.
- Keep the Home timeline full-bleed while ordinary panel routes remain inset.
- Keep the desktop sidebar at least 240 px until it collapses.

## Acceptance Criteria

- Mobile navigation is keyboard-modal and restores opener focus.
- No affected route or overlay overflows at 320 px and 390 px.
- Long lightbox filenames cannot hide the close control.
- Electron-like 800x600 and desktop breakpoints remain usable.
- Focused responsive Playwright tests pass.
