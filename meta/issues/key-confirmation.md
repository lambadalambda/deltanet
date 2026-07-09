# Active key confirmation for unpinned authors (close the TOFU stranger window)

## Summary

Relayed content (held envelopes, boost embeds) from a NEVER-MET author
currently renders fully attributed on its self-certifying signature alone —
a forged envelope under a fresh key claiming a stranger's address renders
until real contact happens to occur. Since content envelopes carry the
author's contact invite, we can close this actively: confirm the key with
the original poster. Chosen variant (b)+(c) from the design discussion:

- **(c) Honest rendering**: content whose author has NO pinned key renders
  with an explicit "unconfirmed author" treatment
  (`pleroma.deltanet.author_unconfirmed`) instead of looking identical to
  pin-checked content.
- **(b) Confirm on thread view**: when a thread render surfaces held/embed
  content from an unpinned author, the daemon confirms in the background —
  introduce via the carried invite (existing `keyContactOrIntroduce`:
  checkQr gate + post-join address check), then send an ordinary
  `envelope-request` for that post's uuid DIRECTLY to the author. No new
  wire verb: the author serves their own signed copy over the PGP-verified
  channel.

Why not eager-on-ingest: a securejoin is visible to the author — eager
fetching turns every backfilling lurker into a join event (metadata leak +
noise) and violates the standing "introduction only on explicit need" rule.
Thread-view gating bounds it to actual reader interest.

## Key mechanism: the self-served-bundle pin rule

Pins are currently written ONLY from the outer envelope of direct content
deliveries. Bundles are unsigned control messages, so the author serving
their own post wouldn't pin them. New rule, equally sound: **a bundle item
that `verify()`s against the SENDER's OWN address pins
`senderAddr -> item.pubkey`** — the author themselves, over a
PGP-verified direct channel, attested this envelope as their own. An
attacker can only pin their OWN address this way, exactly like any direct
content message. Relayed items (author ≠ sender) still never pin.

Outcomes after confirmation, on the next render:
- Pin matches the held/embedded envelope → renders confirmed (flag off).
- Pin conflicts → the existing verify ladder drops/placeholders it —
  the forgery is positively detected rather than optimistically shown.

## Scope

- Direct-delivery TOFU pinning is UNCHANGED (it is already
  fetch-equivalent: same PGP channel). This only replaces the
  "no pin → render attributed silently" fallback.
- Trigger: thread/context + orig-status renders. Timeline boost embeds
  from strangers get the unconfirmed MARK but no auto-confirm (a timeline
  scroll must not fan out securejoins); opening the thread confirms.
- Per-addr in-memory attempt cache so repeated renders never spam
  introductions (plus the existing 10-min introduce negative cache).
- Stale/failed invite → content simply stays marked unconfirmed (honest).

## Acceptance Criteria

- A held/embedded status from an unpinned author carries
  `pleroma.deltanet.author_unconfirmed: true` and the UI shows a distinct
  treatment; pinned-and-matching content shows none.
- Viewing a thread with such content triggers ONE background confirmation
  per author; after the author serves their copy, the pin exists and the
  next render drops the flag (integration test over the relay).
- A bundle item from a relayer (author ≠ sender) NEVER pins; a
  self-served item pins the sender only.
- A forged envelope (wrong key, real author invite) flips to
  dropped/unverified after confirmation instead of continuing to render.
