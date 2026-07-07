# Interactions with embed-only posts (favourite/reply/boost via uuid refs)

## Summary

A verified boost embed can now be VIEWED (timeline + thread view render
it with contact-first attribution), but not acted on: favourite, reply,
reblog, and reactions on an `orig-<uuid>` status return 404 — the action
handlers require a locally-held message to derive a ref token from
(deliberately scoped out of issues/orig-status-thread-view.md).

There is no wire-level blocker: v2 refs target posts by author-minted
uuid, and the verified embed carries everything an interaction needs —
the uuid, the author's addr (control-DM recipient for reactions/likes),
and the attested content itself. A recipient who can verify a post can
meaningfully react to it.

## Design questions to settle first (docs/design-sketches.md material)

- Reply threading: our reply convention DMs a copy to the parent author
  and threads via the parent's post key. Replying to an embed-only post
  means the replier holds no copy of the parent message — the reply's
  local thread view would climb to... the verified embed (resolvable via
  the boost index), which the thread-view fix already renders. Probably
  fine; verify the ancestor walk handles a uuid-ref parent we never held.
- Favourites/reactions: control DM to the author addr keyed on the uuid
  ref — the author holds the original, so tallies stay authoritative on
  their side, same as today. The interacting node's own tally for the
  embed would need the store to track reactions under the uuid post key
  it doesn't otherwise index (partially exists via boostsByMid).
- Boosting an embed-only post: we hold the signed `orig` envelope, so we
  can re-embed it verbatim — attestations make second-hand boosts sound
  (a boost-of-a-boost carries the SAME author-signed orig, no trust
  chain needed). Should be allowed iff the orig verifies.
- Reaction receipts (design sketch #2) overlap: receipts may change how
  reactions on non-held posts are represented — spec these together or
  sequence receipts first.

## Acceptance Criteria (draft — refine when picked up)

- From a node that only knows a post through a verified boost embed:
  favourite, emoji reaction, reply, and boost all work; the author sees
  them exactly as if the interactor held a direct copy; tampered/
  unverified embeds stay non-actionable (404).
- No synthesized statuses anywhere in the flow (0002).
- Unit + integration coverage (A/B/C topology extended with C
  interacting with A's post through B's boost).
