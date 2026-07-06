# Real-time streaming (Mastodon websocket API)

## Summary

The daemon is internally real-time (IMAP IDLE push + event-driven ingestion)
but the browser polls every 60s. Implement the Mastodon streaming websocket
so the frontend — which already tries to connect and degrades gracefully —
lights up with live updates.

## Requirements

- `GET /api/v1/streaming` (tolerate trailing slash) upgrading to a
  websocket; query params `stream` (`user`, `public`, `public:local`) and
  `access_token` (accept any, consistent with the single-user auth model).
  Match the exact URL/frame shape the frontend uses (read its streaming
  client code — read-only — before implementing).
- Frames: Mastodon text frames
  `{"stream":["user"],"event":"update","payload":"<JSON-encoded status>"}`;
  `update` for new feed statuses (including own posts), `notification` for
  newly derived notifications (user stream only). Payload mapping must reuse
  the same status/notification mapping (resolver/store) as the REST
  endpoints — no divergent JSON shapes.
- Source events from the LIVE ingestion path only (transport event
  subscriptions); startup backfill and timeline-load ingestion must not
  stream historical messages. Dedupe repeated core events per message
  (MsgsChanged fires on state changes) so a status streams at most once.
- Keepalive (ws ping ~30s), connection cleanup on close/error.
- New dependency allowed for the websocket server glue
  (`@hono/node-server/ws` + `ws`).

## Acceptance Criteria

- With the UI open and no manual refresh, a post from the other node
  appears in the home timeline within a few seconds, and a like/reply from
  the other node raises the notification badge live.
- Unit tests: streaming hub (fake connections) — frame format, stream
  filtering (user vs public), dedupe, cleanup.

## Current Status (2026-07-06)

Implemented. `GET /api/v1/streaming` (+ trailing-slash) upgrades to a
websocket; `src/streaming.ts` (new) holds the hub (`createStreamingHub`),
the `stream`-param resolver (`resolveStreamName`), and the ws-event wiring
(`createStreamingEvents`, incl. the 30s keepalive ping + cleanup) — all
unit-tested with fake sockets, no `ws` import in that file at all. Frame
shape matches the frontend's `parsePleromaStreamingMessage` exactly
(`{stream:[...], event, payload: <JSON string>}`, double-JSON-encoded).
`src/mapping.ts` (new) factors the status/notification JSON mapping out of
`server.ts` so `main.ts`'s live-ingestion path (`phase === 'combined'` only
— backfill never streams) broadcasts using the identical mapping the REST
endpoints use. `deriveOnIngest` (`src/ingest.ts`) now returns the
notifications it actually created, which `main.ts` broadcasts per-item;
follow notifications broadcast from `onFollower` the same way.

Dependency note: the issue mentioned `@hono/node-server/ws` +
`createNodeWebSocket`, but that's the older `@hono/node-server` v1 API
(actually shipped as the separate `@hono/node-ws` package, which pins
`@hono/node-server ^1.19.11` — incompatible with this repo's `^2.0.8`).
`@hono/node-server` v2 exports `upgradeWebSocket` directly from its root
and needs no `injectWebSocket` step — just
`serve({fetch, websocket: {server: wss}})` with a
`new WebSocketServer({noServer: true})`. Added `ws` + `@types/ws`; no
`pnpm-workspace.yaml` build-approval changes needed.

`pnpm test` (382 tests) and `pnpm check` green. Manually smoke-tested the
real HTTP->websocket upgrade end to end via `curl` (got a genuine `101
Switching Protocols`). Did not run `pnpm test:integration`. One accepted
gap: live-streamed statuses for a freshly-uploaded image don't carry alt
text (self-heals on the client's next REST poll) — see DEVLOG for why.
