# Epic: Integrate selected PleromaNet frontend improvements

## Summary

Adapt the selected post-fork PleromaNet UX improvements to Headwater without
regressing its invite-scoped federation model, daemon capabilities, desktop
host, or resource lifecycle.

## Requirements

- Implement the linked discovery, mobile, timeline, media, theme, and reply
  context slices independently with focused tests.
- Port behavior rather than cherry-picking divergent monolithic route files.
- Preserve Headwater-specific capability, security, backup, clipboard, petname,
  and staged-media behavior.

## Acceptance Criteria

- Every linked slice satisfies its own acceptance criteria.
- Root frontend checks and the complete Playwright suite pass.
- A focused review finds no unresolved high- or medium-severity regression.

## Notes

- Source baseline and classification are recorded in
  `pleromanet-integration-audit.md`.
