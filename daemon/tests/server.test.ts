import { describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import { createApp, type AppContext } from '../src/server.js';
import type { TimelineQuery, Transport } from '../src/transport/types.js';
import { makeContact, makeMessage } from './entities.test.js';

const BASE = 'http://localhost:4030';

const makeFakeTransport = () => {
  const self = makeContact();
  const messages: T.Message[] = [
    makeMessage({ id: 10, text: 'oldest', timestamp: 1751800000 }),
    makeMessage({ id: 11, text: 'middle', timestamp: 1751800100 }),
    makeMessage({
      id: 12,
      text: 'newest, from bob',
      timestamp: 1751800200,
      fromId: 11,
      sender: makeContact({ id: 11, address: 'zbie604yz@nine.testrun.org', displayName: 'bob' }),
    }),
  ];
  let nextId = 100;
  const transport: Transport = {
    self: async () => self,
    timeline: async ({ limit, maxId, minId }: TimelineQuery) =>
      messages
        .filter((m) => (maxId === undefined || m.id < maxId) && (minId === undefined || m.id > minId))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit),
    message: async (msgId) => messages.find((m) => m.id === msgId) ?? null,
    post: async (text) => {
      const msg = makeMessage({ id: nextId++, text, timestamp: 1751900000 });
      messages.push(msg);
      return msg;
    },
    feedInvite: async () => 'OPENPGP4FPR:FAKEINVITE',
    follow: async () => 99,
    contact: async (id) => (id === 1 ? self : null),
    avatarPath: async () => null,
    blobPath: async () => null,
    stats: async () => ({ followers: 3, following: 2, statuses: 7 }),
  };
  return { transport, messages };
};

/** A context that's already configured with a fixed fake transport. */
const makeConfiguredCtx = (transport: Transport): AppContext => ({
  getTransport: () => transport,
  signup: async () => {
    throw new Error('already configured');
  },
});

/** A context with no transport yet, whose signup() can be customized per-test. */
const makeUnconfiguredCtx = (signup?: AppContext['signup']): AppContext => {
  let transport: Transport | null = null;
  return {
    getTransport: () => transport,
    signup: async (displayName, relay) => {
      const t = signup
        ? await signup(displayName, relay)
        : makeFakeTransport().transport;
      transport = t;
      return t;
    },
  };
};

const makeApp = () => createApp(makeConfiguredCtx(makeFakeTransport().transport), { baseUrl: BASE });

describe('oauth flow', () => {
  it('registers an app', async () => {
    const res = await makeApp().request('/api/v1/apps', {
      method: 'POST',
      body: new URLSearchParams({
        client_name: 'pleromanet',
        redirect_uris: 'http://localhost:5173/auth/callback',
        scopes: 'read write follow push',
      }),
    });
    expect(res.status).toBe(200);
    const app = await res.json() as any;
    expect(app.client_id).toBeTypeOf('string');
    expect(app.client_secret).toBeTypeOf('string');
    expect(app.redirect_uri).toBe('http://localhost:5173/auth/callback');
    expect(app.name).toBe('pleromanet');
  });

  it('auto-grants authorization with a redirect carrying code and state', async () => {
    const res = await makeApp().request(
      '/oauth/authorize?client_id=x&response_type=code&state=csrf123&redirect_uri=' +
        encodeURIComponent('http://localhost:5173/auth/callback'),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('http://localhost:5173/auth/callback');
    expect(location.searchParams.get('code')).toBeTruthy();
    expect(location.searchParams.get('state')).toBe('csrf123');
  });

  it('exchanges the code for a token', async () => {
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'anything' }),
    });
    expect(res.status).toBe(200);
    const token = await res.json() as any;
    expect(token.access_token).toBeTypeOf('string');
    expect(token.token_type).toBe('Bearer');
    expect(token.scope).toContain('read');
  });

  it('verifies credentials as the chatmail self contact', async () => {
    const res = await makeApp().request('/api/v1/accounts/verify_credentials', {
      headers: { Authorization: 'Bearer whatever' },
    });
    expect(res.status).toBe(200);
    const account = await res.json() as any;
    expect(account.acct).toBe('p6yalimhl@nine.testrun.org');
    expect(account.username).toBe('p6yalimhl');
  });

  it('merges real follower/following/status counts into verify_credentials', async () => {
    const res = await makeApp().request('/api/v1/accounts/verify_credentials');
    const account = await res.json() as any;
    expect(account.followers_count).toBe(3);
    expect(account.following_count).toBe(2);
    expect(account.statuses_count).toBe(7);
  });
});

describe('instance metadata', () => {
  it('reports character limits on v2', async () => {
    const res = await makeApp().request('/api/v2/instance');
    expect(res.status).toBe(200);
    const instance = await res.json() as any;
    expect(instance.configuration.statuses.max_characters).toBeGreaterThan(0);
  });

  it('serves v2 instance metadata even when unconfigured', async () => {
    const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });
    const res = await app.request('/api/v2/instance');
    expect(res.status).toBe(200);
  });

  it('registers apps and serves oauth stubs even when unconfigured', async () => {
    const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });
    const appRes = await app.request('/api/v1/apps', {
      method: 'POST',
      body: new URLSearchParams({ client_name: 'x', redirect_uris: 'http://x/y' }),
    });
    expect(appRes.status).toBe(200);
    const tokenRes = await app.request('/oauth/token', { method: 'POST' });
    expect(tokenRes.status).toBe(200);
  });
});

describe('timelines', () => {
  it('returns the home timeline newest first with a Link header', async () => {
    const res = await makeApp().request('/api/v1/timelines/home');
    expect(res.status).toBe(200);
    const statuses = await res.json() as any;
    expect(statuses.map((s: { id: string }) => s.id)).toEqual(['12', '11', '10']);
    expect(statuses[0].content).toBe('<p>newest, from bob</p>');
    expect(statuses[0].account.display_name).toBe('bob');
    expect(res.headers.get('link')).toContain('max_id=10');
    expect(res.headers.get('link')).toContain('min_id=12');
  });

  it('paginates with max_id', async () => {
    const res = await makeApp().request('/api/v1/timelines/home?max_id=12&limit=1');
    const statuses = await res.json() as any;
    expect(statuses.map((s: { id: string }) => s.id)).toEqual(['11']);
  });

  it('serves the public timeline too', async () => {
    const res = await makeApp().request('/api/v1/timelines/public');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).length).toBe(3);
  });
});

describe('posting', () => {
  it('creates a status from form-encoded body and shows it in the timeline', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { Authorization: 'Bearer whatever' },
      body: new URLSearchParams({ status: 'hello from the ui', visibility: 'public' }),
    });
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    expect(status.content).toBe('<p>hello from the ui</p>');

    const timeline = await (await app.request('/api/v1/timelines/home')).json() as any;
    expect(timeline[0].content).toBe('<p>hello from the ui</p>');
  });

  it('rejects an empty status', async () => {
    const res = await makeApp().request('/api/v1/statuses', {
      method: 'POST',
      body: new URLSearchParams({ status: '' }),
    });
    expect(res.status).toBe(422);
  });
});

describe('single status', () => {
  it('fetches a status and its (empty) context', async () => {
    const app = makeApp();
    const status = await (await app.request('/api/v1/statuses/11')).json() as any;
    expect(status.content).toBe('<p>middle</p>');
    const context = await (await app.request('/api/v1/statuses/11/context')).json() as any;
    expect(context).toEqual({ ancestors: [], descendants: [] });
  });

  it('404s on unknown status', async () => {
    expect((await makeApp().request('/api/v1/statuses/999')).status).toBe(404);
  });
});

describe('deltanet follow endpoints', () => {
  it('exposes the feed invite', async () => {
    const invite = await (await makeApp().request('/api/deltanet/invite')).json() as any;
    expect(invite.invite).toBe('OPENPGP4FPR:FAKEINVITE');
  });

  it('follows an invite link', async () => {
    const res = await makeApp().request('/api/deltanet/follow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite: 'OPENPGP4FPR:SOMEONE' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).chat_id).toBe(99);
  });
});

describe('stub endpoints pleromanet polls', () => {
  it.each([
    '/api/v1/notifications',
    '/api/v1/custom_emojis',
    '/api/v1/trends/tags',
    '/api/v2/suggestions',
    '/api/v1/bookmarks',
    '/api/v2/pleroma/chats',
    '/api/v1/filters',
  ])('%s returns an empty list', async (path) => {
    const res = await makeApp().request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('sends CORS headers', async () => {
    const res = await makeApp().request('/api/v1/timelines/home', {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('stub endpoints still respond when unconfigured', async () => {
    const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });
    const res = await app.request('/api/v1/notifications');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('GET /api/deltanet/status', () => {
  it('reports unconfigured with a null address', async () => {
    const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });
    const res = await app.request('/api/deltanet/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, address: null });
  });

  it('reports configured with the account address', async () => {
    const res = await makeApp().request('/api/deltanet/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, address: 'p6yalimhl@nine.testrun.org' });
  });
});

describe('POST /api/deltanet/signup', () => {
  it('registers a fresh account and transitions the app to configured', async () => {
    const { transport } = makeFakeTransport();
    let requestedRelay: string | undefined;
    let requestedName: string | undefined;
    const ctx = makeUnconfiguredCtx(async (displayName, relay) => {
      requestedName = displayName;
      requestedRelay = relay;
      return transport;
    });
    const app = createApp(ctx, { baseUrl: BASE });

    const statusBefore = await (await app.request('/api/deltanet/status')).json() as any;
    expect(statusBefore.configured).toBe(false);

    const res = await app.request('/api/deltanet/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'alice' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.account.acct).toBe('p6yalimhl@nine.testrun.org');
    expect(requestedName).toBe('alice');
    expect(requestedRelay).toBe('https://nine.testrun.org');

    const statusAfter = await (await app.request('/api/deltanet/status')).json() as any;
    expect(statusAfter).toEqual({ configured: true, address: 'p6yalimhl@nine.testrun.org' });

    // mastodon endpoints work immediately, no restart needed
    const verify = await (await app.request('/api/v1/accounts/verify_credentials')).json() as any;
    expect(verify.acct).toBe('p6yalimhl@nine.testrun.org');
  });

  it('passes a custom relay through to signup', async () => {
    let requestedRelay: string | undefined;
    const ctx = makeUnconfiguredCtx(async (_displayName, relay) => {
      requestedRelay = relay;
      return makeFakeTransport().transport;
    });
    const app = createApp(ctx, { baseUrl: BASE });
    await app.request('/api/deltanet/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'alice', relay: 'https://example.org' }),
    });
    expect(requestedRelay).toBe('https://example.org');
  });

  it('422s when display_name is missing', async () => {
    const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });
    const res = await app.request('/api/deltanet/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it('422s when display_name is blank', async () => {
    const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });
    const res = await app.request('/api/deltanet/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: '   ' }),
    });
    expect(res.status).toBe(422);
  });

  it('409s if already configured', async () => {
    const res = await makeApp().request('/api/deltanet/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'alice' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBeTypeOf('string');
  });
});

describe('unconfigured mastodon endpoints', () => {
  const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });

  it.each([
    ['/api/v1/accounts/verify_credentials', 'GET'],
    ['/api/v1/timelines/home', 'GET'],
    ['/api/v1/timelines/public', 'GET'],
    ['/api/deltanet/invite', 'GET'],
  ])('%s returns 401 not configured', async (path, method) => {
    const res = await app.request(path, { method });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not configured' });
  });

  it('POST /api/v1/statuses returns 401 not configured', async () => {
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      body: new URLSearchParams({ status: 'hi' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not configured' });
  });

  it('POST /api/deltanet/follow returns 401 not configured', async () => {
    const res = await app.request('/api/deltanet/follow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite: 'OPENPGP4FPR:X' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not configured' });
  });
});
