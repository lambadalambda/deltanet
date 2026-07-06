# deltanet

A single-user, Pleroma-style social backend that federates over **chatmail**
(the Delta Chat transport: SMTP/IMAP + Autocrypt E2E encryption) instead of
ActivityPub. You point a Mastodon/Pleroma frontend (we test with
[PleromaNet](../pleromanet)) at a local daemon; the daemon speaks the Mastodon
client API on one side and Delta Chat JSON-RPC on the other.

```
PleromaNet (or any Mastodon client)
      │  Mastodon client API (HTTP, localhost)
┌─────▼─────────────────────────┐
│ deltanet daemon               │
│ Mastodon API ⇄ chat messages  │
└─────┬─────────────────────────┘
      │  JSON-RPC (stdio)
 deltachat-rpc-server (chatmail core)
      │  SMTP/IMAP + Autocrypt
 any email / chatmail server (we use nine.testrun.org)
```

## Model (v0)

- Your identity is a chatmail address (instant registration on chatmail relays).
- Your **feed** is a group chat you own. **Following** someone = joining their
  feed group via its securejoin invite link. **Posting** = sending a message to
  your feed group; the mail infrastructure does store-and-forward delivery.
- The **home timeline** is every message in every feed you've joined.
- Everything is E2E-encrypted; the servers only see ciphertext.

v0 uses symmetric group chats, so technically followers can post into your
feed. Broadcast channels (one sender, read-only members) are the intended
upgrade — see DEVLOG.

## Running

```sh
pnpm install
pnpm setup-account        # registers a chatmail account, writes accounts.local.json
pnpm start                # Mastodon API on http://localhost:4030
```

Then start PleromaNet with `PUBLIC_PLEROMA_INSTANCE_URL=http://localhost:4030`
and sign in — OAuth is auto-granted (single-user daemon, no password).

Useful endpoints beyond the Mastodon API:

- `GET /api/deltanet/invite` — your feed's invite link (give this to followers)
- `POST /api/deltanet/follow` — body `{"invite": "<link-or-qr-payload>"}` joins a feed

## Testing

```sh
pnpm test               # unit tests (pure mapping + API with fake transport)
pnpm test:integration   # real federation over nine.testrun.org (slow, network)
pnpm check              # typecheck
```

## Development principles

- TDD (red → green → refactor); transport is behind an interface so the API
  layer is unit-testable with a fake.
- Functional TypeScript, small topical commits (conventional commits).
- Findings and decisions go to `DEVLOG.md`.
