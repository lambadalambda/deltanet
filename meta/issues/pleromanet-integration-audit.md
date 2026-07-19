# Audit pleromanet changes for Headwater integration

## Summary

Review frontend changes made in the sister project `../pleromanet` after
Headwater's frontend diverged and identify which changes should be adopted,
adapted, or skipped.

## Requirements

- Establish a meaningful shared frontend baseline instead of comparing only the
  latest snapshots.
- Review behavior, tests, styling, and API assumptions for each candidate.
- Account for Headwater's capability contract, invite-scoped federation model,
  Electron host, and reduced/refined design direction.
- Rank recommendations by user impact, compatibility, and integration effort.

## Acceptance Criteria

- Relevant pleromanet change groups are classified as adopt, adapt, or skip.
- Recommended integrations cite source commits/files and Headwater target areas.
- Dependencies, conflicts, and suggested integration order are documented.

## Notes

- This is a read-only integration assessment; implementation belongs in focused
  follow-up issues.
- The exact shared source baseline is PleromaNet commit `07e2b69`: its `src`
  tree has the same Git tree object as Headwater's imported `frontend/src` at
  `0cf5146`. The reviewed source window is `07e2b69..7a8364c` (42 commits).
- Adopt first: `0d0aad7` Explore search-only, `f56f91c` unrelated right-rail
  cleanup, and the mobile correctness bundle (`a6a079f`, `ee85b7d`, `133f2df`,
  `9dd2625`, `e6e0d38`, `0a9d06c`, `1b81088`, `f9ead87`, `dc6197a`, finalized
  by `2d7532e`). Headwater still has the exact pre-fix EmojiPicker,
  NotifsPopover, and AttachmentLightbox component blobs.
- Adapt next: `e28884c` timeline retention (Home only), `e2997fe` optional
  top-of-feed auto-insert, `8939905` image composer previews with local object
  URLs, the read side of `fee4389` sensitive media, `d8dfbe9` plus `7a8364c`
  custom/system themes, and `1454497`/`7f5928e`/`caf7e58` authenticated reply
  previews.
- Skip: `b922d51` automatic reply-all because Headwater mentions alter encrypted
  recipients and can make direct delivery fail; sensitive-media authoring until
  it is a signed daemon capability; `66e62a8` poll layout while polls are
  unavailable; `fe19fc2`'s obsolete bottom-navigation offset; GitHub Pages and
  Pleroma deployment commits; repository-process-only commits.
- Important adaptations: preserve Headwater capability and media-discard
  behavior, petname/chosen-name rendering, invite detection, desktop backup
  gating, and the native clipboard helper. Use Headwater storage/event names and
  a Headwater theme-code prefix while optionally accepting legacy `PN1` codes.
- Recommended order: honest Explore/rails; final mobile bundle; Home timeline
  retention; image previews and sensitive-media reading; themes; reply previews;
  optional auto-insert.
- PleromaNet check/test execution was blocked by the restricted environment
  denying pnpm's temporary write in the sibling checkout. Its committed tests
  and devlog report the source regressions passing; no Headwater code was run or
  changed during this assessment.
