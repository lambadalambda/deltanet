# 64 Render reaction chips on thread ancestors and descendants (done)

## Summary

The thread view's ancestor rows do not render emoji-reaction chips even when the
status JSON carries `pleroma.emoji_reactions` (daemon-verified: the context
endpoint returns an ancestor with `[{name:"❤️",count:1,me:false}]` but the row
shows only reply/boost/star counts). Timeline rows and the thread's main
(focused) status do render chips. Descendant (reply) rows have the same gap.

## Root Cause

`Post.svelte` (timeline rows) and `FocusedPost.svelte` (thread main status)
render `<PostReactions .../>` immediately above `<PostActions .../>`.
`AncestorPost.svelte` (ancestor rows) and `ReplyPost.svelte` (descendant/reply
rows) render only `<PostActions .../>` and never import or render
`PostReactions`. The reaction data is already present on the post objects
(`threadPostForRebuild` -> `postForRebuild` copies `reactions`), and the page's
`onAction`/`onReact` callbacks already handle `reaction:${name}` toggles and the
add-reaction anchor for these components. So the fix is purely presentational:
add `PostReactions` to both components, wired the same way as the timeline row.

## Requirements

- Ancestor rows render reaction chips (glyph/custom image + count + me-state
  styling) whenever `emoji_reactions` is non-empty.
- Descendant (reply and nested reply) rows render reaction chips the same way.
- Both include the add-reaction affordance, consistent with timeline rows.
- Toggle and add-reaction wiring flows through the existing thread
  `onAction`/`onReact` handlers (optimistic + reconciled, already implemented).

## Acceptance Criteria

- Playwright coverage mocks `/statuses/:id/context` with reactions on both an
  ancestor and a descendant and asserts chips render on both rows, including
  me-state styling on one.
- `pnpm test` and `pnpm check` are green.

## Notes

- Reuse `PostReactions.svelte` rather than duplicating the chip markup.
