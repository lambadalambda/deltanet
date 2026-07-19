# Add custom and automatic system themes

## Summary

Add editable custom palettes and fixed/system theme preferences derived from
PleromaNet's theme implementation.

## Requirements

- Keep all four built-in themes and current fixed-theme behavior.
- Add a custom eight-color palette with contrast feedback.
- Add system mode with independently selected light and dark themes and live OS
  preference updates.
- Use versioned Headwater storage/event names and migrate the current theme key.
- Export a Headwater share-code format, optionally importing legacy `PN1` codes.
- Use Headwater's shared clipboard helper.

## Acceptance Criteria

- Fixed and system modes apply correctly on load and live preference changes.
- Preferences and custom palettes survive reload and synchronize safely.
- Custom tokens cover the complete app and media treatment.
- Share-code import/export and contrast helpers have unit coverage.
- Settings and design-system Playwright tests pass.
