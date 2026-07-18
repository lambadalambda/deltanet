/**
 * Mastodon streaming websocket hub: fans out `update`/`notification` frames
 * to registered sockets, filtered by which `stream` they subscribed to.
 *
 * Deliberately has no `ws`/`@hono/node-server` import: sockets are accepted
 * through a minimal structural interface (`StreamingSocket`) so unit tests
 * can register plain fakes (`{ send() {}, readyState: 1 }`) without spinning
 * up a real websocket server. The actual `ws`-backed adapter lives at the
 * route-registration call site (see `daemon.ts`/`server.ts`), which only needs
 * to satisfy this interface.
 */

/** The three stream names the frontend's `openPleromaTimelineStream` may request (see ../frontend/src/lib/pleroma/streaming.ts). */
export type StreamName = 'user' | 'public' | 'public:local';

/**
 * Structural subset of the DOM/`ws` socket interface the hub needs: enough
 * to send a frame and, optionally, to skip a socket that's already closing.
 * `readyState` is optional so the simplest possible test fake (just `send`)
 * still satisfies the type.
 */
export type StreamingSocket = {
  send(data: string): void;
  readyState?: number;
};

type Registration = {
  socket: StreamingSocket;
  streams: Set<StreamName>;
};

export type StreamingHub = {
  /** Register a socket for one or more streams; returns an unregister function. */
  register(socket: StreamingSocket, streams: StreamName[]): () => void;
  /** Explicitly drop a socket (idempotent). Prefer the function `register` returns; kept for callers that only have the socket handy. */
  unregister(socket: StreamingSocket): void;
  /** Broadcast a mapped status (already-JSON-shaped) to 'user', 'public', and 'public:local' subscribers, deduped per message id. */
  broadcastUpdate(statusJson: unknown, msgId: number): void;
  /** Broadcast a mapped notification (already-JSON-shaped) to 'user' subscribers only. */
  broadcastNotification(notificationJson: unknown): void;
  /** Has this message id already been streamed via `broadcastUpdate`? Exposed for tests. */
  hasStreamed(msgId: number): boolean;
  /** Number of currently-registered sockets. Exposed for tests. */
  size(): number;
};

const MAX_DEDUPE_IDS = 1000;

const STREAM_NAMES: ReadonlySet<StreamName> = new Set(['user', 'public', 'public:local']);

/**
 * Pure predicate mapping the `stream` query param (or its absence/an
 * unrecognized value) to a `StreamName`, defaulting to `'user'` — mirrors
 * `openPleromaTimelineStream`'s own default in
 * `../frontend/src/lib/pleroma/streaming.ts`. Extracted as a standalone
 * function (rather than inlined in the route handler) so it's unit-testable
 * without a real HTTP request/websocket upgrade.
 */
export const resolveStreamName = (requested: string | undefined): StreamName =>
  requested !== undefined && STREAM_NAMES.has(requested as StreamName) ? (requested as StreamName) : 'user';

/**
 * A Mastodon streaming text frame: `stream` is always present (even though
 * the Headwater frontend's parser only reads `event`/`payload`; see
 * `../frontend/src/lib/pleroma/streaming.ts` — matching the wire shape keeps
 * us compatible with any stricter Mastodon-API client). `payload` is the
 * mapped status/notification JSON re-encoded as a string: the frontend
 * `JSON.parse`s it a second time.
 */
const buildFrame = (stream: StreamName, event: 'update' | 'notification', payloadObj: unknown): string =>
  JSON.stringify({ stream: [stream], event, payload: JSON.stringify(payloadObj) });

/** Sockets whose `readyState` is present and not "open" (1) are skipped rather than sent to. */
const isSendable = (socket: StreamingSocket): boolean =>
  socket.readyState === undefined || socket.readyState === 1;

const WS_PING_INTERVAL_MS = 30_000;

/** The subset of `hono/ws`'s `WSContext` the route handler needs, generalized so it's fakeable in tests without a real websocket. */
export type StreamingWsContext = StreamingSocket & {
  /** The real underlying socket (`ws`'s `WebSocketLike`, via `@hono/node-server`'s node adapter), if the runtime exposes one; used only for the best-effort keepalive ping. */
  raw?: { ping?: () => void };
};

export type StreamingWsEvents = {
  onOpen(event: unknown, ws: StreamingWsContext): void;
  onClose(event: unknown, ws: StreamingWsContext): void;
  onError(event: unknown, ws: StreamingWsContext): void;
};

/**
 * Builds the `{onOpen, onClose, onError}` triple `hono/ws`'s `upgradeWebSocket`
 * helper expects, wired to `hub`. Kept independent of any real websocket
 * context/upgrade so it's unit-testable with a plain fake socket — see
 * `server.ts`'s route registration, which is the only caller that ever
 * passes a real `WSContext`.
 *
 * Also owns the ws-level keepalive ping (`WS_PING_INTERVAL_MS`) and its
 * cleanup: the interval is cleared on close/error, alongside unregistering
 * from the hub, so a closed socket never lingers as a broadcast target or a
 * dangling timer.
 */
export const createStreamingEvents = (hub: StreamingHub, streamParam: string | undefined): StreamingWsEvents => {
  const stream = resolveStreamName(streamParam);
  let unregister: (() => void) | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const cleanup = (): void => {
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = null;
    unregister?.();
    unregister = null;
  };

  return {
    onOpen(_event, ws) {
      unregister = hub.register(ws, [stream]);
      pingTimer = setInterval(() => {
        try {
          ws.raw?.ping?.();
        } catch {
          cleanup();
        }
      }, WS_PING_INTERVAL_MS);
    },
    onClose: cleanup,
    onError: cleanup,
  };
};

export const createStreamingHub = (): StreamingHub => {
  const registrations = new Map<StreamingSocket, Registration>();
  // Bounded FIFO of recently-streamed message ids, so a re-fired MsgsChanged
  // for the same message (see deltachat.ts's IncomingMsg+MsgsChanged double
  // delivery) doesn't stream a status twice.
  const streamedIds: number[] = [];
  const streamedIdSet = new Set<number>();

  const markStreamed = (msgId: number): void => {
    if (streamedIdSet.has(msgId)) return;
    streamedIdSet.add(msgId);
    streamedIds.push(msgId);
    if (streamedIds.length > MAX_DEDUPE_IDS) {
      const oldest = streamedIds.shift();
      if (oldest !== undefined) streamedIdSet.delete(oldest);
    }
  };

  const sendTo = (streams: StreamName[], event: 'update' | 'notification', payloadObj: unknown): void => {
    for (const [socket, reg] of registrations) {
      if (!isSendable(socket)) continue;
      const matched = streams.find((s) => reg.streams.has(s));
      if (!matched) continue;
      socket.send(buildFrame(matched, event, payloadObj));
    }
  };

  return {
    register(socket, streams) {
      registrations.set(socket, { socket, streams: new Set(streams) });
      return () => registrations.delete(socket);
    },

    unregister(socket) {
      registrations.delete(socket);
    },

    broadcastUpdate(statusJson, msgId) {
      if (streamedIdSet.has(msgId)) return;
      markStreamed(msgId);
      sendTo(['user', 'public', 'public:local'], 'update', statusJson);
    },

    broadcastNotification(notificationJson) {
      sendTo(['user'], 'notification', notificationJson);
    },

    hasStreamed: (msgId) => streamedIdSet.has(msgId),

    size: () => registrations.size,
  };
};
