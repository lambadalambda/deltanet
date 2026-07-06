# deltanet devlog

## 2026-07-06 — project start

Goal: Pleroma-like single-user backend, Mastodon client API in front,
Delta Chat/chatmail federation behind. Test frontend: PleromaNet.

### Decisions

- **Transport via `@deltachat/stdio-rpc-server` + `@deltachat/jsonrpc-client`
  (v2.53.0)** — prebuilt core binary, typed JSON-RPC client. We don't touch
  SMTP/IMAP/Autocrypt ourselves at all.
- **Feed = broadcast channel, follow = securejoin invite link.** Verified by
  integration test: `createBroadcast` + `getChatSecurejoinQrCode` +
  `secureJoin` works on core 2.53 — followers get a read-only `InBroadcast`
  chat. (Original plan was symmetric group chats as fallback; not needed.)
- **IDs**: Mastodon status id = DC message id (per-account integer, decimal
  string; monotonic so max_id/min_id pagination works). Account id = DC
  contact id. Fine for single-user; revisit if multi-account.
- **OAuth is auto-granted**: `/oauth/authorize` immediately redirects back
  with a static code; any Bearer token is accepted. The daemon is
  single-user and binds to localhost — authenticating yourself to yourself
  adds nothing yet.
- Accounts registered on nine.testrun.org (chatmail testing relay) via
  `POST /new`. Credentials live in gitignored `accounts.local.json`.

### Findings

- Full federation round-trip (register → invite → securejoin → post →
  E2E-encrypted delivery) over nine.testrun.org takes ~9s end to end.
  Securejoin handshake itself completes in a few seconds when both sides
  are online.
- The transport layer has no unit tests (network-bound by nature); it is
  covered by `tests/integration/federation.test.ts` instead. TDD applies to
  the mapping + API layers, which take the transport behind an interface.
- First `IncomingMsg` after a join can be a securejoin system message, not
  the followed feed's post — consumers should filter/poll, not assume.

### End-to-end result (same day!)

PleromaNet signs in against the daemon (OAuth auto-grant → token →
verify_credentials), renders the home timeline, and posting from the
composer delivers over chatmail to followers. Ran two daemons (alice :4030,
bob :4031, separate testrun.org accounts), followed each other via
`/api/deltanet/invite` + `/api/deltanet/follow`, posts flow both ways.

Surprises / follow-ups:

- **Followers received posts made *before* they followed** — the core seems
  to re-deliver recent broadcast history to new members. That's the backfill
  problem solved for free; verify the mechanism and its limits.
- `parentId` is sometimes set on plain broadcast messages (saw a post with
  `in_reply_to_id` pointing at a securejoin system message). May need to
  suppress in mapping unless it's a real reply.
- SELF contact's `displayName` is a placeholder ("Me") — worked around by
  reading the `displayname` config in `transport.self()`. The UI shows "Me"
  as the account name otherwise.
- PleromaNet requires node 24 (mise); run it with `mise exec -- pnpm dev`.

### PleromaNet API surface (from code survey)

Hard requirements: `POST /api/v1/apps`, `GET /oauth/authorize`,
`POST /oauth/token`, `verify_credentials`, `GET /api/v1/timelines/home`
(+`Link` pagination header), `GET /api/v2/instance`, `POST /api/v1/statuses`
(form-encoded). CORS for the vite origin. Streaming websocket is optional —
frontend falls back to 60s polling. `http://localhost` is accepted by the
sign-in form. Statuses should carry a `pleroma` object (emoji_reactions etc.)
but empty defaults are fine.
