# Emoji normalization (❤ vs ❤️) — WITHDRAWN

## Summary

Originally proposed merging bare `❤` (U+2764) and `❤️` (U+2764 U+FE0F)
reaction forms and counting any heart as a favourite.

**Withdrawn after user review (2026-07-06): the premise was wrong.** The
two forms are two *distinct interactions by design*: bare `❤` is the wire
encoding of a favourite (star button), while `❤️` with the variation
selector is a deliberate red-heart *emoji reaction* from the picker. A
store entry holding both forms for one user reflects two intentional acts
(favourited AND heart-reacted), not duplication. Merging them would
destroy the favourite/reaction distinction.

## Notes

- Known subtlety, accepted: the distinction rides on the variation
  selector's presence. Emoji pickers emit the VS16 form, so in practice a
  bare ❤ only ever originates from the favourite path.
