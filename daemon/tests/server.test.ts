import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import type { UpgradeWebSocket, WSEvents } from 'hono/ws';
import type { T } from '@deltachat/jsonrpc-client';
import { createApp, type AppContext } from '../src/server.js';
import type { TimelineQuery, Transport } from '../src/transport/types.js';
import { createStore, ephemeralStorePath } from '../src/store.js';
import { buildReplyText } from '../src/protocol.js';
import { createStreamingHub, type StreamingSocket } from '../src/streaming.js';
import { makeContact, makeMessage } from './entities.test.js';

const BASE = 'http://localhost:4030';

const BOB = makeContact({ id: 11, address: 'zbie604yz@nine.testrun.org', displayName: 'bob' });

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
      sender: BOB,
    }),
  ];
  const mids = new Map<number, string>([
    [10, 'mid-10@example.org'],
    [11, 'mid-11@example.org'],
    [12, 'mid-12@example.org'],
  ]);
  let nextId = 100;
  let nextMid = 100;
  const posts: Array<{ text: string; file?: string; quotedText?: string }> = [];
  const dms: Array<{ contactId: number; text: string; quotedText?: string }> = [];
  const deleted: number[] = [];
  const unfollowed: number[] = [];
  const following: { contactId: number; chatId: number; name: string; addr: string }[] = [
    { contactId: 11, chatId: 200, name: "bob's feed", addr: BOB.address },
  ];
  const followerHandlers = new Set<(contactId: number) => void>();
  const transport: Transport = {
    self: async () => self,
    timeline: async ({ limit, maxId, minId }: TimelineQuery) =>
      messages
        .filter((m) => (maxId === undefined || m.id < maxId) && (minId === undefined || m.id > minId))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit),
    message: async (msgId) => messages.find((m) => m.id === msgId) ?? null,
    post: async (text, opts) => {
      posts.push({ text, file: opts?.file, quotedText: opts?.quotedText });
      const id = nextId++;
      const msg = makeMessage({
        id,
        text,
        timestamp: 1751900000,
        file: opts?.file ?? null,
        fileMime: opts?.file ? 'image/png' : null,
        viewType: opts?.file ? 'Image' : 'Text',
        quote: opts?.quotedText ? { kind: 'JustText', text: opts.quotedText } : null,
      });
      messages.push(msg);
      mids.set(id, `mid-${nextMid++}@example.org`);
      return msg;
    },
    feedInvite: async () => 'OPENPGP4FPR:FAKEINVITE',
    follow: async () => 99,
    contact: async (id) => (id === 1 ? self : id === 11 ? BOB : null),
    contactIdByAddr: async (addr) => {
      const handle = addr.toLowerCase();
      const selfAddr = self.address.toLowerCase();
      if (handle === selfAddr || handle === selfAddr.split('@')[0]) return 1;
      if (handle === BOB.address.toLowerCase()) return 11;
      return null;
    },
    avatarPath: async () => null,
    contactBadge: async (id) =>
      id === 1 ? { initial: 'A', color: '#ff0000' } : null,
    blobPath: async () => null,
    stats: async () => ({ followers: 3, following: 2, statuses: 7 }),
    messageMid: async (msgId) => mids.get(msgId) ?? null,
    sendControlDm: async (contactId, text, quotedText) => {
      dms.push({ contactId, text, quotedText });
    },
    deleteMessage: async (msgId) => {
      deleted.push(msgId);
      const idx = messages.findIndex((m) => m.id === msgId);
      if (idx !== -1) messages.splice(idx, 1);
    },
    following: async () => following,
    unfollow: async (contactId) => {
      const idx = following.findIndex((f) => f.contactId === contactId);
      if (idx === -1) return false;
      following.splice(idx, 1);
      unfollowed.push(contactId);
      return true;
    },
    timelineFrom: async (contactId, { limit, maxId, minId }) =>
      messages
        .filter((m) => m.fromId === contactId)
        .filter((m) => (maxId === undefined || m.id < maxId) && (minId === undefined || m.id > minId))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit),
    onFollower: (handler) => {
      followerHandlers.add(handler);
      return () => followerHandlers.delete(handler);
    },
  };
  const emitFollower = (contactId: number) => {
    for (const handler of followerHandlers) handler(contactId);
  };
  return { transport, messages, posts, dms, deleted, unfollowed, following, mids, emitFollower };
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

describe('deltanet: default images', () => {
  it('serves a header banner image', async () => {
    const res = await makeApp().request('/deltanet/header.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    expect(await res.text()).toContain('<svg');
  });

  it('serves the header even when unconfigured', async () => {
    const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });
    const res = await app.request('/deltanet/header.png');
    expect(res.status).toBe(200);
  });

  it('serves a placeholder avatar using the contact initial and color', async () => {
    const res = await makeApp().request('/deltanet/avatar/1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    const svg = await res.text();
    expect(svg).toContain('#ff0000');
    expect(svg).toContain('>A<');
  });

  it('never 404s for an unknown contact id, serving a neutral placeholder instead', async () => {
    const res = await makeApp().request('/deltanet/avatar/999');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
  });
});

describe('media uploads', () => {
  it('uploads an image and returns a media attachment id', async () => {
    const app = makeApp();
    const form = new FormData();
    form.append('file', new File(['fakepngbytes'], 'photo.png', { type: 'image/png' }));
    form.append('description', 'a lovely photo');
    const res = await app.request('/api/v1/media', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const media = await res.json() as any;
    expect(media.id).toBeTypeOf('string');
    expect(media.type).toBe('image');
    expect(media.description).toBe('a lovely photo');
  });

  it('rejects non-image uploads with 422', async () => {
    const app = makeApp();
    const form = new FormData();
    form.append('file', new File(['not an image'], 'notes.txt', { type: 'text/plain' }));
    const res = await app.request('/api/v1/media', { method: 'POST', body: form });
    expect(res.status).toBe(422);
  });

  it('attaches an uploaded media id to a new status', async () => {
    const { transport, posts } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const form = new FormData();
    form.append('file', new File(['fakepngbytes'], 'photo.png', { type: 'image/png' }));
    const uploadRes = await app.request('/api/v1/media', { method: 'POST', body: form });
    const media = await uploadRes.json() as any;

    const statusForm = new FormData();
    statusForm.append('status', 'look at this');
    statusForm.append('media_ids[]', media.id);
    const res = await app.request('/api/v1/statuses', { method: 'POST', body: statusForm });
    expect(res.status).toBe(200);
    expect(posts[posts.length - 1]?.file).toBeTypeOf('string');
  });

  it('round-trips the alt text description into the posted status attachment', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const form = new FormData();
    form.append('file', new File(['fakepngbytes'], 'photo.png', { type: 'image/png' }));
    form.append('description', 'a lovely photo');
    const uploadRes = await app.request('/api/v1/media', { method: 'POST', body: form });
    const media = await uploadRes.json() as any;

    const statusForm = new FormData();
    statusForm.append('status', 'look at this');
    statusForm.append('media_ids[]', media.id);
    const res = await app.request('/api/v1/statuses', { method: 'POST', body: statusForm });
    const status = await res.json() as any;
    expect(status.media_attachments[0]?.description).toBe('a lovely photo');
  });

  it('allows an image-only post with no text', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const form = new FormData();
    form.append('file', new File(['fakepngbytes'], 'photo.png', { type: 'image/png' }));
    const uploadRes = await app.request('/api/v1/media', { method: 'POST', body: form });
    const media = await uploadRes.json() as any;

    const statusForm = new FormData();
    statusForm.append('status', '');
    statusForm.append('media_ids[]', media.id);
    const res = await app.request('/api/v1/statuses', { method: 'POST', body: statusForm });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/v1/statuses with in_reply_to_id', () => {
  it('posts a reply to own feed with a marker + quotedText, and DMs the author', async () => {
    const { transport, posts, dms } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'nice post!', in_reply_to_id: '12' }),
    });
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    expect(status.in_reply_to_id).toBe('12');

    // one post to our own feed, carrying the marker + quotedText
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain('nice post!');
    expect(posts[0]?.text).toContain('mid-12@example.org');
    expect(posts[0]?.text).toContain(BOB.address);
    expect(posts[0]?.quotedText).toContain('bob');

    // a DM copy goes to the author (bob, contact id 11)
    expect(dms).toHaveLength(1);
    expect(dms[0]?.contactId).toBe(11);
    expect(dms[0]?.text).toBe(posts[0]?.text);
  });

  it('does not send a DM when replying to your own post', async () => {
    const { transport, dms } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    // message 11 is authored by self (fromId defaults to 1)
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'replying to myself', in_reply_to_id: '11' }),
    });
    expect(res.status).toBe(200);
    expect(dms).toHaveLength(0);
  });

  it('404s when the target status does not exist', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'huh', in_reply_to_id: '999' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/statuses/:id/reblog and unreblog', () => {
  it('boosts a status: posts a marker to own feed and returns a status with reblog embedded', async () => {
    const { transport, posts } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/statuses/12/reblog', { method: 'POST' });
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    expect(status.reblog).not.toBeNull();
    expect(status.reblog.id).toBe('12');
    expect(status.reblog.content).toBe('<p>newest, from bob</p>');
    expect(status.reblogged).toBe(true);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain('mid-12@example.org');
    expect(posts[0]?.text).toContain(BOB.address);
    expect(posts[0]?.quotedText).toContain('newest, from bob');
  });

  it('404s boosting an unknown status', async () => {
    const res = await makeApp().request('/api/v1/statuses/999/reblog', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('unreblog deletes our boost message and returns reblogged:false', async () => {
    const { transport, deleted } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const reblogRes = await app.request('/api/v1/statuses/12/reblog', { method: 'POST' });
    const reblogStatus = await reblogRes.json() as any;
    const boostMsgId = Number(reblogStatus.id);

    const res = await app.request('/api/v1/statuses/12/unreblog', { method: 'POST' });
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    expect(status.id).toBe('12');
    expect(status.reblogged).toBe(false);
    expect(deleted).toContain(boostMsgId);
  });

  it('unreblog is a no-op (still 200) when there was no boost to remove', async () => {
    const res = await makeApp().request('/api/v1/statuses/12/unreblog', { method: 'POST' });
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    expect(status.reblogged).toBe(false);
  });
});

describe('status mapping: boost from a follower (synthesized reblog)', () => {
  it('synthesizes a reblog embed when the boosted mid is unknown locally', async () => {
    const { transport, messages } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const { buildBoostText, buildQuotedText } = await import('../src/protocol.js');
    const ref = { mid: 'unknown-mid@remote.org', addr: 'remote@remote.org' };
    messages.push({
      ...messages[0]!,
      id: 500,
      text: buildBoostText(ref),
      quote: { kind: 'JustText', text: buildQuotedText('remote person', 'something neat', 500) },
      fromId: 11,
      sender: BOB,
    } as any);

    const status = await (await app.request('/api/v1/statuses/500')).json() as any;
    expect(status.reblog).not.toBeNull();
    expect(status.reblog.account.acct).toBe('remote@remote.org');
    expect(status.reblog.account.display_name).toBe('remote person');
    expect(status.reblog.content).toBe('<p>something neat</p>');
  });
});

describe('GET /api/v1/statuses/:id/context', () => {
  it('walks ancestors via reply markers and lists descendants via reply children', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    // reply to message 12 (mid-12)
    const replyRes = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'first reply', in_reply_to_id: '12' }),
    });
    const reply = await replyRes.json() as any;

    // reply to the reply
    const reply2Res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'second reply', in_reply_to_id: reply.id }),
    });
    const reply2 = await reply2Res.json() as any;

    // context of the middle reply: ancestor is 12, descendant is reply2
    const context = await (await app.request(`/api/v1/statuses/${reply.id}/context`)).json() as any;
    expect(context.ancestors.map((s: any) => s.id)).toEqual(['12']);
    expect(context.descendants.map((s: any) => s.id)).toEqual([reply2.id]);

    // context of the root: no ancestors, descendants are both replies chronologically
    const rootContext = await (await app.request('/api/v1/statuses/12/context')).json() as any;
    expect(rootContext.ancestors).toEqual([]);
    expect(rootContext.descendants.map((s: any) => s.id)).toEqual([reply.id, reply2.id]);
  });

  it('returns empty ancestors/descendants for a plain post', async () => {
    const context = await (await makeApp().request('/api/v1/statuses/10/context')).json() as any;
    expect(context).toEqual({ ancestors: [], descendants: [] });
  });

  it('a DM copy of a reply (isFeedMessage=false) does not appear in descendants or replies_count, only the feed copy does', async () => {
    // Simulates the real-world double delivery: a reply is sent once via
    // the replier's feed broadcast, and once as a DM copy to the original
    // author — same content, different rfc724Mid. Only the feed copy may
    // register a replyChildren edge (per the design rule this test guards).
    const store = createStore(ephemeralStorePath());
    const { transport, messages, mids } = makeFakeTransport();

    const parentMid = mids.get(12)!; // "newest, from bob"
    const parentAddr = messages.find((m) => m.id === 12)!.sender.address;
    const ref = { mid: parentMid, addr: parentAddr };
    const replyText = buildReplyText('a reply', ref);

    const feedCopy = makeMessage({ id: 500, text: replyText, fromId: 1 });
    const dmCopy = makeMessage({ id: 501, text: replyText, fromId: 1 });
    messages.push(feedCopy, dmCopy);
    mids.set(500, 'feed-copy@example.org');
    mids.set(501, 'dm-copy@example.org');

    // Feed copy: registers the reply edge.
    store.ingestMessage(feedCopy, 'feed-copy@example.org', true);
    // DM copy of the same logical reply: must NOT register a second edge.
    store.ingestMessage(dmCopy, 'dm-copy@example.org', false);

    expect(store.childrenCount(parentMid)).toBe(1);

    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });
    const context = await (await app.request('/api/v1/statuses/12/context')).json() as any;
    expect(context.descendants.map((s: any) => s.id)).toEqual(['500']);

    const parentStatus = await (await app.request('/api/v1/statuses/12')).json() as any;
    expect(parentStatus.replies_count).toBe(1);
  });

  it('a feed-chat reply registers normally (baseline, no DM copy involved)', async () => {
    const store = createStore(ephemeralStorePath());
    const { transport, messages, mids } = makeFakeTransport();

    const parentMid = mids.get(12)!;
    const parentAddr = messages.find((m) => m.id === 12)!.sender.address;
    const ref = { mid: parentMid, addr: parentAddr };
    const replyText = buildReplyText('a reply', ref);

    const feedCopy = makeMessage({ id: 500, text: replyText, fromId: 1 });
    messages.push(feedCopy);
    mids.set(500, 'feed-copy@example.org');
    store.ingestMessage(feedCopy, 'feed-copy@example.org', true);

    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });
    const context = await (await app.request('/api/v1/statuses/12/context')).json() as any;
    expect(context.descendants.map((s: any) => s.id)).toEqual(['500']);

    const parentStatus = await (await app.request('/api/v1/statuses/12')).json() as any;
    expect(parentStatus.replies_count).toBe(1);
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

describe('POST /api/v1/statuses/:id/favourite and unfavourite', () => {
  it('favouriting another contact\'s status DMs a reaction and applies our own reaction locally', async () => {
    const { transport, dms } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/statuses/12/favourite', { method: 'POST' });
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    expect(status.favourited).toBe(true);
    expect(status.favourites_count).toBe(1);

    expect(dms).toHaveLength(1);
    expect(dms[0]?.contactId).toBe(11);
    expect(dms[0]?.text).toContain('❤');
    expect(dms[0]?.text).toContain('mid-12@example.org');
  });

  it('favouriting your own status applies directly without a DM', async () => {
    const { transport, dms } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/statuses/11/favourite', { method: 'POST' });
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    expect(status.favourited).toBe(true);
    expect(status.favourites_count).toBe(1);
    expect(dms).toHaveLength(0);
  });

  it('unfavouriting sends a retraction DM and updates local state', async () => {
    const { transport, dms } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    await app.request('/api/v1/statuses/12/favourite', { method: 'POST' });
    const res = await app.request('/api/v1/statuses/12/unfavourite', { method: 'POST' });
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    expect(status.favourited).toBe(false);
    expect(status.favourites_count).toBe(0);

    expect(dms).toHaveLength(2);
    expect(dms[1]?.text).toContain('✖');
  });

  it('404s favouriting an unknown status', async () => {
    const res = await makeApp().request('/api/v1/statuses/999/favourite', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('PUT/DELETE /api/v1/pleroma/statuses/:id/reactions/:emoji', () => {
  it('adds an arbitrary emoji reaction via DM + local state', async () => {
    const { transport, dms } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/pleroma/statuses/12/reactions/%F0%9F%8E%89', { method: 'PUT' });
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    expect(status.pleroma.emoji_reactions).toEqual([{ name: '🎉', count: 1, me: true }]);
    expect(dms).toHaveLength(1);
    expect(dms[0]?.text).toContain('🎉');
  });

  it('removes an emoji reaction via DELETE', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    await app.request('/api/v1/pleroma/statuses/12/reactions/%F0%9F%8E%89', { method: 'PUT' });
    const res = await app.request('/api/v1/pleroma/statuses/12/reactions/%F0%9F%8E%89', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    expect(status.pleroma.emoji_reactions).toEqual([]);
  });

  it('keeps ❤ favourite-only: reacting with ❤ via the emoji endpoint still counts as favourited', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/pleroma/statuses/12/reactions/%E2%9D%A4', { method: 'PUT' });
    const status = await res.json() as any;
    expect(status.favourited).toBe(true);
    expect(status.pleroma.emoji_reactions).toEqual([]);
  });
});

describe('GET /api/v1/accounts/relationships', () => {
  it('reports following:true for a followed contact', async () => {
    const res = await makeApp().request('/api/v1/accounts/relationships?id[]=11');
    expect(res.status).toBe(200);
    const rels = await res.json() as any;
    expect(rels).toHaveLength(1);
    expect(rels[0].id).toBe('11');
    expect(rels[0].following).toBe(true);
  });

  it('reports following:false for an unfollowed contact', async () => {
    const res = await makeApp().request('/api/v1/accounts/relationships?id[]=999');
    const rels = await res.json() as any;
    expect(rels[0].following).toBe(false);
  });

  it('accepts a single id without brackets', async () => {
    const res = await makeApp().request('/api/v1/accounts/relationships?id=11');
    const rels = await res.json() as any;
    expect(rels).toHaveLength(1);
    expect(rels[0].following).toBe(true);
  });
});

describe('GET /api/v1/accounts/lookup', () => {
  it('resolves a full address to the mapped account with relationship', async () => {
    const res = await makeApp().request('/api/v1/accounts/lookup?acct=zbie604yz%40nine.testrun.org');
    expect(res.status).toBe(200);
    const account = await res.json() as any;
    expect(account.id).toBe('11');
    expect(account.acct).toBe('zbie604yz@nine.testrun.org');
    expect(account.pleroma.relationship.following).toBe(true);
  });

  it('tolerates a leading "@" on the handle', async () => {
    const res = await makeApp().request('/api/v1/accounts/lookup?acct=%40zbie604yz%40nine.testrun.org');
    expect(res.status).toBe(200);
    const account = await res.json() as any;
    expect(account.id).toBe('11');
  });

  it('resolves our own full address to SELF (id 1)', async () => {
    const res = await makeApp().request('/api/v1/accounts/lookup?acct=p6yalimhl%40nine.testrun.org');
    expect(res.status).toBe(200);
    const account = await res.json() as any;
    expect(account.id).toBe('1');
  });

  it('resolves a bare local part matching our own username to SELF (id 1)', async () => {
    const res = await makeApp().request('/api/v1/accounts/lookup?acct=p6yalimhl');
    expect(res.status).toBe(200);
    const account = await res.json() as any;
    expect(account.id).toBe('1');
    expect(account.username).toBe('p6yalimhl');
  });

  it('404s for an unknown handle', async () => {
    const res = await makeApp().request('/api/v1/accounts/lookup?acct=nobody%40nowhere.org');
    expect(res.status).toBe(404);
  });

  it('404s when acct is missing or blank', async () => {
    expect((await makeApp().request('/api/v1/accounts/lookup')).status).toBe(404);
    expect((await makeApp().request('/api/v1/accounts/lookup?acct=')).status).toBe(404);
  });
});

describe('POST /api/v1/accounts/:id/unfollow and /follow', () => {
  it('unfollow stops the feed and returns the relationship', async () => {
    const { transport, unfollowed } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/accounts/11/unfollow', { method: 'POST' });
    expect(res.status).toBe(200);
    const rel = await res.json() as any;
    expect(rel.following).toBe(false);
    expect(unfollowed).toContain(11);
  });

  it('follow returns 422 pointing at invite links', async () => {
    const res = await makeApp().request('/api/v1/accounts/11/follow', { method: 'POST' });
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error).toBeTypeOf('string');
    expect(body.error.toLowerCase()).toContain('invite');
  });
});

describe('GET /api/v1/accounts/:id/statuses', () => {
  it('returns that contact\'s messages mapped as statuses', async () => {
    const res = await makeApp().request('/api/v1/accounts/11/statuses');
    expect(res.status).toBe(200);
    const statuses = await res.json() as any;
    expect(statuses).toHaveLength(1);
    expect(statuses[0].account.id).toBe('11');
    expect(statuses[0].content).toContain('newest, from bob');
  });

  it('returns an empty list for a contact with no messages', async () => {
    const res = await makeApp().request('/api/v1/accounts/999/statuses');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns our own posts for our own account id', async () => {
    const res = await makeApp().request('/api/v1/accounts/1/statuses');
    expect(res.status).toBe(200);
    const statuses = await res.json() as any;
    expect(statuses.map((s: any) => s.id).sort()).toEqual(['10', '11']);
  });
});

describe('GET /api/v1/notifications', () => {
  it('returns an empty list with no notifications', async () => {
    const res = await makeApp().request('/api/v1/notifications');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('lists a favourite notification after a reaction DM is ingested', async () => {
    const { transport, mids, messages } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    // First, ingest message 11 (our own post) so its mid is a known own mid.
    await app.request('/api/v1/timelines/home');

    // Then simulate bob's reaction DM arriving, targeting mid-11's mid.
    const { buildReactionText } = await import('../src/protocol.js');
    const reactionMsg = makeMessage({
      id: 300,
      fromId: 11,
      sender: BOB,
      text: buildReactionText('❤', mids.get(11)!),
    });
    messages.push(reactionMsg);
    mids.set(300, 'reaction-mid@example.org');
    transport.timeline = async () => [reactionMsg];
    await app.request('/api/v1/timelines/home');

    const res = await app.request('/api/v1/notifications');
    expect(res.status).toBe(200);
    const notifications = await res.json() as any;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('favourite');
    expect(notifications[0].account.acct).toBe(BOB.address);
    expect(notifications[0].status.id).toBe('11');
  });

  it('supports a limit query param', async () => {
    const { transport, mids, messages } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    const { buildReactionText } = await import('../src/protocol.js');

    await app.request('/api/v1/timelines/home');

    for (let i = 0; i < 3; i++) {
      const reactionMsg = makeMessage({
        id: 300 + i,
        fromId: 11,
        sender: BOB,
        text: buildReactionText(i === 0 ? '🎉' : i === 1 ? '🎈' : '🎁', mids.get(11)!),
      });
      messages.push(reactionMsg);
      mids.set(300 + i, `reaction-mid-${i}@example.org`);
      transport.timeline = async () => [reactionMsg];
      await app.request('/api/v1/timelines/home');
    }

    const res = await app.request('/api/v1/notifications?limit=1');
    const notifications = await res.json() as any;
    expect(notifications).toHaveLength(1);
  });
});

describe('stub endpoints pleromanet polls', () => {
  it.each([
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

describe('GET /api/v1/streaming: route registration', () => {
  /**
   * A minimal fake satisfying `hono/ws`'s `UpgradeWebSocket` first overload
   * (`(createEvents) => MiddlewareHandler`) without a real websocket upgrade
   * — Hono's fetch-based `app.request()` test helper can't drive an actual
   * `Upgrade: websocket` handshake (see DEVLOG). Calling `createEvents(c)`
   * lets this test exercise `server.ts`'s route wiring — including that it
   * reaches the real streaming hub via `createStreamingEvents` — end to end,
   * then immediately invokes `onOpen`/`onClose` against a fake
   * `StreamingSocket` and returns a plain 200 so the request resolves.
   */
  const makeFakeUpgradeWebSocket = (onOpened?: (socket: StreamingSocket) => void): UpgradeWebSocket =>
    ((createEvents: (c: Context) => WSEvents | Promise<WSEvents>) =>
      async (c: Context) => {
        const events = await createEvents(c);
        const fakeSocket: StreamingSocket & { sent: string[] } = {
          sent: [],
          send(data: string) {
            this.sent.push(data);
          },
        };
        events.onOpen?.(new Event('open'), fakeSocket as any);
        onOpened?.(fakeSocket); // hook to broadcast while still registered, before onClose below
        events.onClose?.(new CloseEvent('close'), fakeSocket as any);
        return c.body(JSON.stringify({ sent: fakeSocket.sent }), 200);
      }) as unknown as UpgradeWebSocket;

  it('is absent (404s) when upgradeWebSocket/hub are not provided to createApp', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/streaming');
    expect(res.status).toBe(404);
  });

  it('registers both the bare path and the trailing-slash variant when wired', async () => {
    const hub = createStreamingHub();
    const app = createApp(makeConfiguredCtx(makeFakeTransport().transport), {
      baseUrl: BASE,
      upgradeWebSocket: makeFakeUpgradeWebSocket(),
      hub,
    });

    for (const path of ['/api/v1/streaming', '/api/v1/streaming/']) {
      const res = await app.request(`${path}?stream=user`);
      expect(res.status).toBe(200);
    }
  });

  it('registers the requesting socket with the hub for the requested stream', async () => {
    const hub = createStreamingHub();
    // Broadcast to 'public' while the socket is still registered (between
    // onOpen and onClose), proving the route wired the real query-parsed
    // stream name through to `hub.register` rather than some fixed default.
    const app = createApp(makeConfiguredCtx(makeFakeTransport().transport), {
      baseUrl: BASE,
      upgradeWebSocket: makeFakeUpgradeWebSocket(() => hub.broadcastUpdate({ id: 'x' }, 999)),
      hub,
    });

    const res = await app.request('/api/v1/streaming?stream=public');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: string[] };
    expect(body.sent).toHaveLength(1);
    expect(JSON.parse(body.sent[0]!).stream).toEqual(['public']);
  });

  it('defaults to the "user" stream (no ?stream= param), which receives notifications', async () => {
    const hub = createStreamingHub();
    const app = createApp(makeConfiguredCtx(makeFakeTransport().transport), {
      baseUrl: BASE,
      upgradeWebSocket: makeFakeUpgradeWebSocket(() => hub.broadcastNotification({ id: 'n' })),
      hub,
    });

    // Default stream (no ?stream=) is 'user' — notifications DO reach it.
    const res = await app.request('/api/v1/streaming');
    const body = (await res.json()) as { sent: string[] };
    expect(body.sent).toHaveLength(1);
    expect(JSON.parse(body.sent[0]!).event).toBe('notification');
  });
});
