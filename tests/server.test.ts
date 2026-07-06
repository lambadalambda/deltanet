import { describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import { createApp } from '../src/server.js';
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
  };
  return { transport, messages };
};

const makeApp = () => createApp(makeFakeTransport().transport, { baseUrl: BASE });

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
});

describe('instance metadata', () => {
  it('reports character limits on v2', async () => {
    const res = await makeApp().request('/api/v2/instance');
    expect(res.status).toBe(200);
    const instance = await res.json() as any;
    expect(instance.configuration.statuses.max_characters).toBeGreaterThan(0);
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
    const app = createApp(transport, { baseUrl: BASE });
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
});
