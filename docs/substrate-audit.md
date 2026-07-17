# The substrate: what chatmail/Delta Chat actually gives us

Audit of chatmail relay (github.com/chatmail/relay + filtermail v0.7.4) and
core (github.com/chatmail/core, v2.53.0 snapshot, 2026-06). Facts verified
against source by two research passes on 2026-07-06; citations live in the
underlying repos. This is the reference sheet — the interpretation is in
[federation-comparison.md](federation-comparison.md).

## Hard numbers

| Constraint | Value | Where |
|---|---|---|
| Outbound cleartext | **forbidden** (`523 Encryption Needed`), exemptions: securejoin vc/vg-request, self-addressed Autocrypt Setup | filtermail `outbound.rs` |
| Send rate | 60 msgs/min, burst 10, per sender (GCRA); over → `450` (retryable) | filtermail, relay config |
| Recipients per SMTP transaction | ~1000 (Postfix default, relay doesn't override); core chunks at **999** on chatmail (50 on classic mail) | `constants.rs:205/208` |
| Message size | 30 MiB relay cap; core recommends ≤18 MB files; images auto-scaled to 1280px/~500 KB by default | relay config, `mimefactory.rs:44` |
| Mail retention on relay | **20 days** (7 days if >200 KB); quota 500 MB with oldest-first eviction to 70% (last 24 h protected) | `expire.py`, relay config |
| Account expiry | **90 days** without login → entire mailbox deleted | `expire.py:160`, config |
| Account creation | POST /new, 9-char username, 12-char password, no captcha, no per-IP limit on production relays; created on first login | `newemail.py`, `doveauth.py` |
| Broadcast join backfill | **last 10 messages**, count-based (no age bound), excludes webxdc + info messages | `constants.rs:237`, `chat.rs:3986` |
| Webxdc status update | ≤100 KB per update, ~1/s sustained (3s/3-burst core ratelimit) | `webxdc.rs:242`, `context.rs:494` |
| Webxdc realtime (iroh) | ≤128 KB/msg, direct P2P gossip, sub-second, bypasses email entirely | `peer_channels.rs:269` |
| Inbound cleartext | rejected **by default** (`enforceE2EEincoming` set on account creation); inbound requires valid DKIM (no SPF/DMARC/iprev used) | `user.py:60`, `inbound.rs` |

## Facts that shaped/corrected our design

- **Broadcast channels are encrypted with a per-channel symmetric secret**,
  not per-recipient PGP (the secret is handed to members on join). One body
  encryption per post regardless of follower count; fan-out cost is
  envelope-only, chunked at 999 recipients per submission. The former README
  wording "encrypted per follower" was wrong in mechanism (right in effect).
  Channels were promoted from experimental to official *recently* — the wire
  format changed within the last few releases (`BROADCAST_INCOMPATIBILITY_MSG`)
  and is **not yet in spec.md**. Our feed primitive rides the least-stable,
  least-standardized part of core.
- **The 10-message join backfill** we celebrated as "free history" is exactly
  10 messages, newest-first, and never includes webxdc content. It's a
  courtesy, not a sync mechanism. (Webxdc status updates, by contrast, replay
  in full from a serial — a genuinely better backfill channel.)
- **ContactId is an ephemeral SQLite rowid.** The stable identity of a
  key-contact is its **key fingerprint**; address-contacts (keyless) exist as
  separate rows for the same address, and a key rotation creates a *new*
  contact. This explains the contact-id shifts we observed, and means our
  Mastodon API's account ids (contact ids) are per-database handles, not
  stable identifiers. Design debt, noted.
- **Read-only channels are client-enforced, not transport-enforced** — a
  subscriber holding the channel secret could craft a message; core refuses,
  the wire doesn't. Threat-model footnote, not a practical issue.
- **Follower lists are hidden by design**: channel owner and subscribers are
  mutually hidden contacts; recipients travel as `hidden-recipients`. The
  substrate cannot enumerate an audience — our follower *count* (from the
  owner's member list) is the only figure that exists anywhere.
- **Core's threading parent comes from `In-Reply-To` only** (not
  `References`); we don't set it, which is why we had to kill the `parentId`
  fallback. If we ever want vanilla-DC-visible threading, setting In-Reply-To
  on replies is the lever.
- **Reactions and edits have standardized wire forms** (RFC 9078 reactions;
  `Chat-Edit`/`Chat-Delete` headers in spec.md). Our reaction control-DMs are
  a parallel convention forced by read-only channels — but they *could* carry
  RFC 9078 format for interop. Post edit/delete-for-all have no time limits,
  are own-messages-only, and delete requires the message to have been
  encrypted.
- **Metadata posture is better than assumed**: outer Subject is literally
  `[...]`, outer Date is randomized within ±7 days, recipients are
  `hidden-recipients`, submission IPs are stripped. What the relay operator
  still sees: sender address, RCPT TO set, sizes, timing. FAQ states it
  plainly: "message date, sender and receiver addresses."
- **The relay does no spam/content filtering by design** — trust is
  cryptographic (TLS-verify + strict DKIM + mandatory PGP). There are three
  independent relay implementations; the relay behavior is effectively a
  spec.
- **Untapped capabilities relevant to us**: webxdc (sandboxed apps in
  messages with synced state + full-history replay + per-recipient notify
  text), iroh-gossip realtime P2P channels, location streaming/POI with KML,
   1:1 calls, multi-device via encrypted backup transfer + self-sync
  messages, read receipts (MDN, rate-limited).
