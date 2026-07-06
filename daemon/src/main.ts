import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { readAccounts, writeAccount } from './config.js';
import { createApp, type AppContext } from './server.js';
import { registerAccount } from './signup.js';
import { openTransport, type ChatmailCredentials, type IngestPhase } from './transport/deltachat.js';
import type { Transport } from './transport/types.js';
import { createStore } from './store.js';
import { deriveOnIngest } from './ingest.js';
import { createStatusMapper, mapNotification } from './mapping.js';
import { createStreamingHub } from './streaming.js';
import type { T } from '@deltachat/jsonrpc-client';

const PORT = Number(process.env['PORT'] ?? 4030);
const ACCOUNT = process.env['DELTANET_ACCOUNT'] ?? 'main';
const DATA_DIR = process.env['DELTANET_DATA'] ?? `data/${ACCOUNT}`;
const BASE_URL = process.env['DELTANET_BASE_URL'] ?? `http://localhost:${PORT}`;
const ACCOUNTS_FILE = process.env['DELTANET_ACCOUNTS'] ?? 'accounts.local.json';
const STATIC_DIR_CONFIG = process.env['DELTANET_STATIC'] ?? '../frontend/build';
const STATIC_DIR = resolve(process.cwd(), STATIC_DIR_CONFIG);

// One deltanet wire-convention store per account data dir, shared between
// the transport's ingestion hook (timeline loads + IncomingMsg events) and
// the API layer's mapping/context assembly.
const store = createStore(join(DATA_DIR, 'deltanet-store.json'));

// Streaming websocket hub (see ./streaming.ts) + the same status/notification
// mapping REST responses use (see ./mapping.ts), so live-streamed frames are
// never a divergent JSON shape from `GET /api/v1/timelines/*` or
// `GET /api/v1/notifications`.
const hub = createStreamingHub();
const mapper = createStatusMapper(store, BASE_URL);

const announce = async (transport: Transport) => {
  const self = await transport.self();
  console.log(`logged in as ${self.displayName} <${self.address}>`);
  console.log(`your feed invite: ${await transport.feedInvite()}`);
};

let transport: Transport | null = null;

// Takes the resolved `mid` as an argument instead of calling back into the
// module-level `transport` variable below. `openTransport` fires its
// startup backfill sweep (and may deliver live core events) *before* it
// resolves, but `transport` is only assigned after `await openTransport(...)`
// returns — so a `transport === null` guard here would silently drop every
// message the backfill sweep or an early event delivered. See DEVLOG.
//
// `phase` distinguishes the transport's two ingestion modes (see
// `IngestPhase`): live events and ordinary timeline/message loads always
// pass `'combined'`, doing both halves below in one call, exactly as before
// `phase` existed. Only the startup backfill sweep splits the same message
// into two separate calls — `'index'` (mid/msgId bookkeeping only) across
// *every* backfilled message, then `'derive'` (notification/reaction side
// effects) across all of them again — so that derivation for any one
// message never runs before every other backfilled message (regardless of
// chat sweep order) has already updated the store's `ownMids` index. See
// DEVLOG for the notification-loss bug this fixes.
//
// `store.ingestMessage`'s own `ingestedMsgIds` dedupe only guards the index
// half (re-running `'index'` for an already-ingested msgId is a no-op by
// design); it must never also suppress the `'derive'` call for that same
// msgId, or the second backfill pass would derive nothing. Calling
// `deriveOnIngest` unconditionally (outside any ingested-check) keeps that
// guard scoped to indexing only — derivation has its own, separate dedupe
// (`notificationDedupeKeys`).
//
// Streaming only happens for `phase === 'combined'` — i.e. live core events
// and ordinary timeline/message loads — never for the `'index'`/`'derive'`
// startup backfill sweep, which is explicitly historical. `hub.broadcastUpdate`
// has its own msgId dedupe on top (a single live message can still reach here
// twice, e.g. IncomingMsg + a MsgsChanged safety-net delivery for the same
// msgId — see deltachat.ts), so double-firing this function is harmless.
// Mapping/broadcasting needs a live `Transport` (to resolve accounts/embedded
// boosts); if `transport` hasn't been assigned yet (the same startup race the
// `mid`-passing trick above works around for indexing) a live event is simply
// not streamed — acceptable for a best-effort UI nicety, unlike indexing.
const ingestOnMessage = async (
  msg: T.Message,
  isFeedMessage: boolean,
  mid: string | null,
  phase: IngestPhase,
) => {
  if (!mid) return;
  if (phase === 'combined' || phase === 'index') {
    store.ingestMessage(msg, mid, isFeedMessage);
  }
  let newNotifications: ReturnType<typeof deriveOnIngest> = [];
  if (phase === 'combined' || phase === 'derive') {
    newNotifications = deriveOnIngest(store, msg, mid);
  }

  if (phase !== 'combined') return;
  const t = transport;
  if (!t) return;

  // No media alt-text description is available here: `mediaStore` (uploaded
  // attachment descriptions) lives inside `createApp`'s closure in
  // server.ts, keyed only by messages this same process has *uploaded*
  // through `/api/v1/media` — not plumbed out to `main.ts` (doing so would
  // mean changing `createApp`'s return shape, which every test/call site
  // treats as the bare Hono app). A streamed status for a freshly-posted
  // image is missing its alt text for the split second until the client's
  // next poll/refetch re-maps it via the REST endpoint (which does have
  // `mediaStore`); acceptable for a best-effort live nicety.
  const noDescription = (_msgId: number): string | null => null;

  if (isFeedMessage) {
    try {
      const status = await mapper.toStatus(t, msg, noDescription(msg.id));
      hub.broadcastUpdate(status, msg.id);
    } catch (err) {
      console.error('streaming: failed to map/broadcast status (non-fatal):', err);
    }
  }

  for (const notification of newNotifications) {
    try {
      hub.broadcastNotification(await mapNotification(notification, t, mapper, BASE_URL, noDescription));
    } catch (err) {
      console.error('streaming: failed to map/broadcast notification (non-fatal):', err);
    }
  }
};

/** New-follower notification: SecurejoinInviterProgress===1000 means someone just joined our feed broadcast. */
const notifyFollower = async (contactId: number) => {
  const t = transport;
  if (!t) return;
  const contact = await t.contact(contactId).catch(() => null);
  if (!contact) return;
  const notification = store.addNotification({
    type: 'follow',
    accountAddr: contact.address,
    accountContactId: contactId,
  });
  if (!notification) return;
  try {
    hub.broadcastNotification(await mapNotification(notification, t, mapper, BASE_URL, () => null));
  } catch (err) {
    console.error('streaming: failed to map/broadcast follow notification (non-fatal):', err);
  }
};

const creds = readAccounts(ACCOUNTS_FILE)[ACCOUNT];
if (creds) {
  console.log(`configuring ${creds.addr} (data: ${DATA_DIR}) ...`);
  transport = await openTransport(DATA_DIR, creds, { onMessage: ingestOnMessage });
  transport.onFollower(notifyFollower);
  await announce(transport);
} else {
  console.log(
    `no account "${ACCOUNT}" configured yet — POST /api/deltanet/signup to create one`,
  );
}

const ctx: AppContext = {
  getTransport: () => transport,
  signup: async (displayName, relay) => {
    const { addr, password } = await registerAccount(relay);
    const newCreds: ChatmailCredentials = { addr, password, displayName };
    writeAccount(ACCOUNTS_FILE, ACCOUNT, newCreds);
    const opened = await openTransport(DATA_DIR, newCreds, { onMessage: ingestOnMessage });
    opened.onFollower(notifyFollower);
    transport = opened;
    await announce(opened);
    return opened;
  },
};

const staticDir = existsSync(STATIC_DIR) ? STATIC_DIR : undefined;
if (staticDir) console.log(`serving static frontend from ${staticDir}`);

const app = createApp(ctx, { baseUrl: BASE_URL, staticDir, store, upgradeWebSocket, hub });

// `@hono/node-server`'s v2 websocket support is just `serve({ ..., websocket:
// { server } })` with a `ws.WebSocketServer` created in `noServer: true` mode
// (it hooks the returned HTTP server's own 'upgrade' event itself) — no
// separate `injectWebSocket(server)` call needed, unlike the older
// `@hono/node-server/ws`/`createNodeWebSocket` API.
const wss = new WebSocketServer({ noServer: true });
serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
console.log(`deltanet: mastodon api on ${BASE_URL}`);
