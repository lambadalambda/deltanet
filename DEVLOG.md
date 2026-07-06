# deltanet devlog

## 2026-07-06 — project start

Goal: Pleroma-like single-user backend, Mastodon client API in front,
Delta Chat/chatmail federation behind. Test frontend: PleromaNet.

### Decisions

- **Transport via `@deltachat/stdio-rpc-server` + `@deltachat/jsonrpc-client`
  (v2.53.0)** — prebuilt core binary, typed JSON-RPC client. We don't touch
  SMTP/IMAP/Autocrypt ourselves at all.
- **Feed = group chat, follow = securejoin invite link (v0).** Broadcast
  channels (`createBroadcast`) would give proper read-only feeds, but the
  join story over securejoin for broadcasts needs verification; groups are
  battle-tested. Trade-off: followers can post into your feed group in v0.
- **IDs**: Mastodon status id = DC message id (per-account integer, decimal
  string; monotonic so max_id/min_id pagination works). Account id = DC
  contact id. Fine for single-user; revisit if multi-account.
- **OAuth is auto-granted**: `/oauth/authorize` immediately redirects back
  with a static code; any Bearer token is accepted. The daemon is
  single-user and binds to localhost — authenticating yourself to yourself
  adds nothing yet.
- Accounts registered on nine.testrun.org (chatmail testing relay) via
  `POST /new`. Credentials live in gitignored `accounts.local.json`.

### PleromaNet API surface (from code survey)

Hard requirements: `POST /api/v1/apps`, `GET /oauth/authorize`,
`POST /oauth/token`, `verify_credentials`, `GET /api/v1/timelines/home`
(+`Link` pagination header), `GET /api/v2/instance`, `POST /api/v1/statuses`
(form-encoded). CORS for the vite origin. Streaming websocket is optional —
frontend falls back to 60s polling. `http://localhost` is accepted by the
sign-in form. Statuses should carry a `pleroma` object (emoji_reactions etc.)
but empty defaults are fine.
