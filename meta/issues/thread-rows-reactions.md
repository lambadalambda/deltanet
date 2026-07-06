# Thread ancestor/descendant rows don't render reactions

## Summary

The thread view's ancestor rows omit emoji-reaction chips even when the
status carries them (verified: `GET /statuses/88/context` returns ancestor
87 with `pleroma.emoji_reactions: [❤️×1]`, but the row renders only
reply/boost/star counts). Timeline rows and the thread's main status do
render chips. Descendant rows need verification + the same treatment.

## Acceptance Criteria

- Ancestor and descendant rows in the thread view render reaction chips
  (with counts and `me` state) whenever `pleroma.emoji_reactions` is
  non-empty, consistent with timeline rows.
- Playwright coverage with mocked context payloads carrying reactions on
  both ancestors and descendants.
