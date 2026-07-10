import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { readAccounts, writeAccount } from './config.js';
import { createApp, type AppContext } from './server.js';
import { registerAccount } from './signup.js';
import {
  openTransport,
  restoreTransport,
  type ChatmailCredentials,
  type IngestPhase,
} from './transport/deltachat.js';
import type { Transport } from './transport/types.js';
import { createStore } from './store.js';
import { deriveOnIngest, runFollowbackOnIngest } from './ingest.js';
import { createStatusMapper, mapNotification } from './mapping.js';
import { createStreamingHub } from './streaming.js';
import { createBackfiller, type SendRequest } from './backfill.js';
import { buildEnvelopeRequest, type EnvelopeRef } from './envelope.js';
import { parseWire } from './wire.js';
import {
  enqueueDangling,
  handleBackfillControlDm,
  seedBackfillQueue,
  MAX_SERVE_RESPONSES_PER_MINUTE,
} from './backfill-ingest.js';
import {
  handleThreadChannelBundle,
  handleThreadInviteGrant,
  handleThreadInviteRequest,
  republishReplyToThread,
} from './thread-subscribe.js';
import type { T } from '@deltachat/jsonrpc-client';
import { createAuthStore } from './auth.js';
import { resolveListenerConfig } from './listener.js';

const { hostname: HOSTNAME, port: PORT } = resolveListenerConfig(process.env);
const ACCOUNT = process.env['DELTANET_ACCOUNT'] ?? 'main';
const DATA_DIR = process.env['DELTANET_DATA'] ?? `data/${ACCOUNT}`;
const BASE_URL = process.env['DELTANET_BASE_URL'] ?? `http://localhost:${PORT}`;
const ACCOUNTS_FILE = process.env['DELTANET_ACCOUNTS'] ?? 'accounts.local.json';
const AUTH_FILE = process.env['DELTANET_AUTH'] ?? `${DATA_DIR}.auth.json`;
const ALLOWED_ORIGINS = (process.env['DELTANET_ALLOWED_ORIGINS'] ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const STATIC_DIR_CONFIG = process.env['DELTANET_STATIC'] ?? '../frontend/build';
const STATIC_DIR = resolve(process.cwd(), STATIC_DIR_CONFIG);

// One deltanet wire-convention store per account data dir, shared between
// the transport's ingestion hook (timeline loads + IncomingMsg events) and
// the API layer's mapping/context assembly.
const store = createStore(join(DATA_DIR, 'deltanet-store.json'));
const auth = createAuthStore(AUTH_FILE);

// Streaming websocket hub (see ./streaming.ts) + the same status/notification
// mapping REST responses use (see ./mapping.ts), so live-streamed frames are
// never a divergent JSON shape from `GET /api/v1/timelines/*` or
// `GET /api/v1/notifications`.
const hub = createStreamingHub();
const mapper = createStatusMapper(store, BASE_URL, {
  blobUrl: (msgId) => {
    const signed = auth.signBlobPath(msgId);
    const url = new URL(`/deltanet/blob/${msgId}`, BASE_URL);
    url.searchParams.set('expires', String(signed.expires));
    url.searchParams.set('signature', signed.signature);
    return url.toString();
  },
});

// Thread auto-backfill (design-sketch #3): the auto-fetch loop that heals
// dangling reply/boost/root refs by asking the peer who showed them to us. The
// `send` seam emits ONE envelope-request control DM per peer batch, addressed by
// the peer's MESSAGE-DERIVED contact id (`peerContactId`, captured at enqueue
// from the surfacing message's `fromId`) — NEVER an addr lookup: DC core 2.x
// separates key-contacts from keyless address-contacts, and an addr-resolved id
// cannot be encrypted to even when the key-contact exists (see backfill.ts).
// A send before the transport is assigned (startup race) throws — the ref stays
// queued (not in-flight) for the next flush.
const sendBackfillRequest: SendRequest = async (_peer, peerContactId, refs: EnvelopeRef[]) => {
  const t = transport;
  if (!t) throw new Error('transport not ready'); // keeps refs queued (not in-flight)
  if (peerContactId === 1) throw new Error('unroutable backfill peer');
  await t.sendControlDm(peerContactId, buildEnvelopeRequest(refs));
};
const backfiller = createBackfiller({ store, send: sendBackfillRequest });

// Per-peer serve-side response rate limiter (max bundle replies/min per
// requester), so answering backfill requests never starves user actions.
const serveTimestamps = new Map<string, number[]>();
const serveGuard = (peer: string): boolean => {
  const now = Date.now();
  const recent = (serveTimestamps.get(peer) ?? []).filter((t) => t > now - 60_000);
  if (recent.length >= MAX_SERVE_RESPONSES_PER_MINUTE) {
    serveTimestamps.set(peer, recent);
    return false;
  }
  recent.push(now);
  serveTimestamps.set(peer, recent);
  return true;
};

// Memoized own account address, used to key SELF reaction re-derivation.
// Prefers the live transport's `self()` (the authoritative canonical address),
// but the startup backfill's 'derive' pass runs while the module `transport`
// var is still null — so it falls back to a SELF-authored message's own sender
// address (contact id 1's address IS our account address). Cached once resolved.
let selfAddrCache: string | null = null;
const ownSelfAddr = async (msg: T.Message): Promise<string | undefined> => {
  if (selfAddrCache) return selfAddrCache;
  if (transport) {
    selfAddrCache = (await transport.self()).address;
    return selfAddrCache;
  }
  return msg.fromId === 1 ? msg.sender.address : undefined;
};

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
  // `fresh` is `ingestMessage`'s freshness return: true iff this msgId has
  // never been ingested before. Captured here (the indexing call must run
  // before the follow-back block) so execute-once side effects below can be
  // gated on it — one live DM can arrive via both IncomingMsg AND the
  // MsgsChanged safety net (plus repeat MsgsChanged on state changes), and
  // without the gate a single invite-request would send one grant DM per
  // delivery.
  let fresh = false;
  if (phase === 'combined' || phase === 'index') {
    fresh = store.ingestMessage(msg, mid, isFeedMessage);
  }
  let newNotifications: ReturnType<typeof deriveOnIngest> = [];
  if (phase === 'combined' || phase === 'derive') {
    // Own address for SELF reaction re-derivation (see deriveOnIngest): a SELF
    // reaction control DM re-applies our own tally so a re-indexed store
    // recovers our reactions. `ownSelfAddr()` is memoized and works during the
    // startup backfill's 'derive' pass (when the module `transport` var is not
    // yet assigned) by falling back to the SELF message's own sender address.
    newNotifications = deriveOnIngest(store, msg, mid, await ownSelfAddr(msg));
  }

  // Follow-back control DMs (`⇋ invite-request` / `⇋ invite <link>`), DM-only
  // (`isFeedMessage` gates derivation — a broadcast post carrying the marker
  // must not make every follower auto-DM the poster). All the phase/freshness
  // rules live in `runFollowbackOnIngest` (see its doc comment): live
  // (`'combined'`) + freshly-ingested messages execute against the transport;
  // the `'derive'` backfill pass only runs the safe pending-state cleanup, so
  // a restart never re-grants or re-joins. The grant/accept decision itself is
  // store-gated (`store.hasPendingFollowRequest`), which is what prevents an
  // unsolicited `⇋ invite` DM from ever joining us to a feed.
  await runFollowbackOnIngest(store, transport, msg, isFeedMessage, phase, fresh);

  // Thread auto-backfill (design-sketch #3): dangling-ref detection + serve +
  // bundle receipt. All SUPPRESSED — no notifications, no streaming, held
  // envelopes never enter timelines (see backfill-ingest.ts).
  //  - On any freshly-indexed content message: enqueue its unresolved uuid refs
  //    against the sender (a met contact) for the auto-fetch loop. Runs in
  //    index/combined so the startup re-index seeds pre-existing dangling refs.
  if ((phase === 'combined' || phase === 'index') && fresh) {
    enqueueDangling(store, backfiller, msg);
  }
  //  - Live control DMs: serve an envelope-request / process an envelope-bundle.
  //    Combined phase + a live transport only (a restart replaying old control
  //    DMs must not re-serve; a served bundle is not persisted as sent). When
  //    handled, SKIP the streaming/notification tail below (they carry none).
  if (phase === 'combined' && transport) {
    const handled = await handleBackfillControlDm(
      store,
      backfiller,
      transport,
      msg,
      isFeedMessage,
      Date.now(),
      serveGuard,
    ).catch((err) => {
      console.error('backfill control-DM handling failed (non-fatal):', err);
      return false;
    });
    if (handled) {
      void backfiller.flush();
      return;
    }
  }

  // Thread subscribe (design-sketch #3, layers 2–3): all SUPPRESSED like backfill
  // (no notifications, no streaming, held content never in timelines).
  //  - Live SUBSCRIBER: an envelope-bundle arriving on a subscribed thread channel
  //    is admitted through the backfill held-envelope ingest (render-time verify).
  //  - Live control DMs: a scoped invite-request (host auto-grants + sends the
  //    thread-so-far) / a scoped invite-grant we solicited (join as a thread sub).
  //    Each returns handled=true → skip the streaming/notification tail.
  if (phase === 'combined' && transport) {
    const t = transport;
    if (handleThreadChannelBundle(store, backfiller, msg, Date.now())) {
      void backfiller.flush();
      return;
    }
    const handledThread = await (async () => {
      if (await handleThreadInviteRequest(store, t, msg, isFeedMessage)) return true;
      if (await handleThreadInviteGrant(store, t, msg, isFeedMessage)) return true;
      return false;
    })().catch((err) => {
      console.error('thread-subscribe control-DM handling failed (non-fatal):', err);
      return false;
    });
    if (handledThread) return;
  }

  //  - Live HOST republication: a freshly-ingested reply whose SIGNED root names a
  //    hosted thread is wrapped verbatim in a bundle + posted into the channel.
  //    Runs on the fresh FEED copy; store dedupes per uuid. Non-fatal on failure.
  if (phase === 'combined' && transport && fresh) {
    await republishReplyToThread(store, transport, msg, isFeedMessage).catch((err) => {
      console.error('thread republication failed (non-fatal):', err);
    });
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

  if (isFeedMessage && parseWire(msg.text).visibility !== 'direct') {
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
const printEnrollmentCode = () => {
  const enrollment = auth.createEnrollmentCode();
  console.log(`deltanet: one-time frontend enrollment code (10 minutes): ${enrollment.code}`);
};
auth.bindAccount(creds?.addr ?? null);
printEnrollmentCode();
if (creds) {
  console.log(`configuring ${creds.addr} (data: ${DATA_DIR}) ...`);
  transport = await openTransport(DATA_DIR, creds, { onMessage: ingestOnMessage });
  transport.onFollower(notifyFollower);
  await announce(transport);
  // Thread auto-backfill startup seed: an existing store may already hold
  // dangling refs predating this feature (carol's case). Local-message dangling
  // refs are seeded by the startup re-index sweep (enqueueDangling runs in the
  // 'index' phase); this seeds held envelopes' own transitive refs. Capped burst;
  // the flush's global rate cap paces the actual sends.
  seedBackfillQueue(store, backfiller);
  void backfiller.flush();
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
    auth.bindAccount(addr);
    printEnrollmentCode();
    transport = opened;
    await announce(opened);
    return opened;
  },
  // Restore-instead-of-signup: the API layer has already unpacked the .dnbk
  // container (sidecar files written + store/attestor reloaded); this imports
  // the core tar and boots the transport like a signup would, persisting the
  // recovered credentials so the next plain daemon start finds the account.
  restore: async (backupTarPath, passphrase, beforeOpen) => {
    const { transport: opened, creds: restoredCreds } = await restoreTransport(
      DATA_DIR,
      backupTarPath,
      passphrase,
      { onMessage: ingestOnMessage },
      beforeOpen,
    );
    writeAccount(ACCOUNTS_FILE, ACCOUNT, restoredCreds);
    opened.onFollower(notifyFollower);
    auth.bindAccount(restoredCreds.addr);
    printEnrollmentCode();
    transport = opened;
    await announce(opened);
    // Same startup seeding a normal boot does: the restored store may carry
    // dangling refs whose backfill the pre-wipe node never finished.
    seedBackfillQueue(store, backfiller);
    void backfiller.flush();
    return opened;
  },
};

const staticDir = existsSync(STATIC_DIR) ? STATIC_DIR : undefined;
if (staticDir) console.log(`serving static frontend from ${staticDir}`);

const app = createApp(ctx, {
  baseUrl: BASE_URL,
  security: { auth, trustedOrigins: ALLOWED_ORIGINS },
  staticDir,
  store,
  upgradeWebSocket,
  hub,
  // Profile-editing persists the uploaded avatar + SELF header banner here so
  // they survive restarts; resolved absolute since DATA_DIR may be relative.
  dataDir: resolve(process.cwd(), DATA_DIR),
});

// `@hono/node-server`'s v2 websocket support is just `serve({ ..., websocket:
// { server } })` with a `ws.WebSocketServer` created in `noServer: true` mode
// (it hooks the returned HTTP server's own 'upgrade' event itself) — no
// separate `injectWebSocket(server)` call needed, unlike the older
// `@hono/node-server/ws`/`createNodeWebSocket` API.
const wss = new WebSocketServer({ noServer: true });
serve({ fetch: app.fetch, hostname: HOSTNAME, port: PORT, websocket: { server: wss } });
console.log(`deltanet: mastodon api on ${BASE_URL} (listening on ${HOSTNAME}:${PORT})`);
