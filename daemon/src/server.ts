import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  contactToAccount,
  messageToStatus,
  timelineLinkHeader,
  type MastodonStatus,
} from './mastodon/entities.js';
import type { Transport } from './transport/types.js';

export type ServerOptions = {
  baseUrl: string;
  /** Absolute path to a built frontend SPA to serve as static files; skipped if unset/missing. */
  staticDir?: string;
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

export const createApp = (ctx: AppContext, { baseUrl, staticDir }: ServerOptions) => {
  const app = new Hono();

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

  app.get('/api/v1/accounts/:id', requireTransport, async (c) => {
    const contact = await c.get('transport').contact(Number(c.req.param('id')));
    if (!contact) return c.json({ error: 'Record not found' }, 404);
    return c.json(contactToAccount(contact, baseUrl));
  });

  app.get('/api/v1/accounts/:id/statuses', requireTransport, (c) => c.json([]));

  // --- Timelines ----------------------------------------------------------

  const timeline = async (c: Context<TransportEnv>) => {
    const transport = c.get('transport');
    const limit = intParam(c.req.query('limit')) ?? DEFAULT_PAGE;
    const messages = await transport.timeline({
      limit,
      maxId: intParam(c.req.query('max_id')),
      minId: intParam(c.req.query('min_id')) ?? intParam(c.req.query('since_id')),
    });
    const statuses: MastodonStatus[] = messages.map((msg) => messageToStatus(msg, baseUrl));
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

  app.post('/api/v1/statuses', requireTransport, async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    const body = contentType.includes('json')
      ? await c.req.json()
      : await c.req.parseBody();
    const text = String(body['status'] ?? '').trim();
    if (!text) return c.json({ error: 'Validation failed: text cannot be blank' }, 422);
    const msg = await c.get('transport').post(text);
    return c.json(messageToStatus(msg, baseUrl));
  });

  app.get('/api/v1/statuses/:id/context', requireTransport, (c) =>
    c.json({ ancestors: [], descendants: [] }),
  );

  app.get('/api/v1/statuses/:id', requireTransport, async (c) => {
    const msg = await c.get('transport').message(Number(c.req.param('id')));
    if (!msg) return c.json({ error: 'Record not found' }, 404);
    return c.json(messageToStatus(msg, baseUrl));
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

  app.get('/deltanet/avatar/:contactId', requireTransport, async (c) => {
    const path = await c.get('transport').avatarPath(Number(c.req.param('contactId')));
    if (path) return serveFile(path, c);
    const initial = 'δ';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#2a3542"/><text x="48" y="62" font-size="44" text-anchor="middle" fill="#9fd">${initial}</text></svg>`;
    return c.body(svg, 200, { 'Content-Type': 'image/svg+xml' });
  });

  app.get('/deltanet/blob/:msgId', requireTransport, async (c) =>
    serveFile(await c.get('transport').blobPath(Number(c.req.param('msgId'))), c),
  );

  // --- Stubs PleromaNet polls; empty is a valid, honest answer ------------
  // These work whether or not the daemon is configured yet.

  const emptyList = (path: string) => app.get(path, (c) => c.json([]));
  emptyList('/api/v1/notifications');
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
