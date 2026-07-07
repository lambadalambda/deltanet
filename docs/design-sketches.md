# Design sketches (not scheduled)

Ideas explored 2026-07-07, downstream of the
[federation comparison](federation-comparison.md). None scheduled; captured
so the reasoning isn't lost. Common pattern across all three: **the party
that already has the data becomes a publisher** — the substrate's native
substitute for the fediverse's global fetchability.

## 1. Visibility tiers via multiple channels (not multiple accounts)

One account can own many broadcast channels; invites are per-channel and
multi-use (with withdraw/revive support in core). So:

- **public channel** — invite auto-granted to anyone (existing
  invite-request convention), link published in bio/QR/directory.
- **locked channel** — approval-gated grants (locked-mode hook).
- Mastodon visibility dropdown maps natively: `public` → public channel,
  `private` → locked channel. Today the selector is decorative; this makes
  it real. Do NOT model this as two accounts: splits identity, doubles key
  management, forces followers to manage two contacts.

Discovery ("announce the invite somewhere") = a **directory node**: a
well-known deltanet account that auto-grants follows, accepts listing
submissions as DMs (profile card + public-channel invite), republishes the
directory as a feed — and, being an ordinary server, can also serve an
HTTPS listing site (web presence without violating the relay's
no-cleartext rule).

## 2. Verifiable reaction gossip: portable receipts

Reaction gossip (author publishes tally digests to followers) is trusted
by default — the author could lie. Upgrade: make each reaction DM a
self-contained **signed assertion** ("addr X reacts ❤ to u:<uuid>"); the
author's digest then republishes receipts, not bare counts. Followers who
hold the reactor's key (Autocrypt gossip spreads keys anyway) verify
offline. Large counts: count + sampled receipts + rest on demand.
Fallback for unverifiable receipts: automated challenge-response
(`⁇ attest u:<uuid> ❤` → signed confirm/deny from the reactor's daemon)
— trust by default, verify when curious.

Honest limit: receipts prevent **author forgery**, not **sybil
inflation** — instant free signup means a liar can mint real accounts
with real signatures. Different layer, not solvable here.

## 3. Subscribable threads: root author as thread host

The root author's node already receives every reply (reply DM copies).
Make it publish:

- Lazy **thread channel** (broadcast owned by root author) created on
  first subscriber.
- Subscribe = scoped invite-request (`⇋ invite-request thread:u:<uuid>`),
  auto-granted.
- Host republishes every reply it receives, boost-style embed + original
  `⚑` uuid (+ signed receipt for provenance once sketch 2 exists).

Properties: complete threads for subscribers even when participants are
mutual strangers (also retroactively fixes third-party reply-visibility
gaps); **reply control** for the root author (declining to republish =
thread moderation the fediverse can't cleanly do). Wart: the 10-message
join backfill — host should send a "thread so far" bundle to new
subscribers; long-term, thread-as-webxdc gives full update-replay history
and is probably webxdc's first natural use here.
