# Emoji normalization (❤ vs ❤️)

## Summary

Reactions arrive in both bare (`❤` U+2764) and variation-selector
(`❤️` U+2764 U+FE0F) forms; the store tallies them as different emoji
(observed live: one post with both forms as separate entries), and a VS16
heart doesn't count as a favourite (★0 plus a stray ❤️ chip).

## Requirements

- Normalize emoji when storing and comparing reactions: strip U+FE0F
  variation selectors (and skin-tone-safe: only the VS, don't mangle ZWJ
  sequences). One normalize helper used by: reaction apply/retract,
  tallies, favourite detection, the reaction endpoints (after URL decode),
  and outgoing reaction text building.
- Any normalized `❤` counts as a favourite (favourites_count/favourited);
  non-heart emoji tally under their normalized form.
- Existing store data heals via the same re-index migration as the
  canonical-mid issue (tallies are re-derived from messages).

## Acceptance Criteria

- A ❤️ (VS16) reaction from another client counts as a favourite: star
  count increments, no separate ❤️ chip.
- Unit tests: normalization cases (bare, VS16, non-heart, multi-codepoint
  emoji stay intact), tally merging.
