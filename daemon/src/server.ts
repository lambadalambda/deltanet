import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import type { UpgradeWebSocket, WSEvents } from 'hono/ws';
import type { T } from '@deltachat/jsonrpc-client';
import {
  avatarPlaceholderSvg,
  contactToAccount,
  headerSvg,
  timelineLinkHeader,
  type MastodonRelationship,
  type MastodonStatus,
} from './mastodon/entities.js';
import type { Transport } from './transport/types.js';
import { createMediaStore, isSupportedImageMime } from './media.js';
import {
  buildBoostText,
  buildQuotedText,
  buildReactionText,
  buildReplyText,
  buildUnreactionText,
  parseMarkers,
} from './protocol.js';
import { createStore, ephemeralStorePath, type Store } from './store.js';
import { deriveOnIngest } from './ingest.js';
import { createStatusMapper, mapNotification } from './mapping.js';
import { createStreamingEvents, type StreamingHub } from './streaming.js';

const DC_CONTACT_ID_SELF = 1;
const FAVOURITE_EMOJI = '❤';
const QUOTE_EXCERPT_CAP = 120;
const BOOST_QUOTE_CAP = 500;
const REACTION_QUOTE_CAP = 120;
const MAX_CONTEXT_ANCESTORS = 20;
const MAX_CONTEXT_DESCENDANTS = 100;

export type ServerOptions = {
  baseUrl: string;
  /** Absolute path to a built frontend SPA to serve as static files; skipped if unset/missing. */
  staticDir?: string;
  /**
   * The deltanet wire-convention store (mid/msgId index, reply/boost
   * edges). Share the same instance passed to `openTransport`'s
   * `onMessage` hook so ingestion from timeline reads and from the daemon's
   * background event subscription land in one place. Defaults to a fresh
   * ephemeral (scratch-file-backed) store, which is fine for tests.
   */
  store?: Store;
  /**
   * Enables `GET /api/v1/streaming` (+ trailing-slash alias) when both this
   * and `hub` are provided. Hono's node-server `upgradeWebSocket` helper
   * (see `main.ts`, which also wires the `ws.WebSocketServer` into `serve`'s
   * `websocket.server` option — that half lives outside `createApp` since it
   * needs the real HTTP server instance `serve()` returns). Optional so
   * `createApp` stays usable in tests/contexts with no real websocket
   * transport (the hub logic itself is unit-tested directly against
   * `./streaming.ts`, no `ws` involved).
   */
  upgradeWebSocket?: UpgradeWebSocket;
  /** Streaming hub live messages/notifications are broadcast through; see `./streaming.ts`. Required iff `upgradeWebSocket` is provided. */
  hub?: StreamingHub;
};

/**
 * Mutable source of the (possibly not-yet-configured) transport, plus the
 * signup operation that brings one into existence. Kept narrow so the API
 * layer can be unit-tested without a real chatmail account.
 */
export type AppContext = {
  getTransport(): Transport | null;
  signup(displayName: string, relay: string): Promise<Transport>;
};

type TransportEnv = { Variables: { transport: Transport } };

const OAUTH_SCOPE = 'read write follow push';
const MAX_POST_CHARS = 5000;
const DEFAULT_PAGE = 20;
const DEFAULT_RELAY = 'https://nine.testrun.org';

const intParam = (value: string | undefined): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const createApp = (
  ctx: AppContext,
  { baseUrl, staticDir, store: injectedStore, upgradeWebSocket, hub }: ServerOptions,
) => {
  const app = new Hono();
  const mediaStore = createMediaStore();
  const store: Store = injectedStore ?? createStore(ephemeralStorePath());

  // Shared status/notification JSON mapping (see ./mapping.ts) — the same
  // instance's `toStatus`/`ownAddr` (with its request-lifetime cache) backs
  // every REST handler below, and `main.ts`'s live-ingestion path builds its
  // own instance over the same `store` so streamed frames use identical
  // mapping logic.
  const mapper = createStatusMapper(store, baseUrl);
  const { toStatus } = mapper;

  /**
   * Ingest a message into the store, tolerating a transport that can't
   * resolve its mid. Every message reaching this helper was loaded via
   * `timeline`/`timelineFrom`/`message` (feed chats or ids resolved from
   * feed-registered reply/boost edges), so it's always a FEED message —
   * unlike the transport's `onMessage` event hook, which also sees DM
   * copies and must classify per-message (see `deltachat.ts`).
   */
  const ingest = async (transport: Transport, msg: T.Message): Promise<void> => {
    try {
      const mid = await transport.messageMid(msg.id);
      if (mid) {
        store.ingestMessage(msg, mid, true);
        deriveOnIngest(store, msg, mid);
      }
    } catch (err) {
      console.error('ingest failed (non-fatal):', err);
    }
  };

  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    }),
  );

  // --- transport gate: attach the live transport, or 401 if unconfigured ---

  const requireTransport = async (c: Context<TransportEnv>, next: Next) => {
    const transport = ctx.getTransport();
    if (!transport) return c.json({ error: 'not configured' }, 401);
    c.set('transport', transport);
    await next();
  };

  // --- deltanet: status + signup --------------------------------------------

  app.get('/api/deltanet/status', async (c) => {
    const transport = ctx.getTransport();
    if (!transport) return c.json({ configured: false, address: null });
    const self = await transport.self();
    return c.json({ configured: true, address: self.address });
  });

  app.post('/api/deltanet/signup', async (c) => {
    if (ctx.getTransport()) return c.json({ error: 'already configured' }, 409);
    const body = await c.req.json<{ display_name?: string; relay?: string }>().catch(() => ({}) as any);
    const displayName = String(body.display_name ?? '').trim();
    if (!displayName) {
      return c.json({ error: "Validation failed: display_name can't be blank" }, 422);
    }
    const relay = body.relay ?? DEFAULT_RELAY;
    const transport = await ctx.signup(displayName, relay);
    return c.json({ account: contactToAccount(await transport.self(), baseUrl) });
  });

  // --- OAuth: single-user daemon, auto-granted ---------------------------

  app.post('/api/v1/apps', async (c) => {
    const body = await c.req.parseBody();
    return c.json({
      id: '1',
      name: String(body['client_name'] ?? 'app'),
      website: null,
      redirect_uri: String(body['redirect_uris'] ?? ''),
      client_id: 'deltanet',
      client_secret: 'deltanet-single-user',
      vapid_key: '',
    });
  });

  app.get('/oauth/authorize', (c) => {
    const redirectUri = c.req.query('redirect_uri');
    if (!redirectUri) return c.json({ error: 'redirect_uri missing' }, 400);
    const target = new URL(redirectUri);
    target.searchParams.set('code', 'deltanet-code');
    const state = c.req.query('state');
    if (state) target.searchParams.set('state', state);
    return c.redirect(target.toString(), 302);
  });

  app.post('/oauth/token', (c) =>
    c.json({
      access_token: 'deltanet-token',
      token_type: 'Bearer',
      scope: OAUTH_SCOPE,
      created_at: Math.floor(Date.now() / 1000),
    }),
  );

  app.post('/oauth/revoke', (c) => c.json({}));

  // --- Streaming (Mastodon websocket API) ----------------------------------
  //
  // `stream` (default 'user') and `access_token` (accepted unconditionally,
  // consistent with the single-user auth model — see requireTransport)
  // match the frontend's `buildPleromaStreamingUrl`
  // (../frontend/src/lib/pleroma/streaming.ts). Registered under both
  // '/api/v1/streaming' and the trailing-slash variant the frontend actually
  // connects to. All the fan-out/dedupe/keepalive logic lives in
  // `createStreamingEvents` (./streaming.ts, unit-tested with fake sockets —
  // a real websocket upgrade can't be driven through Hono's `app.request()`
  // test helper, so keeping this handler a one-line adapter is what makes
  // the actual registration/cleanup behavior testable at all); this handler
  // only wires the real `WSContext` through.
  if (upgradeWebSocket && hub) {
    // `createStreamingEvents` is typed against a narrow, hub-only
    // `StreamingWsContext` (see ./streaming.ts) so it's testable with plain
    // fakes; hono's real `WSContext.raw` is `unknown` (it's generic over the
    // adapter), so this cast is the one place that ties the two together.
    const streamingHandler = upgradeWebSocket(
      (c) => createStreamingEvents(hub, c.req.query('stream')) as unknown as WSEvents,
    );
    app.get('/api/v1/streaming', streamingHandler);
    app.get('/api/v1/streaming/', streamingHandler);
  }

  // --- Instance -----------------------------------------------------------

  const instanceV2 = () => ({
    domain: new URL(baseUrl).host,
    title: 'deltanet',
    version: '2.7.2 (compatible; deltanet 0.0.1)',
    source_url: 'https://localhost/deltanet',
    description: 'single-user pleroma-style backend federating over chatmail',
    languages: ['en'],
    registrations: { enabled: false, approval_required: false },
    configuration: {
      statuses: { max_characters: MAX_POST_CHARS, max_media_attachments: 1 },
      media_attachments: { supported_mime_types: ['image/png', 'image/jpeg', 'image/webp'] },
    },
    max_toot_chars: MAX_POST_CHARS,
    pleroma: { metadata: { features: [], max_toot_chars: MAX_POST_CHARS } },
  });

  app.get('/api/v2/instance', (c) => c.json(instanceV2()));
  app.get('/api/v1/instance', (c) => c.json({ ...instanceV2(), uri: new URL(baseUrl).host }));

  // --- Accounts -----------------------------------------------------------

  app.get('/api/v1/accounts/verify_credentials', requireTransport, async (c) => {
    const transport = c.get('transport');
    const [self, stats] = await Promise.all([transport.self(), transport.stats()]);
    return c.json({
      ...contactToAccount(self, baseUrl),
      followers_count: stats.followers,
      following_count: stats.following,
      statuses_count: stats.statuses,
    });
  });

  const relationshipFor = (following: boolean, id: number): MastodonRelationship => ({
    id: String(id),
    following,
    showing_reblogs: following,
    notifying: false,
    followed_by: false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    requested: false,
    domain_blocking: false,
    endorsed: false,
    note: '',
  });

  app.get('/api/v1/accounts/relationships', requireTransport, async (c) => {
    const transport = c.get('transport');
    const raw = c.req.queries('id[]') ?? c.req.queries('id') ?? [];
    const ids = raw.map(Number);
    const followedIds = new Set((await transport.following()).map((f) => f.contactId));
    return c.json(ids.map((id) => relationshipFor(followedIds.has(id), id)));
  });

  // Registered before `/:id` so the static segment wins. The frontend
  // resolves profile routes via this endpoint; the handle is an email
  // address (our acct values are full addresses), optionally "@"-prefixed,
  // or a bare local part matching our own account's username.
  app.get('/api/v1/accounts/lookup', requireTransport, async (c) => {
    const transport = c.get('transport');
    const raw = (c.req.query('acct') ?? '').trim();
    if (!raw) return c.json({ error: 'Record not found' }, 404);
    const handle = raw.startsWith('@') ? raw.slice(1) : raw;
    const contactId = await transport.contactIdByAddr(handle);
    const contact = contactId !== null ? await transport.contact(contactId) : null;
    if (!contact) return c.json({ error: 'Record not found' }, 404);
    const followedIds = new Set((await transport.following()).map((f) => f.contactId));
    const relationship = relationshipFor(followedIds.has(contact.id), contact.id);
    return c.json(contactToAccount(contact, baseUrl, relationship));
  });

  app.get('/api/v1/accounts/:id', requireTransport, async (c) => {
    const contact = await c.get('transport').contact(Number(c.req.param('id')));
    if (!contact) return c.json({ error: 'Record not found' }, 404);
    const followedIds = new Set((await c.get('transport').following()).map((f) => f.contactId));
    const relationship = relationshipFor(followedIds.has(contact.id), contact.id);
    return c.json(contactToAccount(contact, baseUrl, relationship));
  });

  app.post('/api/v1/accounts/:id/unfollow', requireTransport, async (c) => {
    const contactId = Number(c.req.param('id'));
    await c.get('transport').unfollow(contactId);
    return c.json(relationshipFor(false, contactId));
  });

  app.post('/api/v1/accounts/:id/follow', requireTransport, async (c) => {
    return c.json(
      {
        error:
          'Following requires an invite link for now: paste the account’s invite link into search to follow them.',
      },
      422,
    );
  });

  app.get('/api/v1/accounts/:id/statuses', requireTransport, async (c) => {
    const transport = c.get('transport');
    const contactId = Number(c.req.param('id'));
    const limit = intParam(c.req.query('limit')) ?? DEFAULT_PAGE;
    const messages = await transport.timelineFrom(contactId, {
      limit,
      maxId: intParam(c.req.query('max_id')),
      minId: intParam(c.req.query('min_id')) ?? intParam(c.req.query('since_id')),
    });
    for (const msg of messages) await ingest(transport, msg);
    const statuses = await Promise.all(
      messages.map((msg) => toStatus(transport, msg, mediaStore.descriptionForMessage(msg.id))),
    );
    return c.json(statuses);
  });

  // --- Timelines ----------------------------------------------------------

  const timeline = async (c: Context<TransportEnv>) => {
    const transport = c.get('transport');
    const limit = intParam(c.req.query('limit')) ?? DEFAULT_PAGE;
    const messages = await transport.timeline({
      limit,
      maxId: intParam(c.req.query('max_id')),
      minId: intParam(c.req.query('min_id')) ?? intParam(c.req.query('since_id')),
    });
    for (const msg of messages) await ingest(transport, msg);
    const statuses: MastodonStatus[] = await Promise.all(
      messages.map((msg) => toStatus(transport, msg, mediaStore.descriptionForMessage(msg.id))),
    );
    const link = timelineLinkHeader(
      `${baseUrl}${new URL(c.req.url).pathname}`,
      statuses.map((s) => s.id),
    );
    if (link) c.header('Link', link);
    return c.json(statuses);
  };

  app.get('/api/v1/timelines/home', requireTransport, timeline);
  app.get('/api/v1/timelines/public', requireTransport, timeline);

  // --- Statuses -----------------------------------------------------------

  const firstMediaId = (body: Record<string, unknown>): string | undefined => {
    const raw = body['media_ids[]'] ?? body['media_ids'];
    if (Array.isArray(raw)) return raw.length > 0 ? String(raw[0]) : undefined;
    return raw === undefined ? undefined : String(raw);
  };

  app.post('/api/v1/statuses', requireTransport, async (c) => {
    const transport = c.get('transport');
    const contentType = c.req.header('content-type') ?? '';
    const body = contentType.includes('json')
      ? await c.req.json()
      : await c.req.parseBody({ all: true });
    const text = String(body['status'] ?? '').trim();
    const mediaId = firstMediaId(body as Record<string, unknown>);
    const media = mediaId ? mediaStore.get(mediaId) : undefined;
    if (!text && !media) {
      return c.json({ error: 'Validation failed: text cannot be blank' }, 422);
    }

    const inReplyToId = body['in_reply_to_id'] != null ? String(body['in_reply_to_id']) : undefined;
    if (inReplyToId) {
      const target = await transport.message(Number(inReplyToId));
      if (!target) return c.json({ error: 'Record not found' }, 404);
      const mid = await transport.messageMid(target.id);
      if (!mid) return c.json({ error: 'cannot resolve message id for reply target' }, 422);
      await ingest(transport, target);

      const ref = { mid, addr: target.sender.address };
      const replyText = buildReplyText(text, ref);
      const quotedText = buildQuotedText(target.sender.displayName, target.text, QUOTE_EXCERPT_CAP);

      const msg = await transport.post(replyText, { quotedText });
      await ingest(transport, msg);

      if (target.sender.id !== DC_CONTACT_ID_SELF) {
        await transport.sendControlDm(target.sender.id, replyText, quotedText).catch((err) => {
          console.error('sendControlDm failed (non-fatal):', err);
        });
      }

      return c.json(await toStatus(transport, msg));
    }

    const msg = await transport.post(text, media ? { file: media.path } : undefined);
    if (media) mediaStore.tagMessage(msg.id, media.description);
    await ingest(transport, msg);
    return c.json(await toStatus(transport, msg, media?.description ?? null));
  });

  // --- Media uploads --------------------------------------------------------

  app.post('/api/v1/media', requireTransport, async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) {
      return c.json({ error: "Validation failed: file can't be blank" }, 422);
    }
    if (!isSupportedImageMime(file.type)) {
      return c.json({ error: 'Validation failed: unsupported media type' }, 422);
    }
    const description = body['description'] != null ? String(body['description']) : null;
    const { id } = await mediaStore.save(file, description);
    return c.json({
      id,
      type: 'image',
      url: '',
      preview_url: '',
      description,
    });
  });

  // --- Reblog / unreblog ---------------------------------------------------

  app.post('/api/v1/statuses/:id/reblog', requireTransport, async (c) => {
    const transport = c.get('transport');
    const target = await transport.message(Number(c.req.param('id')));
    if (!target) return c.json({ error: 'Record not found' }, 404);
    const mid = await transport.messageMid(target.id);
    if (!mid) return c.json({ error: 'cannot resolve message id to boost' }, 422);
    await ingest(transport, target);

    const ref = { mid, addr: target.sender.address };
    const boostText = buildBoostText(ref);
    const quotedText = buildQuotedText(target.sender.displayName, target.text, BOOST_QUOTE_CAP);

    const msg = await transport.post(boostText, { quotedText });
    await ingest(transport, msg);

    // The response wraps our new boost message; it always reflects "you just
    // reblogged this", regardless of what the store's (possibly-stale, in
    // the fake-transport-test sense) boost tally for the boost message
    // itself would say.
    const status = await toStatus(transport, msg);
    return c.json({ ...status, reblogged: true });
  });

  app.post('/api/v1/statuses/:id/unreblog', requireTransport, async (c) => {
    const transport = c.get('transport');
    const target = await transport.message(Number(c.req.param('id')));
    if (!target) return c.json({ error: 'Record not found' }, 404);
    const mid = await transport.messageMid(target.id);

    const ownBoostMsgId = mid ? store.ownBoostMsgId(mid) : null;
    if (ownBoostMsgId !== null) {
      await transport.deleteMessage(ownBoostMsgId);
    }

    // Retracted: report the original with reblogged:false regardless of the
    // store's tally (it isn't updated on delete — the daemon only tracks
    // what it has *seen posted*, not retractions, per the wire convention's
    // "authoritative only for what this node has seen" caveat).
    const status = await toStatus(transport, target, mediaStore.descriptionForMessage(target.id));
    return c.json({ ...status, reblogged: false });
  });

  // --- Favourites / emoji reactions -----------------------------------------

  /**
   * Shared react/unreact flow for both `/favourite` (❤) and the arbitrary
   * `pleroma/reactions/:emoji` endpoints. Applies our own reaction to the
   * store immediately (so the response reflects it without waiting on
   * delivery), and DMs the author unless the target is our own post.
   */
  const reactToStatus = async (
    c: Context<TransportEnv>,
    emoji: string,
    action: 'react' | 'unreact',
  ) => {
    const transport = c.get('transport');
    const target = await transport.message(Number(c.req.param('id')));
    if (!target) return c.json({ error: 'Record not found' }, 404);
    const mid = await transport.messageMid(target.id);
    if (!mid) return c.json({ error: 'cannot resolve message id to react to' }, 422);
    await ingest(transport, target);

    const myAddr = await mapper.ownAddr(transport);
    if (action === 'react') store.applyReaction(mid, myAddr, emoji);
    else store.retractReaction(mid, myAddr, emoji);

    if (target.sender.id !== DC_CONTACT_ID_SELF) {
      const text = action === 'react' ? buildReactionText(emoji, mid) : buildUnreactionText(emoji, mid);
      const quotedText = buildQuotedText(target.sender.displayName, target.text, REACTION_QUOTE_CAP);
      await transport.sendControlDm(target.sender.id, text, quotedText).catch((err) => {
        console.error('sendControlDm failed (non-fatal):', err);
      });
    }

    return c.json(await toStatus(transport, target, mediaStore.descriptionForMessage(target.id)));
  };

  app.post('/api/v1/statuses/:id/favourite', requireTransport, (c) => reactToStatus(c, FAVOURITE_EMOJI, 'react'));
  app.post('/api/v1/statuses/:id/unfavourite', requireTransport, (c) =>
    reactToStatus(c, FAVOURITE_EMOJI, 'unreact'),
  );

  app.put('/api/v1/pleroma/statuses/:id/reactions/:emoji', requireTransport, (c) =>
    reactToStatus(c, decodeURIComponent(c.req.param('emoji') ?? ''), 'react'),
  );
  app.delete('/api/v1/pleroma/statuses/:id/reactions/:emoji', requireTransport, (c) =>
    reactToStatus(c, decodeURIComponent(c.req.param('emoji') ?? ''), 'unreact'),
  );

  // --- Context (ancestors / descendants) -----------------------------------

  app.get('/api/v1/statuses/:id/context', requireTransport, async (c) => {
    const transport = c.get('transport');
    const target = await transport.message(Number(c.req.param('id')));
    if (!target) return c.json({ error: 'Record not found' }, 404);
    await ingest(transport, target);

    // Ancestors: walk the reply-marker chain upward via the store.
    const ancestorMsgs: T.Message[] = [];
    let current: T.Message | null = target;
    for (let depth = 0; depth < MAX_CONTEXT_ANCESTORS && current; depth++) {
      const parsed = parseMarkers(current.text);
      if (!parsed.reply) break;
      const parentMsgId = store.resolveMid(parsed.reply.mid);
      if (parentMsgId === null) break;
      const parentMsg = await transport.message(parentMsgId);
      if (!parentMsg) break;
      await ingest(transport, parentMsg);
      ancestorMsgs.unshift(parentMsg);
      current = parentMsg;
    }

    // Descendants: transitively walk the reply-children index, breadth-first,
    // capped, then sorted chronologically (oldest first).
    const targetMid = await transport.messageMid(target.id);
    const descendantMsgs: T.Message[] = [];
    const queue: string[] = targetMid ? [targetMid] : [];
    const seen = new Set<number>();
    while (queue.length > 0 && descendantMsgs.length < MAX_CONTEXT_DESCENDANTS) {
      const mid = queue.shift()!;
      const childIds = store.replyChildren(mid);
      for (const childId of childIds) {
        if (seen.has(childId) || descendantMsgs.length >= MAX_CONTEXT_DESCENDANTS) continue;
        seen.add(childId);
        const childMsg = await transport.message(childId);
        if (!childMsg) continue;
        await ingest(transport, childMsg);
        descendantMsgs.push(childMsg);
        const childMid = await transport.messageMid(childId);
        if (childMid) queue.push(childMid);
      }
    }
    descendantMsgs.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);

    const ancestors = await Promise.all(ancestorMsgs.map((msg) => toStatus(transport, msg)));
    const descendants = await Promise.all(descendantMsgs.map((msg) => toStatus(transport, msg)));
    return c.json({ ancestors, descendants });
  });

  app.get('/api/v1/statuses/:id', requireTransport, async (c) => {
    const transport = c.get('transport');
    const msg = await transport.message(Number(c.req.param('id')));
    if (!msg) return c.json({ error: 'Record not found' }, 404);
    return c.json(await toStatus(transport, msg, mediaStore.descriptionForMessage(msg.id)));
  });

  // --- deltanet-specific: feed invite + follow ----------------------------

  app.get('/api/deltanet/invite', requireTransport, async (c) =>
    c.json({ invite: await c.get('transport').feedInvite() }),
  );

  app.post('/api/deltanet/follow', requireTransport, async (c) => {
    const { invite } = await c.req.json<{ invite?: string }>();
    if (!invite) return c.json({ error: 'invite missing' }, 422);
    return c.json({ chat_id: await c.get('transport').follow(invite) });
  });

  // --- Blobs / avatars ----------------------------------------------------

  const serveFile = async (path: string | null, c: Context) => {
    if (!path) return c.notFound();
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(path).catch(() => null);
    if (!data) return c.notFound();
    return new Response(new Uint8Array(data));
  };

  const NEUTRAL_BADGE = { initial: '?', color: '#2a3542' };

  app.get('/deltanet/avatar/:contactId', requireTransport, async (c) => {
    const contactId = Number(c.req.param('contactId'));
    const path = await c.get('transport').avatarPath(contactId);
    if (path) return serveFile(path, c);
    const badge = (await c.get('transport').contactBadge(contactId)) ?? NEUTRAL_BADGE;
    const svg = avatarPlaceholderSvg(badge.initial, badge.color);
    return c.body(svg, 200, { 'Content-Type': 'image/svg+xml' });
  });

  // Path keeps the .png extension the account entities advertise; content is
  // an SVG banner, which browsers happily render regardless of extension.
  app.get('/deltanet/header.png', (c) =>
    c.body(headerSvg(), 200, { 'Content-Type': 'image/svg+xml' }),
  );

  app.get('/deltanet/blob/:msgId', requireTransport, async (c) =>
    serveFile(await c.get('transport').blobPath(Number(c.req.param('msgId'))), c),
  );

  // --- Notifications --------------------------------------------------------

  app.get('/api/v1/notifications', async (c) => {
    const transport = ctx.getTransport();
    if (!transport) return c.json([]);
    const notifications = store.listNotifications({
      limit: intParam(c.req.query('limit')) ?? DEFAULT_PAGE,
      maxId: c.req.query('max_id'),
      sinceId: c.req.query('since_id'),
    });
    const mapped = await Promise.all(
      notifications.map((n) =>
        mapNotification(n, transport, mapper, baseUrl, (msgId) => mediaStore.descriptionForMessage(msgId)),
      ),
    );
    return c.json(mapped);
  });

  // --- Stubs PleromaNet polls; empty is a valid, honest answer ------------
  // These work whether or not the daemon is configured yet.

  const emptyList = (path: string) => app.get(path, (c) => c.json([]));
  emptyList('/api/v1/custom_emojis');
  emptyList('/api/v1/trends/tags');
  emptyList('/api/v1/trends');
  emptyList('/api/v2/suggestions');
  emptyList('/api/v1/suggestions');
  emptyList('/api/v1/bookmarks');
  emptyList('/api/v2/pleroma/chats');
  emptyList('/api/v1/filters');
  emptyList('/api/v1/follow_requests');
  app.get('/api/v1/markers', (c) => c.json({}));
  app.get('/api/v1/preferences', (c) => c.json({}));

  // --- Static SPA: serve the built frontend, falling back to index.html ---

  if (staticDir) {
    app.use('*', serveStatic({ root: staticDir }));
    app.get('*', async (c, next) => {
      const path = new URL(c.req.url).pathname;
      if (path.startsWith('/api') || path.startsWith('/oauth') || path.startsWith('/deltanet')) {
        return next();
      }
      return serveStatic({ root: staticDir, path: 'index.html' })(c, next);
    });
  }

  return app;
};
