import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import {
  serve,
  upgradeWebSocket,
  type Http2Bindings,
  type HttpBindings,
  type ServerType,
} from '@hono/node-server';
import { WebSocketServer } from 'ws';
import {
  readAccounts,
  resolveDataFilePath,
  writeAccount,
} from './config.js';
import { createApp, type AppContext } from './server.js';
import { registerAccount } from './signup.js';
import {
  openTransport,
  restoreTransport,
  type ChatmailCredentials,
  type DeltaChatTransport,
  type IngestPhase,
} from './transport/deltachat.js';
import type { Transport } from './transport/types.js';
import { createStore } from './store.js';
import { deriveOnIngest, runFollowbackOnIngest } from './ingest.js';
import { createStatusMapper, mapNotification } from './mapping.js';
import { createStreamingHub } from './streaming.js';
import { createBackfiller, type Backfiller, type SendRequest } from './backfill.js';
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
import { recoverInterruptedSidecarRestore } from './restore-journal.js';
import { createPreparedRestore } from './restore-lifecycle.js';
import {
  acquireProcessLifetimeInterprocessLock,
  type ProcessLifetimeInterprocessLock,
} from './interprocess-lock.js';

export type DaemonConfig = {
  account: string;
  listener: { hostname: string; port: number };
  baseUrl: string;
  dataDir: string;
  accountsFile: string;
  authFile: string;
  staticDir: string;
  restoreJournal: string;
  daemonLock: string;
  nativeHelperPath?: string;
  allowedOrigins: string[];
  signupRelays: string[];
  shutdownTimeoutMs?: number;
};

export type DaemonEvent =
  | { type: 'enrollment-code'; code: string; expiresAt: number }
  | { type: 'configuring'; address: string; dataDir: string }
  | { type: 'account'; displayName: string; address: string; feedInvite: string }
  | { type: 'unconfigured'; account: string }
  | { type: 'static-frontend'; path: string }
  | { type: 'ready'; origin: string; baseUrl: string }
  | { type: 'diagnostic'; component: string; error: unknown; recoverable: true }
  | { type: 'fatal'; phase: 'startup' | 'runtime'; component: string; error: unknown };

export type DaemonHandle = {
  origin: string;
  readiness: Readonly<{ origin: string }>;
  closed: Promise<void>;
  close(): Promise<void>;
};

export type DaemonDependencies = {
  onEvent?: (event: DaemonEvent) => void;
  signal?: AbortSignal;
  openTransport?: typeof openTransport;
  restoreTransport?: typeof restoreTransport;
  registerAccount?: typeof registerAccount;
};

type AppFetch = ReturnType<typeof createApp>['fetch'];

const activeDaemonLocks = new Set<string>();

const absolutePathFields = [
  'dataDir',
  'accountsFile',
  'authFile',
  'staticDir',
  'restoreJournal',
  'daemonLock',
] as const;

const validateConfig = (config: DaemonConfig): void => {
  for (const field of absolutePathFields) {
    if (!isAbsolute(config[field])) throw new Error(`daemon config ${field} must be absolute`);
  }
  if (config.nativeHelperPath && !isAbsolute(config.nativeHelperPath)) {
    throw new Error('daemon config nativeHelperPath must be absolute');
  }
  if (!Number.isInteger(config.listener.port) || config.listener.port < 0 || config.listener.port > 65535) {
    throw new Error(`invalid daemon listener port: ${config.listener.port}`);
  }
};

const closeHttpServer = (server: ServerType): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
      else reject(error);
    });
  });

const listenerOrigin = (server: ServerType): string => {
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('daemon listener has no bound address');
  const hostname = address.address.includes(':') ? `[${address.address}]` : address.address;
  return `http://${hostname}:${address.port}`;
};

const closeWebSocketServer = (server: WebSocketServer): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

const beforeDeadline = async <T>(
  operation: Promise<T>,
  deadline: number,
  component: string,
): Promise<T> => {
  const remaining = Math.max(0, deadline - Date.now());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${component} exceeded the shutdown deadline`)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const startDaemon = async (
  config: DaemonConfig,
  dependencies: DaemonDependencies = {},
): Promise<DaemonHandle> => {
validateConfig(config);
const canonicalLockPath = resolve(config.daemonLock);
if (activeDaemonLocks.has(canonicalLockPath)) {
  throw new Error(`a Headwater daemon already owns ${canonicalLockPath}`);
}
activeDaemonLocks.add(canonicalLockPath);
const observer = dependencies.onEvent;
const emit = (event: DaemonEvent): void => {
  try {
    observer?.(event);
  } catch {
    // Lifecycle ownership must never depend on an observer behaving correctly.
  }
};
const openDaemonTransport = dependencies.openTransport ?? openTransport;
const restoreDaemonTransport = dependencies.restoreTransport ?? restoreTransport;
const registerDaemonAccount = dependencies.registerAccount ?? registerAccount;
const ACCOUNT = config.account;
const DATA_DIR = config.dataDir;
let BASE_URL = config.baseUrl;
const AUTH_FILE = config.authFile;
let ALLOWED_ORIGINS = config.allowedOrigins;
const SIGNUP_RELAYS = config.signupRelays;
const STATIC_DIR = config.staticDir;
const DATA_PATH = config.dataDir;
const ACCOUNTS_PATH = config.accountsFile;
const RESTORE_JOURNAL = config.restoreJournal;
const DAEMON_LOCK = canonicalLockPath;
const HOSTNAME = config.listener.hostname;
const PORT = config.listener.port;

let processLock: ProcessLifetimeInterprocessLock | null = null;
let lifecycleBackfiller: Backfiller | null = null;
let transport: DeltaChatTransport | null = null;
const provisionalTransports = new Set<DeltaChatTransport>();
const lifecycleOperations = new Set<Promise<unknown>>();
let unsubscribeFollower: (() => void) | null = null;
let wss: WebSocketServer | null = null;
let httpServer: ServerType | null = null;
let appFetch: AppFetch | null = null;
let origin = '';
let closePromise: Promise<void> | null = null;
let closing = false;
let ready = false;
let startupFailure: Error | null = null;
const runtimeController = new AbortController();
const operationSignal = dependencies.signal
  ? AbortSignal.any([dependencies.signal, runtimeController.signal])
  : runtimeController.signal;
let resolveStartupFailure!: (error: Error) => void;
const startupFailed = new Promise<Error>((resolve) => { resolveStartupFailure = resolve; });
const failStartup = (error: Error): void => {
  if (ready || startupFailure) return;
  startupFailure = error;
  resolveStartupFailure(error);
};
const ensureStarting = (): void => {
  if (startupFailure) throw startupFailure;
};
const duringStartup = async <T>(operation: Promise<T>): Promise<T> => Promise.race([
  operation,
  startupFailed.then((error) => Promise.reject(error)),
]);
const onAbort = (): void => failStartup(new Error('daemon startup aborted'));
operationSignal.addEventListener('abort', onAbort, { once: true });
if (operationSignal.aborted) onAbort();
let resolveClosed!: () => void;
const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
const trackLifecycleOperation = <T>(operation: () => Promise<T>): Promise<T> => {
  const pending = operation();
  lifecycleOperations.add(pending);
  void pending.finally(() => lifecycleOperations.delete(pending)).catch(() => {});
  return pending;
};

const close = (): Promise<void> => {
  if (closePromise) return closePromise;
  closing = true;
  runtimeController.abort();
  closePromise = (async () => {
    const failures: unknown[] = [];
    const deadline = Date.now() + (config.shutdownTimeoutMs ?? 10_000);
    try {
      lifecycleBackfiller?.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      unsubscribeFollower?.();
    } catch (error) {
      failures.push(error);
    }
    unsubscribeFollower = null;

    const server = httpServer;
    if (server) {
      for (const client of wss?.clients ?? []) client.close(1001, 'Headwater shutting down');
      const websocketClose = wss ? closeWebSocketServer(wss) : Promise.resolve();
      const serverClose = Promise.all([closeHttpServer(server), websocketClose]);
      try {
        await beforeDeadline(
          serverClose,
          Math.max(Date.now(), deadline - 250),
          'HTTP/WebSocket shutdown',
        );
      } catch (error) {
        for (const client of wss?.clients ?? []) client.terminate();
        if ('closeAllConnections' in server) server.closeAllConnections();
        try {
          await beforeDeadline(serverClose, deadline, 'forced HTTP/WebSocket shutdown');
        } catch (forceError) {
          failures.push(error, forceError);
        }
      } finally {
        httpServer = null;
        wss = null;
      }
    }

    let lifecycleSettled = true;
    try {
      await beforeDeadline(
        Promise.allSettled([...lifecycleOperations]),
        deadline,
        'in-flight lifecycle operations',
      );
    } catch (error) {
      failures.push(error);
      lifecycleSettled = false;
    }

    const ownedTransports = new Set(provisionalTransports);
    provisionalTransports.clear();
    if (transport) ownedTransports.add(transport);
    transport = null;
    const gracefulTransportCloses = new Map(
      [...ownedTransports].map((opened) => [opened, Promise.resolve().then(() => opened.close())]),
    );

    let transportsStopped = true;
    for (const [opened, gracefulClose] of gracefulTransportCloses) {
      try {
        await beforeDeadline(
          gracefulClose,
          Math.max(Date.now(), deadline - 1_000),
          'transport shutdown',
        );
      } catch (error) {
        failures.push(error);
        try {
          await beforeDeadline(opened.forceClose(), deadline, 'forced transport shutdown');
        } catch (forceError) {
          failures.push(forceError);
          transportsStopped = false;
        }
      }
    }
    if (transportsStopped && lifecycleSettled) {
      try {
        processLock?.release();
      } catch (error) {
        failures.push(error);
      }
      processLock = null;
      activeDaemonLocks.delete(canonicalLockPath);
    }
    operationSignal.removeEventListener('abort', onAbort);
    if (failures.length > 0) throw new AggregateError(failures, 'Headwater shutdown failed');
  })().finally(resolveClosed);
  return closePromise;
};

try {

// Own the account before touching recovery, credentials, auth, or Delta Chat.
// The lock is outside DATA_PATH because core restore requires a fresh target.
processLock = acquireProcessLifetimeInterprocessLock(DAEMON_LOCK);

// Replay a crashed sidecar restore before opening the store, attestor, account
// credentials, or Delta Chat transport.
recoverInterruptedSidecarRestore(RESTORE_JOURNAL);
ensureStarting();

// Bind before opening the native core so occupied ports fail cheaply and an
// OS-selected port can become the actual same-origin API/configuration base.
const websocketServer = new WebSocketServer({ noServer: true });
wss = websocketServer;
const startedServer = serve({
  fetch: (request: Request, env: HttpBindings | Http2Bindings) => appFetch
    ? appFetch(request, env)
    : new Response('Headwater is starting', { status: 503 }),
  hostname: HOSTNAME,
  port: PORT,
  websocket: { server: websocketServer },
});
httpServer = startedServer;
const listening = new Promise<void>((resolve, reject) => {
  const onListening = () => {
    startedServer.off('error', onError);
    resolve();
  };
  const onError = (error: Error) => {
    startedServer.off('listening', onListening);
    reject(error);
  };
  startedServer.once('listening', onListening);
  startedServer.once('error', onError);
  if (startedServer.listening) onListening();
});
await Promise.race([
  listening,
  startupFailed.then((error) => Promise.reject(error)),
]);
origin = listenerOrigin(startedServer);
if (PORT === 0) BASE_URL = origin;
ALLOWED_ORIGINS = [...new Set([...ALLOWED_ORIGINS, origin])];
ensureStarting();

// One Headwater wire-convention store per account data dir, shared between
// the transport's ingestion hook (timeline loads + IncomingMsg events) and
// the API layer's mapping/context assembly.
const store = createStore(resolveDataFilePath(
  DATA_PATH,
  'headwater-store.json',
  'deltanet-store.json',
), { lockPath: DAEMON_LOCK });
const auth = createAuthStore(AUTH_FILE);

// Streaming websocket hub (see ./streaming.ts) + the same status/notification
// mapping REST responses use (see ./mapping.ts), so live-streamed frames are
// never a divergent JSON shape from `GET /api/v1/timelines/*` or
// `GET /api/v1/notifications`.
const hub = createStreamingHub();
const mapper = createStatusMapper(store, BASE_URL, {
  blobUrl: (msgId) => {
    const signed = auth.signBlobPath(msgId);
    const url = new URL(`/headwater/blob/${msgId}`, BASE_URL);
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
const withExternalMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
  const release = store.beginExternalMutation();
  try {
    return await operation();
  } finally {
    release();
  }
};
const backfiller = createBackfiller({
  store,
  send: sendBackfillRequest,
  runScheduled: withExternalMutation,
});
lifecycleBackfiller = backfiller;
const flushBackfiller = async (): Promise<void> => {
  await withExternalMutation(() => backfiller.flush());
};

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

const accountAnnouncement = async (transport: Transport): Promise<Extract<DaemonEvent, { type: 'account' }>> => {
  const self = await transport.self();
  const feedInvite = await transport.feedInvite();
  return {
    type: 'account',
    displayName: self.displayName,
    address: self.address,
    feedInvite,
  };
};
const announce = async (transport: Transport): Promise<void> => {
  const event = await accountAnnouncement(transport);
  ensureStarting();
  emit(event);
};

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
const ingestOnMessageWithinBarrier = async (
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
      emit({ type: 'diagnostic', component: 'backfill-control', error: err, recoverable: true });
      return false;
    });
    if (handled) {
      void flushBackfiller();
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
      void flushBackfiller();
      return;
    }
    const handledThread = await (async () => {
      if (await handleThreadInviteRequest(store, t, msg, isFeedMessage)) return true;
      if (await handleThreadInviteGrant(store, t, msg, isFeedMessage)) return true;
      return false;
    })().catch((err) => {
      emit({ type: 'diagnostic', component: 'thread-subscribe', error: err, recoverable: true });
      return false;
    });
    if (handledThread) return;
  }

  //  - Live HOST republication: a freshly-ingested reply whose SIGNED root names a
  //    hosted thread is wrapped verbatim in a bundle + posted into the channel.
  //    Runs on the fresh FEED copy; store dedupes per uuid. Non-fatal on failure.
  if (phase === 'combined' && transport && fresh) {
    await republishReplyToThread(store, transport, msg, isFeedMessage).catch((err) => {
      emit({ type: 'diagnostic', component: 'thread-republication', error: err, recoverable: true });
    });
  }

  if (phase !== 'combined') return;
  const t = transport;
  if (!t) return;

  // No media alt-text description is available here: `mediaStore` (uploaded
  // attachment descriptions) lives inside `createApp`'s closure in
  // server.ts, keyed only by messages this same process has *uploaded*
  // through `/api/v1/media` — not plumbed out to `daemon.ts` (doing so would
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
      emit({ type: 'diagnostic', component: 'streaming-status', error: err, recoverable: true });
    }
  }

  for (const notification of newNotifications) {
    try {
      hub.broadcastNotification(await mapNotification(notification, t, mapper, BASE_URL, noDescription));
    } catch (err) {
      emit({ type: 'diagnostic', component: 'streaming-notification', error: err, recoverable: true });
    }
  }
};

const ingestOnMessage = async (
  msg: T.Message,
  isFeedMessage: boolean,
  mid: string | null,
  phase: IngestPhase,
): Promise<void> => {
  const release = store.beginExternalMutation();
  try {
    await ingestOnMessageWithinBarrier(msg, isFeedMessage, mid, phase);
  } finally {
    release();
  }
};

const openOptions = {
  onMessage: ingestOnMessage,
  beginExternalMutation: () => store.beginExternalMutation(),
  rpcServerPath: config.nativeHelperPath,
  signal: operationSignal,
};

const watchNativeCore = (opened: DeltaChatTransport): void => {
  void opened.exited.then((exit) => {
    if (exit.expected || closing) return;
    const error = exit.error ?? new Error(
      `deltachat-rpc-server exited unexpectedly (${exit.code ?? exit.signal ?? 'unknown'})`,
    );
    if (!ready) {
      failStartup(error);
      return;
    }
    emit({ type: 'fatal', phase: 'runtime', component: 'native-core', error });
    void close();
  });
};

/** New-follower notification: SecurejoinInviterProgress===1000 means someone just joined our feed broadcast. */
const notifyFollower = async (contactId: number) => {
  const release = store.beginExternalMutation();
  try {
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
      emit({ type: 'diagnostic', component: 'streaming-follow', error: err, recoverable: true });
    }
  } finally {
    release();
  }
};

const creds = readAccounts(ACCOUNTS_PATH)[ACCOUNT];
const emitEnrollmentCode = (enrollment: { code: string; expiresAt: number }): void => {
  emit({ type: 'enrollment-code', code: enrollment.code, expiresAt: enrollment.expiresAt });
};
auth.bindAccount(creds?.addr ?? null);
emitEnrollmentCode(auth.createEnrollmentCode());
if (creds) {
  emit({ type: 'configuring', address: creds.addr, dataDir: DATA_DIR });
  transport = await openDaemonTransport(DATA_DIR, creds, openOptions);
  watchNativeCore(transport);
  ensureStarting();
  unsubscribeFollower = transport.onFollower(notifyFollower);
  await duringStartup(announce(transport));
  ensureStarting();
  // Thread auto-backfill startup seed: an existing store may already hold
  // dangling refs predating this feature (carol's case). Local-message dangling
  // refs are seeded by the startup re-index sweep (enqueueDangling runs in the
  // 'index' phase); this seeds held envelopes' own transitive refs. Capped burst;
  // the flush's global rate cap paces the actual sends.
  seedBackfillQueue(store, backfiller);
  void flushBackfiller();
} else {
  emit({ type: 'unconfigured', account: ACCOUNT });
}

const ctx: AppContext = {
  getTransport: () => transport,
  signup: (displayName, relay) => trackLifecycleOperation(async () => {
    const { addr, password } = await registerDaemonAccount(relay);
    const newCreds: ChatmailCredentials = { addr, password, displayName };
    writeAccount(ACCOUNTS_PATH, ACCOUNT, newCreds);
    const opened = await openDaemonTransport(DATA_DIR, newCreds, openOptions);
    provisionalTransports.add(opened);
    let openedFollower: (() => void) | null = null;
    try {
      if (closing) throw new Error('daemon is shutting down');
      const accountEvent = await Promise.race([
        accountAnnouncement(opened),
        opened.exited.then((exit) => Promise.reject(
          exit.error ?? new Error(`deltachat-rpc-server exited during signup (${exit.code ?? exit.signal ?? 'unknown'})`),
        )),
      ]);
      openedFollower = opened.onFollower(notifyFollower);
      auth.bindAccount(addr);
      const enrollment = auth.createEnrollmentCode();
      if (closing) throw new Error('daemon is shutting down');
      transport = opened;
      watchNativeCore(opened);
      provisionalTransports.delete(opened);
      unsubscribeFollower?.();
      unsubscribeFollower = openedFollower;
      openedFollower = null;
      emit(accountEvent);
      emitEnrollmentCode(enrollment);
      return opened;
    } catch (error) {
      provisionalTransports.delete(opened);
      openedFollower?.();
      auth.bindAccount(creds?.addr ?? null);
      await opened.close();
      throw error;
    }
  }),
  // Restore-instead-of-signup: the API layer has already unpacked the .dnbk
  // container (sidecar files written + store/attestor reloaded); this imports
  // the core tar and boots the transport like a signup would, persisting the
  // recovered credentials so the next plain daemon start finds the account.
  restore: (backupTarPath, passphrase, beforeOpen) => trackLifecycleOperation(async () => {
    const { transport: opened, creds: restoredCreds, start } = await restoreDaemonTransport(
      DATA_DIR,
      backupTarPath,
      passphrase,
      { ...openOptions, deferStart: true },
      beforeOpen,
    );
    provisionalTransports.add(opened);
    if (closing) {
      provisionalTransports.delete(opened);
      await opened.close();
      throw new Error('daemon is shutting down');
    }
    let restoredFollower: (() => void) | null = null;
    let restoredAccountEvent: Extract<DaemonEvent, { type: 'account' }> | null = null;
    let restoredEnrollment: { code: string; expiresAt: number } | null = null;
    return createPreparedRestore({
      transport: opened,
      prepareCommit: async (persistCredentials) => {
        await start();
        restoredAccountEvent = await Promise.race([
          accountAnnouncement(opened),
          opened.exited.then((exit) => Promise.reject(
            exit.error ?? new Error(
              `deltachat-rpc-server exited during restore (${exit.code ?? exit.signal ?? 'unknown'})`,
            ),
          )),
        ]);
        restoredFollower = opened.onFollower(notifyFollower);
        seedBackfillQueue(store, backfiller);
        auth.bindAccount(restoredCreds.addr);
        restoredEnrollment = auth.createEnrollmentCode();
        persistCredentials(restoredCreds);
      },
      publish: () => {
        if (closing) throw new Error('daemon is shutting down');
        transport = opened;
        watchNativeCore(opened);
        provisionalTransports.delete(opened);
        unsubscribeFollower?.();
        unsubscribeFollower = restoredFollower;
        restoredFollower = null;
      },
      rollback: () => {
        restoredFollower?.();
        restoredFollower = null;
        auth.bindAccount(creds?.addr ?? null);
      },
      close: async () => {
        provisionalTransports.delete(opened);
        await opened.close();
      },
      afterPublish: () => {
        if (restoredAccountEvent) emit(restoredAccountEvent);
        if (restoredEnrollment) emitEnrollmentCode(restoredEnrollment);
        void flushBackfiller();
      },
    });
  }),
};

const staticDir = existsSync(STATIC_DIR) ? STATIC_DIR : undefined;
if (staticDir) emit({ type: 'static-frontend', path: staticDir });

const app = createApp(ctx, {
  baseUrl: BASE_URL,
  security: {
    auth,
    trustedOrigins: ALLOWED_ORIGINS,
    onEnrollmentCode: (enrollment) => emit({ type: 'enrollment-code', ...enrollment }),
  },
  signupRelays: SIGNUP_RELAYS,
  staticDir,
  store,
  upgradeWebSocket,
  hub,
  // Profile-editing persists the uploaded avatar + SELF header banner here so
  // they survive restarts; resolved absolute since DATA_DIR may be relative.
  dataDir: DATA_PATH,
  restoreJournal: { path: RESTORE_JOURNAL, accountsPath: ACCOUNTS_PATH, accountName: ACCOUNT },
});
appFetch = app.fetch;
ensureStarting();
const readiness = Object.freeze({ origin });
ready = true;
emit({ type: 'ready', origin, baseUrl: BASE_URL });
return { origin, readiness, closed, close };
} catch (error) {
  emit({ type: 'fatal', phase: 'startup', component: 'daemon', error });
  try {
    await close();
  } catch (closeError) {
    emit({ type: 'diagnostic', component: 'startup-cleanup', error: closeError, recoverable: true });
  }
  throw error;
}
};
