import { afterAll, describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import type { UpgradeWebSocket, WSEvents } from 'hono/ws';
import type { T } from '@deltachat/jsonrpc-client';
import { createApp, type AppContext } from '../src/server.js';
import type { TimelineQuery, Transport } from '../src/transport/types.js';
import { createStore, ephemeralStorePath } from '../src/store.js';
import { buildReplyText, mintPostUuid, refFromToken, type RefToken } from '../src/protocol.js';
import { buildInviteRequestEnvelope, parseEnvelope } from '../src/envelope.js';
import { decodeBackupContainer, encodeBackupContainer } from '../src/backup.js';
import { openAttestor } from '../src/attest.js';

/** A mid-targeting ref token (legacy targets keyed by mid). */
const midTok = (mid: string): RefToken => ({ kind: 'mid', mid });
/** A mid-targeting MsgRef. */
const midRef = (mid: string, addr: string) => refFromToken({ kind: 'mid', mid }, addr);
import { createStreamingHub, type StreamingSocket } from '../src/streaming.js';
import { makeContact, makeMessage } from './entities.test.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:4030';

/** What the fake transport's exportBackup writes as "core's tar" (bytes only matter for round-trips). */
const FAKE_CORE_TAR = Buffer.from('FAKE-DELTA-CHAT-BACKUP-TAR-BYTES');

// authName set + name empty: BOB has no local petname override by default.
const BOB = makeContact({ id: 11, address: 'zbie604yz@nine.testrun.org', displayName: 'bob', authName: 'bob', name: '' });

const makeFakeTransport = () => {
  let self = makeContact();
  // Mirror of the SELF selfavatar config the real transport would set; lets
  // avatarPath(1) reflect a freshly-uploaded avatar the way DC's blob does.
  let selfAvatarPath: string | null = null;
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
  let nextChatId = 900;
  // Cold contacts minted by ensureContactIdByAddr (addr -> id), modelling core's
  // createContact for never-met root authors.
  let nextContactId = 500;
  const createdContacts = new Map<string, number>();
  // thread-subscribe fakes: broadcasts created, channel posts, chats left, and
  // the KEY-contact reachability map (a real key path exists only for these
  // addresses — default BOB, whom we've met). A test can clear/extend it.
  const broadcasts: Array<{ chatId: number; name: string }> = [];
  const chatPosts: Array<{ chatId: number; text: string }> = [];
  const leftChats: number[] = [];
  const keyReachable = new Map<string, number>([[BOB.address.toLowerCase(), 11]]);
  // In-band introductions attempted via introduceViaInvite (for assertions).
  const introductions: Array<{ invite: string; expectedAddr: string }> = [];
  const posts: Array<{ text: string; file?: string; quotedText?: string }> = [];
  const dms: Array<{ contactId: number; text: string; quotedText?: string }> = [];
  const deleted: number[] = [];
  const unfollowed: number[] = [];
  const profileUpdates: Array<{ displayName?: string; bio?: string; avatarPath?: string | null }> = [];
  const following: { contactId: number; chatId: number; name: string; addr: string }[] = [
    { contactId: 11, chatId: 200, name: "bob's feed", addr: BOB.address },
  ];
  const followerHandlers = new Set<(contactId: number) => void>();
  let lastBackupStamp: number | null = null;
  // Petname fake: contact(11) reflects the local override like core does.
  const setNames: Array<{ contactId: number; name: string }> = [];
  let bobPetname = '';
  const bobWithPetname = (): typeof BOB => ({
    ...BOB,
    name: bobPetname,
    displayName: bobPetname || BOB.authName,
  });
  const transport: Transport = {
    self: async () => self,
    updateProfile: async (updates) => {
      profileUpdates.push({ ...updates });
      if (updates.displayName !== undefined) self = { ...self, displayName: updates.displayName };
      if (updates.bio !== undefined) self = { ...self, status: updates.bio };
      if (updates.avatarPath !== undefined) selfAvatarPath = updates.avatarPath;
    },
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
    // Fake core backup: writes a recognizable "tar" into destDir like core's
    // exportBackup does, and stamps the last-backup timestamp.
    exportBackup: async (destDir, _passphrase) => {
      const path = join(destDir, 'delta-chat-backup-fake.tar');
      writeFileSync(path, FAKE_CORE_TAR);
      lastBackupStamp = Date.now();
      return path;
    },
    lastBackupAt: async () => lastBackupStamp,
    setContactName: async (contactId, name) => {
      setNames.push({ contactId, name });
      if (contactId === 11) bobPetname = name;
    },
    follow: async () => 99,
    contact: async (id) => (id === 1 ? self : id === 11 ? bobWithPetname() : null),
    contacts: async () => [self, bobWithPetname()],
    contactIdByAddr: async (addr) => {
      const handle = addr.toLowerCase();
      const selfAddr = self.address.toLowerCase();
      if (handle === selfAddr || handle === selfAddr.split('@')[0]) return 1;
      if (handle === BOB.address.toLowerCase()) return 11;
      return createdContacts.get(handle) ?? null;
    },
    ensureContactIdByAddr: async (addr) => {
      const handle = addr.toLowerCase();
      const selfAddr = self.address.toLowerCase();
      if (handle === selfAddr || handle === selfAddr.split('@')[0]) return 1;
      if (handle === BOB.address.toLowerCase()) return 11;
      // Model core's createContact: first-create mints a fresh id for a cold
      // (never-met) address, stable across repeat calls.
      const existing = createdContacts.get(handle);
      if (existing !== undefined) return existing;
      const id = nextContactId++;
      createdContacts.set(handle, id);
      return id;
    },
    avatarPath: async (id) => (id === 1 ? selfAvatarPath : null),
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
    createBroadcast: async (name) => {
      const id = nextChatId++;
      broadcasts.push({ chatId: id, name });
      return id;
    },
    chatInvite: async (chatId) => `OPENPGP4FPR:CHAT${chatId}`,
    postToChat: async (chatId, text, opts) => {
      chatPosts.push({ chatId, text });
      const id = nextId++;
      const msg = makeMessage({ id, text, timestamp: 1751900000, file: opts?.file ?? null });
      messages.push(msg);
      mids.set(id, `mid-${nextMid++}@example.org`);
      return msg;
    },
    // A KEY-contact exists only for addresses the test marks reachable (default:
    // SELF + BOB). Clearing/omitting an addr simulates an unreachable root author.
    keyContactIdForAddr: async (addr) => {
      const handle = addr.toLowerCase();
      const selfAddr = self.address.toLowerCase();
      if (handle === selfAddr || handle === selfAddr.split('@')[0]) return 1;
      return keyReachable.get(handle) ?? null;
    },
    contactInvite: async () => 'OPENPGP4FPR:SELF-CONTACT-INVITE',
    // In-band introduction fake: a successful securejoin makes the addr key-
    // reachable (recorded in `introductions` for assertions). Tests can replace
    // this to model failure.
    introduceViaInvite: async (invite, expectedAddr) => {
      introductions.push({ invite, expectedAddr });
      const id = nextContactId++;
      keyReachable.set(expectedAddr.toLowerCase(), id);
      return id;
    },
    leaveChat: async (chatId) => {
      leftChats.push(chatId);
    },
    onFollower: (handler) => {
      followerHandlers.add(handler);
      return () => followerHandlers.delete(handler);
    },
  };
  const emitFollower = (contactId: number) => {
    for (const handler of followerHandlers) handler(contactId);
  };
  return { transport, messages, posts, dms, deleted, unfollowed, following, mids, emitFollower, profileUpdates, createdContacts, broadcasts, chatPosts, leftChats, keyReachable, introductions, setNames };
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

// --- thread-subscribe endpoint fixtures ---
const THREAD_ROOT_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
/** A BOB-authored signed ROOT post message (contact 11), added to a fake transport. */
const bobRootMessage = (id: number) =>
  makeMessage({
    id,
    fromId: 11,
    sender: BOB,
    text: JSON.stringify({
      dn: 2,
      type: 'post',
      uuid: THREAD_ROOT_UUID,
      text: 'bob thread root',
      // A real signature isn't needed for the endpoint (it reads uuid + sender
      // addr); the signed root ref on a REPLY is what a subscriber contacts.
      ts: 1751900000000,
      pubkey: 'fakepubkey',
      sig: 'fakesig',
    }),
  });

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

  it('a reply status in the timeline carries in_reply_to_account_id and mentions for its parent author', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    // message 12 ("newest, from bob") is the parent; reply to it.
    const postRes = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'nice one bob', in_reply_to_id: '12' }),
    });
    expect(postRes.status).toBe(200);

    const timeline = (await (await app.request('/api/v1/timelines/home')).json()) as any;
    const reply = timeline.find((s: any) => s.content === '<p>nice one bob</p>');
    expect(reply.in_reply_to_id).toBe('12');
    expect(reply.in_reply_to_account_id).toBe('11'); // bob's contact id
    expect(reply.mentions).toEqual([
      { id: '11', username: 'zbie604yz', acct: BOB.address, url: `${BASE}/deltanet/contact/11`, display_name: 'bob', auth_name: 'bob' },
    ]);
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

describe('deltanet: served-file content types', () => {
  // Writes a temp file with the given extension, points a fake transport's
  // avatar/blob route at it, and returns the app + the served route paths.
  const withServedFile = async (ext: string, bytes = 'filebytes') => {
    const { writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomUUID } = await import('node:crypto');
    const path = join(tmpdir(), `deltanet-served-${randomUUID()}${ext}`);
    await writeFile(path, bytes);
    const { transport } = makeFakeTransport();
    transport.avatarPath = async () => path;
    transport.blobPath = async () => path;
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    return { app, path, bytes };
  };

  it('serves a stored PNG avatar as image/png', async () => {
    const { app, bytes } = await withServedFile('.png');
    const res = await app.request('/deltanet/avatar/11');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe(bytes);
  });

  it('maps jpg/jpeg avatars to image/jpeg', async () => {
    for (const ext of ['.jpg', '.jpeg']) {
      const { app } = await withServedFile(ext);
      const res = await app.request('/deltanet/avatar/11');
      expect(res.headers.get('content-type')).toBe('image/jpeg');
    }
  });

  it('maps webp/gif/svg avatars to their image types', async () => {
    const cases: Array<[string, string]> = [
      ['.webp', 'image/webp'],
      ['.gif', 'image/gif'],
      ['.svg', 'image/svg+xml'],
    ];
    for (const [ext, mime] of cases) {
      const { app } = await withServedFile(ext);
      const res = await app.request('/deltanet/avatar/11');
      expect(res.headers.get('content-type')).toBe(mime);
    }
  });

  it('falls back to application/octet-stream for an unknown extension', async () => {
    const { app } = await withServedFile('.bin');
    const res = await app.request('/deltanet/avatar/11');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('serves a blob with a content type derived from its extension', async () => {
    const { app, bytes } = await withServedFile('.png');
    const res = await app.request('/deltanet/blob/12');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe(bytes);
  });
});

describe('PATCH /api/v1/accounts/update_credentials', () => {
  it('updates display_name and note (JSON body) and returns the fresh account with stats', async () => {
    const { transport, profileUpdates } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/accounts/update_credentials', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'quiet admin', note: 'no ads, ever' }),
    });
    expect(res.status).toBe(200);
    const account = await res.json() as any;

    // recorded the mapped update
    expect(profileUpdates).toHaveLength(1);
    expect(profileUpdates[0]).toMatchObject({ displayName: 'quiet admin', bio: 'no ads, ever' });
    expect(profileUpdates[0]).not.toHaveProperty('avatarPath');

    // response carries the updated values + verify_credentials-shaped stats
    expect(account.display_name).toBe('quiet admin');
    expect(account.note).toBe('<p>no ads, ever</p>');
    expect(account.source.note).toBe('no ads, ever');
    expect(account.followers_count).toBe(3);
    expect(account.following_count).toBe(2);
    expect(account.statuses_count).toBe(7);

    // subsequent verify_credentials reflects the change (cache invalidated)
    const verify = await (await app.request('/api/v1/accounts/verify_credentials')).json() as any;
    expect(verify.display_name).toBe('quiet admin');
  });

  it('accepts an empty note to clear the bio', async () => {
    const { transport, profileUpdates } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    const res = await app.request('/api/v1/accounts/update_credentials', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: '' }),
    });
    expect(res.status).toBe(200);
    expect(profileUpdates[0]).toMatchObject({ bio: '' });
  });

  it('422s a blank display_name', async () => {
    const { transport, profileUpdates } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    const res = await app.request('/api/v1/accounts/update_credentials', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: '   ' }),
    });
    expect(res.status).toBe(422);
    expect(profileUpdates).toHaveLength(0);
  });

  it('accepts a multipart avatar upload and sets the transport avatar path', async () => {
    const { transport, profileUpdates } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const form = new FormData();
    form.append('display_name', 'pic haver');
    form.append('avatar', new File(['fakepngbytes'], 'me.png', { type: 'image/png' }));
    const res = await app.request('/api/v1/accounts/update_credentials', { method: 'PATCH', body: form });
    expect(res.status).toBe(200);

    expect(profileUpdates).toHaveLength(1);
    expect(profileUpdates[0]?.avatarPath).toBeTypeOf('string');

    // SELF avatar now serves the uploaded file's bytes via the avatar route
    const avatarRes = await app.request('/deltanet/avatar/1');
    expect(avatarRes.status).toBe(200);
    expect(await avatarRes.text()).toBe('fakepngbytes');
  });

  it('422s a non-image avatar upload', async () => {
    const { transport, profileUpdates } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    const form = new FormData();
    form.append('avatar', new File(['nope'], 'notes.txt', { type: 'text/plain' }));
    const res = await app.request('/api/v1/accounts/update_credentials', { method: 'PATCH', body: form });
    expect(res.status).toBe(422);
    expect(profileUpdates).toHaveLength(0);
  });

  it('stores an uploaded header and serves it for SELF via the per-contact route', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const form = new FormData();
    form.append('header', new File(['bannerbytes'], 'banner.png', { type: 'image/png' }));
    const res = await app.request('/api/v1/accounts/update_credentials', { method: 'PATCH', body: form });
    expect(res.status).toBe(200);

    const headerRes = await app.request('/deltanet/header/1');
    expect(headerRes.status).toBe(200);
    expect(await headerRes.text()).toBe('bannerbytes');
  });

  it('returns 401 when unconfigured', async () => {
    const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });
    const res = await app.request('/api/v1/accounts/update_credentials', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'x' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('deltanet: per-contact header route', () => {
  it('serves the default gradient for a non-self contact id', async () => {
    const res = await makeApp().request('/deltanet/header/11');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    expect(await res.text()).toContain('<svg');
  });

  it('serves the default gradient for SELF when no header has been uploaded', async () => {
    const res = await makeApp().request('/deltanet/header/1');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<svg');
  });

  it('account mapping points header/header_static at the per-contact route', async () => {
    const account = await (await makeApp().request('/api/v1/accounts/verify_credentials')).json() as any;
    expect(account.header).toBe(`${BASE}/deltanet/header/1`);
    expect(account.header_static).toBe(`${BASE}/deltanet/header/1`);
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
  it('rejects a non-numeric, non-orig reply target with 404 (never a 500)', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'reply to junk', in_reply_to_id: 'not-an-id' }),
    });
    expect(res.status).toBe(404);
  });

  it('posts a reply to own feed as a v2 envelope (no quotedText) and DMs the author byte-identically', async () => {
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

    // One post to our own feed: a v2 reply envelope with the human text as a
    // field and the parent ref. No quotedText bubble (0001).
    expect(posts).toHaveLength(1);
    const env = JSON.parse(posts[0]!.text);
    expect(env).toMatchObject({ dn: 2, type: 'reply', text: 'nice post!' });
    expect(env.ref.mid).toBe('mid-12@example.org');
    expect(env.ref.addr).toBe(BOB.address);
    expect(posts[0]?.quotedText ?? null).toBeNull();

    // Post attestations: the reply envelope is SIGNED — carries ts/pubkey/sig
    // and verifies against its own embedded pubkey (as the daemon's own addr).
    const { verify } = await import('../src/attest.js');
    expect(typeof env.ts).toBe('number');
    expect(typeof env.pubkey).toBe('string');
    expect(typeof env.sig).toBe('string');
    expect(verify(env, (await transport.self()).address)).toBe(true);

    // A DM copy goes to the author (bob, contact id 11), BYTE-IDENTICAL to the
    // feed copy — same uuid — so a node holding either copy unifies the one
    // logical reply.
    expect(dms).toHaveLength(1);
    expect(dms[0]?.contactId).toBe(11);
    expect(dms[0]?.text).toBe(posts[0]?.text);
    // No legacy marker glyphs anywhere.
    expect(posts[0]?.text).not.toContain('⚑');
    expect(posts[0]?.text).not.toContain('⚓');
    expect(posts[0]?.text).not.toContain('↳re');
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

describe('acting on a DM copy uses the canonical mid (issue point 5)', () => {
  const CANON = 'canonical-feed@example.org';

  /**
   * Inject a message whose text carries a `⚓` canonical marker — i.e. a DM
   * copy the user only received privately (a non-follower's post). Its own mid
   * (via messageMid) is the DM mid; the marker declares the feed copy's mid.
   */
  const withDmCopy = () => {
    const h = makeFakeTransport();
    // A LEGACY DM copy: pre-v1 reply text carrying a `⚓` canonical marker (still
    // parsed). targetRef falls back to this canonical mid (no `⚑` uuid present).
    const dmCopy = makeMessage({
      id: 600,
      text: `a private reply\n\n↳re parent@example.org ${BOB.address}\n⚓ ${CANON}`,
      fromId: 11,
      sender: BOB,
      timestamp: 1751800500,
    });
    h.messages.push(dmCopy);
    h.mids.set(600, 'dm-copy-600@example.org');
    return h;
  };

  it('reply to a DM copy embeds the canonical mid in the outgoing marker', async () => {
    const { transport, posts, dms } = withDmCopy();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'me too', in_reply_to_id: '600' }),
    });
    expect(res.status).toBe(200);
    // The outgoing feed reply references the CANONICAL mid, not the DM copy's.
    expect(posts[0]?.text).toContain(CANON);
    expect(posts[0]?.text).not.toContain('dm-copy-600@example.org');
    // The DM copy to the author also references the canonical mid.
    expect(dms[0]?.text).toContain(CANON);
  });

  it('reblog of a DM copy boosts the canonical mid', async () => {
    const { transport, posts } = withDmCopy();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/statuses/600/reblog', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(posts[0]?.text).toContain(CANON);
    expect(posts[0]?.text).not.toContain('dm-copy-600@example.org');
  });

  it('favouriting a DM copy DMs a reaction referencing the canonical mid', async () => {
    const { transport, dms } = withDmCopy();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/statuses/600/favourite', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(dms).toHaveLength(1);
    expect(dms[0]?.text).toContain(CANON);
    expect(dms[0]?.text).not.toContain('dm-copy-600@example.org');
  });
});

describe('reply thread-root ref derivation + root DM copy', () => {
  const ROOT_ADDR = 'alice@example.org';
  const ROOT_CONTACT = makeContact({ id: 21, address: ROOT_ADDR, displayName: 'alice' });
  const ROOT_UUID = 'aaaa0000-1111-4222-8333-444444444444';
  const B_REPLY_UUID = 'bbbb0000-1111-4222-8333-444444444444';

  /** A signed v2 envelope authored by `addr` (a scratch key per call). */
  const sign = async (env: any, addr: string): Promise<string> => {
    const { openAttestor } = await import('../src/attest.js');
    const { serializeEnvelope } = await import('../src/envelope.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const a = openAttestor(join(mkdtempSync(join(tmpdir(), 'root-key-')), 'k.json'));
    return serializeEnvelope({ ...env, ...a.sign(env, addr) });
  };

  /**
   * Topology: ALICE's root post (uuid=ROOT_UUID) and BOB's reply to it
   * (uuid=B_REPLY_UUID, ref=ALICE, root=ALICE) both held locally + indexed. SELF
   * then replies to BOB's reply → root should resolve to ALICE.
   */
  const withThread = async (
    opts: { bReplyRoot?: any; rootInvite?: string; rootReachable?: boolean } = {},
  ) => {
    const h = makeFakeTransport();
    const { buildPostObject, buildReplyObject } = await import('../src/envelope.js');
    const store = createStore(ephemeralStorePath());

    // ALICE's root post (v2, signed, carries ROOT_UUID; optionally an in-band
    // contact invite — unsigned by design, so splicing it in keeps the sig valid).
    const rootEnv = opts.rootInvite
      ? { ...buildPostObject('the root', ROOT_UUID), invite: opts.rootInvite }
      : buildPostObject('the root', ROOT_UUID);
    const rootText = await sign(rootEnv, ROOT_ADDR);
    const rootMsg = makeMessage({ id: 300, text: rootText, fromId: 21, sender: ROOT_CONTACT });

    // BOB's reply to ALICE (ref=ALICE root, root=ALICE unless overridden).
    const bReplyText = await sign(
      buildReplyObject(
        'bob replies',
        B_REPLY_UUID,
        { u: ROOT_UUID, addr: ROOT_ADDR },
        undefined,
        'bReplyRoot' in opts ? opts.bReplyRoot : { u: ROOT_UUID, addr: ROOT_ADDR },
      ),
      BOB.address,
    );
    const bReplyMsg = makeMessage({ id: 301, text: bReplyText, fromId: 11, sender: BOB });

    h.messages.push(rootMsg, bReplyMsg);
    h.mids.set(300, 'root@example.org');
    h.mids.set(301, 'breply@example.org');
    store.ingestMessage(rootMsg, 'root@example.org', true);
    store.ingestMessage(bReplyMsg, 'breply@example.org', true);
    // SELF has met ALICE by default (a key path exists) — the root DM copy tests
    // are about recipient DERIVATION; the introduction-fallback tests pass
    // `rootReachable: false` to model a never-met root author.
    if (opts.rootReachable !== false) h.keyReachable.set(ROOT_ADDR.toLowerCase(), 21);
    return { ...h, store };
  };

  const parseLast = (posts: Array<{ text: string }>) => JSON.parse(posts.at(-1)!.text);

  it('parent-with-root: reuses the parent reply\'s root verbatim', async () => {
    const { transport, posts, store } = await withThread();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });

    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'self replies deep', in_reply_to_id: '301' }),
    });
    expect(res.status).toBe(200);
    const env = parseLast(posts);
    expect(env.type).toBe('reply');
    expect(env.root).toEqual({ u: ROOT_UUID, addr: ROOT_ADDR });
  });

  it('parent-is-root: a non-reply parent with a uuid becomes the root', async () => {
    const { transport, posts, store } = await withThread();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });

    // Reply directly to ALICE's root post (300) → parent IS the root.
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'reply to root', in_reply_to_id: '300' }),
    });
    expect(res.status).toBe(200);
    expect(parseLast(posts).root).toEqual({ u: ROOT_UUID, addr: ROOT_ADDR });
  });

  it('deep chain walked: parent reply WITHOUT a root climbs ancestors to the root', async () => {
    // BOB's reply carries NO root (older reply) → deriving SELF's root must walk
    // from BOB's reply up to ALICE's held root post.
    const { transport, posts, store } = await withThread({ bReplyRoot: undefined });
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });

    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'self replies deep', in_reply_to_id: '301' }),
    });
    expect(res.status).toBe(200);
    expect(parseLast(posts).root).toEqual({ u: ROOT_UUID, addr: ROOT_ADDR });
  });

  it('unknown -> omitted: a legacy (uuid-less, non-envelope) parent yields no root', async () => {
    const { transport, posts } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    // Message 12 ("newest, from bob") is a plain non-envelope string: no uuid,
    // not a reply → parent-is-root but uuid-less → omit.
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'reply to legacy', in_reply_to_id: '12' }),
    });
    expect(res.status).toBe(200);
    expect(parseLast(posts).root).toBeUndefined();
  });

  it('DM recipients: parent author AND root author, deduped, never SELF, both byte-identical', async () => {
    const { transport, posts, dms, store, createdContacts } = await withThread();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });

    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'self replies deep', in_reply_to_id: '301' }),
    });
    expect(res.status).toBe(200);
    const replyText = posts.at(-1)!.text;

    // Parent author (BOB, id 11) + root author (ALICE via her KEY-contact, 21 —
    // never an addr-minted keyless row, which cannot be encrypted to).
    const recipients = dms.map((d) => d.contactId);
    expect(recipients).toContain(11); // parent author BOB
    expect(recipients).toContain(21); // root author ALICE (key-contact)
    // Both copies are byte-identical to the feed copy (same uuid).
    for (const d of dms) expect(d.text).toBe(replyText);
  });

  it('root DM deduped when the root author IS the parent author (single DM)', async () => {
    // Reply directly to ALICE's root: parent author == root author == ALICE.
    // ALICE is NOT a known contact here (message 300 is from contact id 21 but
    // the parent-copy uses target.sender.id), so only the parent copy goes out.
    const { transport, dms, store } = await withThread();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });

    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'reply to root', in_reply_to_id: '300' }),
    });
    expect(res.status).toBe(200);
    // Root addr == parent addr → root copy suppressed; exactly one DM (parent).
    expect(dms.map((d) => d.contactId)).toEqual([21]);
  });

  it('never DMs SELF as the root author', async () => {
    // A thread whose ROOT is authored by SELF: SELF's own address must never
    // receive a root DM copy.
    const h = makeFakeTransport();
    const self = await h.transport.self();
    const { buildPostObject, buildReplyObject } = await import('../src/envelope.js');
    const store = createStore(ephemeralStorePath());

    const selfRootText = await sign(buildPostObject('self root', ROOT_UUID), self.address);
    const selfRoot = makeMessage({ id: 310, text: selfRootText, fromId: 1 });
    // BOB replies to SELF's root, carrying root=SELF.
    const bReply = await sign(
      buildReplyObject('bob', B_REPLY_UUID, { u: ROOT_UUID, addr: self.address }, undefined, {
        u: ROOT_UUID,
        addr: self.address,
      }),
      BOB.address,
    );
    const bReplyMsg = makeMessage({ id: 311, text: bReply, fromId: 11, sender: BOB });
    h.messages.push(selfRoot, bReplyMsg);
    h.mids.set(310, 'selfroot@example.org');
    h.mids.set(311, 'breply2@example.org');
    store.ingestMessage(selfRoot, 'selfroot@example.org', true);
    store.ingestMessage(bReplyMsg, 'breply2@example.org', true);

    const app = createApp(makeConfiguredCtx(h.transport), { baseUrl: BASE, store });
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'reply, root is self', in_reply_to_id: '311' }),
    });
    expect(res.status).toBe(200);
    // Only the parent (BOB, id 11) is DMed; SELF (id 1) is never a recipient.
    expect(h.dms.map((d) => d.contactId)).toEqual([11]);
    expect(h.dms.map((d) => d.contactId)).not.toContain(1);
  });

  it('root DM send failure does not fail the reply (best-effort)', async () => {
    const h = await withThread();
    const { transport, posts, store, keyReachable } = h;
    // ALICE's key-contact send throws; parent DM (BOB, 11) is fine.
    keyReachable.set(ROOT_ADDR.toLowerCase(), 999);
    const origSend = transport.sendControlDm;
    transport.sendControlDm = async (contactId, text, quotedText) => {
      if (contactId === 999) throw new Error('cold encrypt failed');
      return origSend(contactId, text, quotedText);
    };
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });

    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'self replies deep', in_reply_to_id: '301' }),
    });
    // The reply itself + feed post still succeed despite the root-copy failure.
    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
  });

  it('stamps our contact invite (unsigned) onto outgoing content envelopes', async () => {
    const { transport, posts, store } = await withThread();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });
    for (const body of [
      { status: 'a plain post' },
      { status: 'a reply', in_reply_to_id: '301' },
    ]) {
      const res = await app.request('/api/v1/statuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      expect(parseLast(posts).invite).toBe('OPENPGP4FPR:SELF-CONTACT-INVITE');
    }
  });

  it('unreachable root author: introduces via the root post invite, then delivers the copy', async () => {
    const h = await withThread({
      rootReachable: false,
      rootInvite: 'OPENPGP4FPR:ALICE-INVITE',
    });
    const app = createApp(makeConfiguredCtx(h.transport), { baseUrl: BASE, store: h.store });

    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'self replies deep', in_reply_to_id: '301' }),
    });
    expect(res.status).toBe(200);
    // The introduction runs in the background (a securejoin is slow) — flush it.
    await new Promise((r) => setTimeout(r, 20));
    expect(h.introductions).toEqual([
      { invite: 'OPENPGP4FPR:ALICE-INVITE', expectedAddr: ROOT_ADDR },
    ]);
    // The copy went to the freshly-introduced key-contact.
    const introducedId = h.keyReachable.get(ROOT_ADDR.toLowerCase());
    expect(introducedId).toBeDefined();
    expect(h.dms.map((d) => d.contactId)).toContain(introducedId);
  });

  it('failed introductions are negative-cached and never fail the reply', async () => {
    const h = await withThread({
      rootReachable: false,
      rootInvite: 'OPENPGP4FPR:ALICE-INVITE',
    });
    const attempts: string[] = [];
    h.transport.introduceViaInvite = async (invite) => {
      attempts.push(invite);
      return null; // dead invite / handshake never completes
    };
    const app = createApp(makeConfiguredCtx(h.transport), { baseUrl: BASE, store: h.store });

    for (const text of ['first deep reply', 'second deep reply']) {
      const res = await app.request('/api/v1/statuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: text, in_reply_to_id: '301' }),
      });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
    }
    // One attempt only — the failure is negative-cached per addr.
    expect(attempts).toHaveLength(1);
    // No root copy, but parent copies (BOB) went out for both replies.
    expect(h.dms.filter((d) => d.contactId === 11)).toHaveLength(2);
  });

  it('plain ingest never triggers an introduction (safety)', async () => {
    // A foreign message CARRYING an invite must not make the daemon securejoin
    // anyone — introductions run only on explicit need (own sends, subscribe).
    const h = await withThread({ rootInvite: 'OPENPGP4FPR:ALICE-INVITE' });
    const app = createApp(makeConfiguredCtx(h.transport), { baseUrl: BASE, store: h.store });
    await app.request('/api/v1/timelines/home'); // ingests all fake messages
    await app.request('/api/v1/statuses/300/context');
    expect(h.introductions).toEqual([]);
  });
});

describe('POST /api/v1/statuses/:id/reblog and unreblog', () => {
  it('boosts a status: posts a v2 boost envelope (ref only, no embedded content) and returns a status with reblog embedded', async () => {
    const { transport, posts } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/statuses/12/reblog', { method: 'POST' });
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    expect(status.reblog).not.toBeNull();
    expect(status.reblog.id).toBe('12');
    expect(status.reblog.content).toBe('<p>newest, from bob</p>');
    expect(status.reblogged).toBe(true);

    // The emitted boost is a v2 envelope: type:"boost" + ref, no embedded
    // original content (0002 — embedding returns with attestations later).
    expect(posts).toHaveLength(1);
    const env = JSON.parse(posts[0]!.text);
    expect(env).toMatchObject({ dn: 2, type: 'boost' });
    expect(env.ref.mid).toBe('mid-12@example.org');
    expect(env.ref.addr).toBe(BOB.address);
    expect(env.text).toBeUndefined();
    expect(posts[0]?.quotedText ?? null).toBeNull();
  });

  it('embeds the SIGNED original envelope verbatim as `orig` when boosting a signed post', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { openAttestor } = await import('../src/attest.js');
    const { buildPostObject, serializeEnvelope, parseEnvelope } = await import('../src/envelope.js');

    const dir = mkdtempSync(join(tmpdir(), 'reblog-signed-'));
    // A signed post authored by BOB (external attestor).
    const bobA = openAttestor(join(dir, 'bob.json'));
    const postEnv = buildPostObject('bob signed post', 'bbbb2222-3333-4444-8555-666666666666');
    const signed = { ...postEnv, ...bobA.sign(postEnv, BOB.address) };

    const { transport, messages, posts } = makeFakeTransport();
    messages.push(
      makeMessage({ id: 13, text: serializeEnvelope(signed), fromId: 11, sender: BOB, timestamp: 1751800300 }),
    );
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const res = await app.request('/api/v1/statuses/13/reblog', { method: 'POST' });
    expect(res.status).toBe(200);

    const env = JSON.parse(posts.at(-1)!.text);
    expect(env).toMatchObject({ dn: 2, type: 'boost' });
    // The boosted post's complete signed envelope, embedded VERBATIM.
    expect(env.orig).toEqual(signed);
    expect(parseEnvelope(posts.at(-1)!.text)?.orig?.sig).toBe(signed.sig);
    rmSync(dir, { recursive: true, force: true });
  });

  it('stays ref-only (no orig) when boosting an UNSIGNED/legacy post', async () => {
    const { transport, posts } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    // message #12 is plain text ("newest, from bob") — unsigned, nothing to attest.
    await app.request('/api/v1/statuses/12/reblog', { method: 'POST' });
    const env = JSON.parse(posts.at(-1)!.text);
    expect(env.type).toBe('boost');
    expect(env.orig).toBeUndefined();
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

describe('status mapping: boost from a follower (unresolvable -> placeholder)', () => {
  it('renders an honest placeholder (reblog:null) when the boosted target is unknown locally', async () => {
    const { transport, messages } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const { buildBoostText } = await import('../src/protocol.js');
    const ref = midRef('unknown-mid@remote.org', 'remote@remote.org');
    messages.push({
      ...messages[0]!,
      id: 500,
      text: buildBoostText(ref, mintPostUuid()),
      fromId: 11,
      sender: BOB,
    } as any);

    const status = await (await app.request('/api/v1/statuses/500')).json() as any;
    // 0002: no synthesized/attributed content; the booster's own status carries
    // the placeholder + a deltanet marker so the frontend can render it.
    expect(status.reblog).toBeNull();
    expect(status.content).toBe('<p>[boosted post unavailable]</p>');
    expect(status.pleroma.deltanet).toEqual({
      placeholder: 'boost',
      ref: { key: 'unknown-mid@remote.org', addr: 'remote@remote.org' },
    });
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

  it('the ancestor climb crosses the uuid→mid era boundary (mixed-era chain)', async () => {
    // Live-QA regression: legacy root (12, uuid-less) ← reply (v2, MID ref)
    // ← reply2 (v2, uuid ref). Entering the thread from reply2 must climb
    // THROUGH the mid-ref link to the legacy root, not stop at the boundary —
    // /thread/<reply2> and /thread/<reply> must render the same ancestors.
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });

    const reply = await (await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'first reply', in_reply_to_id: '12' }),
    })).json() as any;
    const reply2 = await (await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'second reply', in_reply_to_id: reply.id }),
    })).json() as any;

    const deep = await (await app.request(`/api/v1/statuses/${reply2.id}/context`)).json() as any;
    expect(deep.ancestors.map((s: any) => s.id)).toEqual(['12', reply.id]);
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
    const ref = midRef(parentMid, parentAddr);
    const replyText = buildReplyText('a reply', ref, mintPostUuid());

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
    const ref = midRef(parentMid, parentAddr);
    const replyText = buildReplyText('a reply', ref, mintPostUuid());

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

describe('GET /api/v1/statuses/orig-<uuid> (verified boost embed thread view)', () => {
  // A verified boost of CAROL's signed post, held by SELF but the ORIGINAL
  // post itself is NOT held locally — exactly the "clicked a verified embed"
  // topology. `boostsByMid[<uuid>]` maps the orig uuid to the held boost msgId.
  const ORIG_UUID = 'cccc1111-2222-4333-8444-555555555555';
  const CAROL = makeContact({ id: 22, address: 'carol@nine.testrun.org', displayName: 'Carol Sparkle' });

  /**
   * Build an app whose store holds a boost message (id 60) embedding CAROL's
   * SIGNED original as `orig` (uuid ORIG_UUID) — but NOT the original post.
   * `contactIdByAddr`/`contact` are extended so CAROL resolves to a real
   * contact (contact-first attribution rides for free through the mapper).
   */
  const makeEmbedApp = async () => {
    const { openAttestor } = await import('../src/attest.js');
    const { buildPostObject, buildBoostObject, serializeEnvelope } = await import('../src/envelope.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'orig-status-'));
    // Carol signs her own post with her own key (external attestor).
    const carolA = openAttestor(join(dir, 'carol.json'));
    const postEnv = buildPostObject('carol attested post', ORIG_UUID);
    const orig = { ...postEnv, ...carolA.sign(postEnv, CAROL.address) };
    // Bob's boost of Carol's post, embedding her signed envelope verbatim.
    const boostEnv = buildBoostObject('boost-uuid-60', { u: ORIG_UUID, addr: CAROL.address }, orig);

    const { transport, messages } = makeFakeTransport();
    // Extend the fake transport so CAROL resolves to a real contact.
    const baseContact = transport.contact;
    const baseIdByAddr = transport.contactIdByAddr;
    transport.contact = async (id) => (id === 22 ? CAROL : baseContact(id));
    transport.contactIdByAddr = async (addr) =>
      addr.toLowerCase() === CAROL.address.toLowerCase() ? 22 : baseIdByAddr(addr);

    messages.push(
      makeMessage({ id: 60, text: serializeEnvelope(boostEnv), fromId: 11, sender: BOB, timestamp: 1751800400 }),
    );

    const store = createStore(ephemeralStorePath());
    // Ingest the boost as a FEED message so boostsByMid[ORIG_UUID] registers.
    store.ingestMessage(messages.find((m) => m.id === 60)!, 'mid-60@example.org', true);

    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });
    return { app, store };
  };

  it('returns the verified embed status with contact-first attribution', async () => {
    const { app } = await makeEmbedApp();
    const res = await app.request(`/api/v1/statuses/orig-${ORIG_UUID}`);
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    expect(status.id).toBe(`orig-${ORIG_UUID}`);
    expect(status.content).toBe('<p>carol attested post</p>');
    // Contact-first attribution: Carol's real DC contact, not the addr shell.
    expect(status.account.display_name).toBe('Carol Sparkle');
    expect(status.account.id).toBe('22');
    // The focal status is the ORIGINAL, not a boost wrapper.
    expect(status.reblog).toBeNull();
  });

  it('returns the real local status when the original is held locally', async () => {
    // Reblog BOB's plain post #12; SELF then holds #12, so orig-<its uuid>
    // resolves to the real local message rather than an embed.
    const { transport } = makeFakeTransport();
    const store = createStore(ephemeralStorePath());
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });

    // Give #12 a uuid by reposting as a signed v2 post from SELF.
    const postRes = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'my own post' }),
    });
    const post = await postRes.json() as any;
    const { parseEnvelope } = await import('../src/envelope.js');
    // Recover the uuid the daemon minted for it.
    const posted = transport;
    const msg = await posted.message(Number(post.id));
    const uuid = parseEnvelope(msg!.text)!.uuid!;

    const res = await app.request(`/api/v1/statuses/orig-${uuid}`);
    expect(res.status).toBe(200);
    const status = await res.json() as any;
    // Real local status: numeric id, our own content.
    expect(status.id).toBe(post.id);
    expect(status.content).toBe('<p>my own post</p>');
  });

  it('404s (never 500) for an orig-<uuid> with no verifiable candidate', async () => {
    const res = await makeApp().request('/api/v1/statuses/orig-deadbeef-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('404s (never 500) for a wholly non-numeric, non-orig id', async () => {
    const res = await makeApp().request('/api/v1/statuses/not-a-real-id');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/statuses/orig-<uuid>/context', () => {
  const ORIG_UUID = 'dddd1111-2222-4333-8444-555555555555';

  it('returns empty ancestors/descendants when we hold no reply children', async () => {
    const res = await makeApp().request(`/api/v1/statuses/orig-${ORIG_UUID}/context`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ancestors: [], descendants: [] });
  });

  it('lists resolvable reply children for the orig post key as descendants', async () => {
    const store = createStore(ephemeralStorePath());
    const { transport, messages } = makeFakeTransport();

    // A reply we DO hold, targeting the orig post key by uuid (we never got
    // the original, but we hold a DM reply copy referencing it).
    const ref = refFromToken({ kind: 'uuid', uuid: ORIG_UUID }, 'carol@nine.testrun.org');
    const replyText = buildReplyText('reply to the orig', ref, mintPostUuid());
    const replyMsg = makeMessage({ id: 70, text: replyText, fromId: 11, sender: BOB, timestamp: 1751800500 });
    messages.push(replyMsg);
    store.ingestMessage(replyMsg, 'mid-70@example.org', true);

    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });
    const res = await app.request(`/api/v1/statuses/orig-${ORIG_UUID}/context`);
    expect(res.status).toBe(200);
    const context = await res.json() as any;
    expect(context.ancestors).toEqual([]);
    expect(context.descendants.map((s: any) => s.id)).toEqual(['70']);
  });

  it('404s (never 500) for a non-numeric, non-orig context id', async () => {
    const res = await makeApp().request('/api/v1/statuses/garbage/context');
    expect(res.status).toBe(404);
  });
});

describe('action routes harden non-numeric ids to 404 (never 500)', () => {
  const ORIG = 'orig-eeee1111-2222-4333-8444-555555555555';
  it('reblog', async () => {
    expect((await makeApp().request(`/api/v1/statuses/${ORIG}/reblog`, { method: 'POST' })).status).toBe(404);
  });
  it('unreblog', async () => {
    expect((await makeApp().request(`/api/v1/statuses/${ORIG}/unreblog`, { method: 'POST' })).status).toBe(404);
  });
  it('favourite', async () => {
    expect((await makeApp().request(`/api/v1/statuses/${ORIG}/favourite`, { method: 'POST' })).status).toBe(404);
  });
  it('unfavourite', async () => {
    expect((await makeApp().request(`/api/v1/statuses/${ORIG}/unfavourite`, { method: 'POST' })).status).toBe(404);
  });
  it('emoji reaction PUT', async () => {
    expect(
      (await makeApp().request(`/api/v1/pleroma/statuses/${ORIG}/reactions/%F0%9F%8E%89`, { method: 'PUT' })).status,
    ).toBe(404);
  });
  it('garbage id on reblog', async () => {
    expect((await makeApp().request('/api/v1/statuses/xyz/reblog', { method: 'POST' })).status).toBe(404);
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
    // The retraction DM is a v2 unreact envelope.
    const env = JSON.parse(dms[1]!.text);
    expect(env).toMatchObject({ dn: 2, type: 'unreact', emoji: '❤' });
    expect(dms[1]?.text).not.toContain('✖');
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

  it('follow on a not-yet-followed known contact records a pending invite-request', async () => {
    const { transport, dms } = makeFakeTransport();
    // Make id 11 (bob) a *known but not-yet-followed* contact.
    transport.following = async () => [];
    const store = createStore(ephemeralStorePath());
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });

    const res = await app.request('/api/v1/accounts/11/follow', { method: 'POST' });
    expect(res.status).toBe(200);
    const rel = await res.json() as any;
    expect(rel.id).toBe('11');
    expect(rel.following).toBe(false);
    expect(rel.requested).toBe(true);

    // A v2 invite-request envelope DM was sent to bob (contact 11), no quote (0001).
    expect(dms).toHaveLength(1);
    expect(dms[0]?.contactId).toBe(11);
    expect(dms[0]?.text).toBe(buildInviteRequestEnvelope());
    expect(dms[0]?.quotedText ?? null).toBeNull();

    // Pending recorded against bob's address.
    expect(store.hasPendingFollowRequest(BOB.address)).toBe(true);
  });

  it('follow on an already-followed contact is a no-op returning following:true', async () => {
    const { transport, dms } = makeFakeTransport(); // bob (11) is already followed
    const store = createStore(ephemeralStorePath());
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });

    const res = await app.request('/api/v1/accounts/11/follow', { method: 'POST' });
    expect(res.status).toBe(200);
    const rel = await res.json() as any;
    expect(rel.following).toBe(true);
    expect(rel.requested).toBe(false);
    expect(dms).toHaveLength(0); // no invite-request sent
    expect(store.hasPendingFollowRequest(BOB.address)).toBe(false);
  });

  it('follow on an unknown contact id 404s', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    const res = await app.request('/api/v1/accounts/999/follow', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('follow-back: relationships report requested for pending contacts', () => {
  it('reports requested:true for a contact with a pending invite-request', async () => {
    const { transport } = makeFakeTransport();
    transport.following = async () => [];
    const store = createStore(ephemeralStorePath());
    store.addPendingFollowRequest(BOB.address, 1000);
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });

    const res = await app.request('/api/v1/accounts/relationships?id[]=11');
    const rels = await res.json() as any;
    expect(rels[0].id).toBe('11');
    expect(rels[0].following).toBe(false);
    expect(rels[0].requested).toBe(true);
  });

  it('does not report requested once the pending entry is cleared (join completed)', async () => {
    const { transport } = makeFakeTransport(); // bob already in following()
    const store = createStore(ephemeralStorePath());
    // Simulate: request was pending, then the grant arrived and we joined.
    store.addPendingFollowRequest(BOB.address, 1000);
    store.clearPendingFollowRequest(BOB.address);
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store });

    const res = await app.request('/api/v1/accounts/relationships?id[]=11');
    const rels = await res.json() as any;
    expect(rels[0].following).toBe(true);
    expect(rels[0].requested).toBe(false);
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
      text: buildReactionText('❤', midTok(mids.get(11)!)),
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
        text: buildReactionText(i === 0 ? '🎉' : i === 1 ? '🎈' : '🎁', midTok(mids.get(11)!)),
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

describe('thread subscription endpoints (thread-subscribe)', () => {
  const setup = (opts?: { reachable?: boolean }) => {
    const fake = makeFakeTransport();
    fake.messages.push(bobRootMessage(500));
    if (opts?.reachable === false) fake.keyReachable.clear();
    const store = createStore(ephemeralStorePath());
    const app = createApp(makeConfiguredCtx(fake.transport), { baseUrl: BASE, store });
    return { app, store, fake };
  };
  const parseEnv = (text: string) => JSON.parse(text) as Record<string, any>;

  it('subscribes: DMs a scoped invite-request to the root author + reports pending', async () => {
    const { app, store, fake } = setup();
    const res = await app.request('/api/v1/pleroma/statuses/500/subscribe', { method: 'POST' });
    expect(res.status).toBe(200);
    const status = (await res.json()) as any;
    expect(status.pleroma.deltanet.thread_subscribed).toBe(true); // optimistic pending
    // Scoped invite-request DM went to BOB (key-contact 11).
    const req = fake.dms.find((d) => parseEnv(d.text).type === 'invite-request');
    expect(req?.contactId).toBe(11);
    expect(parseEnv(req!.text).scope.thread).toBe(`u:${THREAD_ROOT_UUID}`);
    expect(store.hasPendingThreadRequest(THREAD_ROOT_UUID)).toBe(true);
  });

  it('422 (unreachable_author) with NO cold send when there is no key path AND no invite', async () => {
    const { app, store, fake } = setup({ reachable: false });
    const res = await app.request('/api/v1/pleroma/statuses/500/subscribe', { method: 'POST' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.code).toBe('unreachable_author');
    // No invite-request DM was attempted (no cold send), no introduction either
    // (the root envelope carries no invite to introduce through).
    expect(fake.dms.some((d) => parseEnv(d.text).type === 'invite-request')).toBe(false);
    expect(fake.introductions).toEqual([]);
    expect(store.hasPendingThreadRequest(THREAD_ROOT_UUID)).toBe(false);
  });

  it('unreachable author WITH a root invite: introduces in-band, then subscribes', async () => {
    const fake = makeFakeTransport();
    const rootMsg = bobRootMessage(500);
    rootMsg.text = JSON.stringify({ ...JSON.parse(rootMsg.text), invite: 'OPENPGP4FPR:BOB-INVITE' });
    fake.messages.push(rootMsg);
    fake.keyReachable.clear(); // never met BOB
    const store = createStore(ephemeralStorePath());
    const app = createApp(makeConfiguredCtx(fake.transport), { baseUrl: BASE, store });

    const res = await app.request('/api/v1/pleroma/statuses/500/subscribe', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(fake.introductions).toEqual([
      { invite: 'OPENPGP4FPR:BOB-INVITE', expectedAddr: BOB.address },
    ]);
    // The scoped request went to the freshly-introduced key-contact.
    const req = fake.dms.find((d) => parseEnv(d.text).type === 'invite-request');
    expect(req?.contactId).toBe(fake.keyReachable.get(BOB.address.toLowerCase()));
    expect(store.hasPendingThreadRequest(THREAD_ROOT_UUID)).toBe(true);
  });

  it('unreachable author, introduction fails: clean 422, no DM', async () => {
    const fake = makeFakeTransport();
    const rootMsg = bobRootMessage(500);
    rootMsg.text = JSON.stringify({ ...JSON.parse(rootMsg.text), invite: 'OPENPGP4FPR:DEAD' });
    fake.messages.push(rootMsg);
    fake.keyReachable.clear();
    fake.transport.introduceViaInvite = async () => null;
    const store = createStore(ephemeralStorePath());
    const app = createApp(makeConfiguredCtx(fake.transport), { baseUrl: BASE, store });

    const res = await app.request('/api/v1/pleroma/statuses/500/subscribe', { method: 'POST' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe('unreachable_author');
    expect(fake.dms.some((d) => parseEnv(d.text).type === 'invite-request')).toBe(false);
  });

  it('422 (own_thread) when the root is our own post', async () => {
    const fake = makeFakeTransport();
    // A SELF-authored root (fromId 1).
    fake.messages.push(
      makeMessage({ id: 501, text: JSON.stringify({ dn: 2, type: 'post', uuid: THREAD_ROOT_UUID, text: 'mine' }) }),
    );
    const app = createApp(makeConfiguredCtx(fake.transport), { baseUrl: BASE, store: createStore(ephemeralStorePath()) });
    const res = await app.request('/api/v1/pleroma/statuses/501/subscribe', { method: 'POST' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe('own_thread');
  });

  it('unsubscribes: leaves the channel + drops the subscription', async () => {
    const { app, store, fake } = setup();
    // Pretend we already joined the channel.
    store.addThreadSubscription(THREAD_ROOT_UUID, 424);
    const res = await app.request('/api/v1/pleroma/statuses/500/subscribe', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(fake.leftChats).toContain(424);
    expect(store.isSubscribedToThread(THREAD_ROOT_UUID)).toBe(false);
    const status = (await res.json()) as any;
    expect(status.pleroma.deltanet.thread_subscribed).toBe(false);
  });

  it('the root status carries thread_subscribed once subscribed', async () => {
    const { app, store } = setup();
    store.addThreadSubscription(THREAD_ROOT_UUID, 424);
    const res = await app.request('/api/v1/statuses/500');
    const status = (await res.json()) as any;
    expect(status.pleroma.deltanet.thread_subscribed).toBe(true);
  });

  it('a non-existent status id 404s', async () => {
    const { app } = setup();
    const res = await app.request('/api/v1/pleroma/statuses/99999/subscribe', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('thread channels are excluded from following()/home timeline', () => {
  it('a thread-subscription chat does not appear in the following list', async () => {
    const fake = makeFakeTransport();
    // Add a thread-channel InBroadcast to the transport's following list.
    fake.following.push({ contactId: 77, chatId: 300, name: 'Thread abc', addr: 'host@x' });
    const store = createStore(ephemeralStorePath());
    store.addThreadSubscription('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 300);
    const app = createApp(makeConfiguredCtx(fake.transport), { baseUrl: BASE, store });
    // The relationships endpoint reads followedFeeds — 77 must NOT be "following".
    const res = await app.request('/api/v1/accounts/relationships?id[]=77');
    const rels = (await res.json()) as any[];
    expect(rels[0].following).toBe(false);
  });

  it('messages from a subscribed thread channel are filtered out of the home timeline', async () => {
    const fake = makeFakeTransport();
    // A message arriving on the thread channel chat (chatId 300).
    fake.messages.push(makeMessage({ id: 600, chatId: 300, text: 'republished thread reply' }));
    const store = createStore(ephemeralStorePath());
    store.addThreadSubscription('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 300);
    const app = createApp(makeConfiguredCtx(fake.transport), { baseUrl: BASE, store });
    const home = (await (await app.request('/api/v1/timelines/home')).json()) as any[];
    expect(home.some((s) => s.content.includes('republished thread reply'))).toBe(false);
  });
});

describe('embed-only interactions (orig-<uuid> action targets)', () => {
  const HELD_UUID = 'dddddddd-1111-4222-8333-444444444444';
  const AUTHOR = 'stranger@relay.example';

  const setupHeld = async (opts: { invite?: string; tamper?: boolean } = {}) => {
    const h = makeFakeTransport();
    const store = createStore(ephemeralStorePath());
    const { buildPostObject } = await import('../src/envelope.js');
    const { openAttestor } = await import('../src/attest.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const attestor = openAttestor(join(mkdtempSync(join(tmpdir(), 'held-key-')), 'k.json'));
    const env = {
      ...buildPostObject('a stranger post', HELD_UUID),
      ...(opts.invite ? { invite: opts.invite } : {}),
    };
    const signed = { ...env, ...attestor.sign(env, AUTHOR) };
    const stored = opts.tamper ? { ...signed, text: 'tampered' } : signed;
    store.addHeldEnvelope(stored, BOB.address, 11, AUTHOR, 1);
    const app = createApp(makeConfiguredCtx(h.transport), { baseUrl: BASE, store });
    return { ...h, store, app };
  };
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it('favourite on a held post: local uuid tally + introduced author DM', async () => {
    const h = await setupHeld({ invite: 'OPENPGP4FPR:STRANGER-INVITE' });
    const res = await h.app.request(`/api/v1/statuses/orig-${HELD_UUID}/favourite`, { method: 'POST' });
    expect(res.status).toBe(200);
    const status = (await res.json()) as any;
    expect(status.favourited).toBe(true);
    expect(status.favourites_count).toBe(1);
    await flush();
    expect(h.introductions).toEqual([{ invite: 'OPENPGP4FPR:STRANGER-INVITE', expectedAddr: AUTHOR }]);
    const dm = h.dms.find((d) => JSON.parse(d.text).type === 'react');
    expect(dm, 'react control DM delivered to the introduced author').toBeDefined();
    expect(JSON.parse(dm!.text).ref).toEqual({ u: HELD_UUID, addr: AUTHOR });
  });

  it('reply to a held post: uuid ref + root + author DM copy', async () => {
    const h = await setupHeld({ invite: 'OPENPGP4FPR:STRANGER-INVITE' });
    const res = await h.app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'replying to a stranger', in_reply_to_id: `orig-${HELD_UUID}` }),
    });
    expect(res.status).toBe(200);
    const env = JSON.parse(h.posts.at(-1)!.text);
    expect(env.type).toBe('reply');
    expect(env.ref).toEqual({ u: HELD_UUID, addr: AUTHOR });
    // The held parent is a non-reply post -> it IS the thread root.
    expect(env.root).toEqual({ u: HELD_UUID, addr: AUTHOR });
    await flush();
    expect(h.introductions).toHaveLength(1);
    expect(h.dms.some((d) => d.text === h.posts.at(-1)!.text), 'byte-identical DM copy to the author').toBe(true);
  });

  it('reblog of a held post re-embeds the SAME signed envelope verbatim; unreblog retracts', async () => {
    const h = await setupHeld();
    const res = await h.app.request(`/api/v1/statuses/orig-${HELD_UUID}/reblog`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).reblogged).toBe(true);
    const boost = JSON.parse(h.posts.at(-1)!.text);
    expect(boost.type).toBe('boost');
    expect(boost.orig).toEqual(h.store.heldEnvelope(HELD_UUID)!.env); // verbatim
    const unres = await h.app.request(`/api/v1/statuses/orig-${HELD_UUID}/unreblog`, { method: 'POST' });
    expect(unres.status).toBe(200);
    expect(((await unres.json()) as any).reblogged).toBe(false);
  });

  it('never acts on an unverifiable held envelope (404, nothing sent)', async () => {
    const h = await setupHeld({ tamper: true, invite: 'OPENPGP4FPR:X' });
    const res = await h.app.request(`/api/v1/statuses/orig-${HELD_UUID}/favourite`, { method: 'POST' });
    expect(res.status).toBe(404);
    await flush();
    expect(h.introductions).toEqual([]);
    expect(h.dms).toEqual([]);
  });
});

// --- backup & restore (see meta/issues/backup-second-device.md) -------------

describe('backup endpoints', () => {
  const dnbkTmpDirs: string[] = [];
  const scratchDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'deltanet-backup-test-'));
    dnbkTmpDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dnbkTmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('401s unconfigured on both backup info and export', async () => {
    const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });
    expect((await app.request('/api/deltanet/backup')).status).toBe(401);
    const res = await app.request('/api/deltanet/backup/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: 'pw' }),
    });
    expect(res.status).toBe(401);
  });

  it('422s an export without a passphrase', async () => {
    const res = await makeApp().request('/api/deltanet/backup/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: '' }),
    });
    expect(res.status).toBe(422);
  });

  it('exports a decodable .dnbk carrying core tar + sidecar, and stamps last_backup_at', async () => {
    const dir = scratchDir();
    const store = createStore(join(dir, 'deltanet-store.json'));
    store.markRepublished('seed-uuid-for-backup');
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE, store, dataDir: dir });

    // Sign once so the attestation key file exists (it is created lazily).
    const postRes = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pre-backup post' }),
    });
    expect(postRes.status).toBe(200);

    const before = (await (await app.request('/api/deltanet/backup')).json()) as any;
    expect(before.last_backup_at).toBeNull();

    const res = await app.request('/api/deltanet/backup/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: 'hunter2' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="deltanet-backup-.*\.dnbk"$/);

    const { sidecar, coreTar } = decodeBackupContainer(Buffer.from(await res.arrayBuffer()), 'hunter2');
    expect(Buffer.compare(coreTar, FAKE_CORE_TAR)).toBe(0);
    expect(sidecar.addr).toBe('p6yalimhl@nine.testrun.org');
    expect(sidecar.store).toContain('seed-uuid-for-backup');
    expect(sidecar.signingKey).toContain('privatePem');

    const after = (await (await app.request('/api/deltanet/backup')).json()) as any;
    expect(typeof after.last_backup_at).toBe('number');
  });

  it('409s a restore when already configured', async () => {
    const res = await makeApp().request('/api/deltanet/restore', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('501s a restore when the context does not support it', async () => {
    const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });
    const fd = new FormData();
    fd.append('file', new File([Buffer.from('x')], 'b.dnbk'));
    fd.append('passphrase', 'pw');
    const res = await app.request('/api/deltanet/restore', { method: 'POST', body: fd });
    expect(res.status).toBe(501);
  });

  it('422s a garbage container / wrong passphrase without touching state', async () => {
    const dir = scratchDir();
    const store = createStore(join(dir, 'deltanet-store.json'));
    let restoreCalled = false;
    const ctx: AppContext = {
      getTransport: () => null,
      signup: async () => {
        throw new Error('unused');
      },
      restore: async () => {
        restoreCalled = true;
        throw new Error('unused');
      },
    };
    const app = createApp(ctx, { baseUrl: BASE, store, dataDir: dir });

    const post = async (bytes: Buffer, passphrase: string) => {
      const fd = new FormData();
      fd.append('file', new File([new Uint8Array(bytes)], 'b.dnbk'));
      fd.append('passphrase', passphrase);
      return app.request('/api/deltanet/restore', { method: 'POST', body: fd });
    };

    expect((await post(Buffer.from('not a backup'), 'pw')).status).toBe(422);
    const valid = encodeBackupContainer(
      { sidecar: { addr: 'a@b.c', exportedAt: 1 }, coreTar: FAKE_CORE_TAR },
      'right',
    );
    expect((await post(valid, 'wrong')).status).toBe(422);
    expect(restoreCalled).toBe(false);
    expect(existsSync(join(dir, 'deltanet-signing-key.json'))).toBe(false);
  });

  it('422s when the file or passphrase is missing', async () => {
    const dir = scratchDir();
    const ctx: AppContext = {
      getTransport: () => null,
      signup: async () => {
        throw new Error('unused');
      },
      restore: async () => {
        throw new Error('unused');
      },
    };
    const app = createApp(ctx, { baseUrl: BASE, dataDir: dir });
    const fd = new FormData();
    fd.append('passphrase', 'pw');
    expect((await app.request('/api/deltanet/restore', { method: 'POST', body: fd })).status).toBe(422);
    const fd2 = new FormData();
    fd2.append('file', new File([Buffer.from('x')], 'b.dnbk'));
    expect((await app.request('/api/deltanet/restore', { method: 'POST', body: fd2 })).status).toBe(422);
  });

  it('restores sidecar files + core tar, reloads live state, and signs with the restored key', async () => {
    // Donor: a signing key + a store with observable non-derivable state.
    const donorDir = scratchDir();
    const donorAttestor = openAttestor(join(donorDir, 'deltanet-signing-key.json'));
    const donorPub = donorAttestor.publicKeyBase64();
    const donorStore = createStore(join(donorDir, 'deltanet-store.json'));
    donorStore.markRepublished('donor-uuid');
    const container = encodeBackupContainer(
      {
        sidecar: {
          addr: 'p6yalimhl@nine.testrun.org',
          exportedAt: 123,
          signingKey: readFileSync(join(donorDir, 'deltanet-signing-key.json'), 'utf8'),
          store: readFileSync(join(donorDir, 'deltanet-store.json'), 'utf8'),
        },
        coreTar: FAKE_CORE_TAR,
      },
      'hunter2',
    );

    // Target: a fresh unconfigured node whose restore() hands back the fake transport.
    const dir = scratchDir();
    const store = createStore(join(dir, 'deltanet-store.json'));
    const { transport, posts } = makeFakeTransport();
    let restoredTarBytes: Buffer | null = null;
    let restoredPassphrase: string | null = null;
    let live: Transport | null = null;
    const ctx: AppContext = {
      getTransport: () => live,
      signup: async () => {
        throw new Error('unused');
      },
      restore: async (tarPath, passphrase, beforeOpen) => {
        restoredTarBytes = readFileSync(tarPath);
        restoredPassphrase = passphrase;
        // Mirror restoreTransport: the sidecar-writing hook runs after the
        // core import succeeded, before the transport goes live.
        beforeOpen();
        live = transport;
        return transport;
      },
    };
    const app = createApp(ctx, { baseUrl: BASE, store, dataDir: dir });

    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(container)], 'backup.dnbk'));
    fd.append('passphrase', 'hunter2');
    const res = await app.request('/api/deltanet/restore', { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.account.acct).toBe('p6yalimhl@nine.testrun.org');

    // The core tar reached ctx.restore byte-identical, with the passphrase.
    expect(restoredTarBytes && Buffer.compare(restoredTarBytes, FAKE_CORE_TAR)).toBe(0);
    expect(restoredPassphrase).toBe('hunter2');

    // Sidecar files landed in the data dir and the LIVE store sees them (reload).
    expect(readFileSync(join(dir, 'deltanet-store.json'), 'utf8')).toContain('donor-uuid');
    expect(store.wasRepublished('donor-uuid')).toBe(true);

    // The attestor now signs with the RESTORED key — followers' TOFU pins hold.
    const postRes = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'post-restore post' }),
    });
    expect(postRes.status).toBe(200);
    const envelope = parseEnvelope(posts[posts.length - 1]!.text);
    expect(envelope?.pubkey).toBe(donorPub);
  });
});

// --- petnames (see meta/issues/petnames.md) ---------------------------------

describe('POST /api/deltanet/contacts/:id/petname', () => {
  const post = (app: ReturnType<typeof createApp>, id: string, petname: string) =>
    app.request(`/api/deltanet/contacts/${id}/petname`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ petname }),
    });

  it('401s when unconfigured', async () => {
    const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });
    expect((await post(app, '11', 'carol')).status).toBe(401);
  });

  it('404s an unknown contact', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    expect((await post(app, '77', 'carol')).status).toBe(404);
    expect((await post(app, 'not-a-number', 'carol')).status).toBe(404);
  });

  it('422s a petname for SELF', async () => {
    const { transport, setNames } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    expect((await post(app, '1', 'me')).status).toBe(422);
    expect(setNames).toEqual([]);
  });

  it('sets a petname and returns the updated account', async () => {
    const { transport, setNames } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    const res = await post(app, '11', '  bobby  ');
    expect(res.status).toBe(200);
    const account = (await res.json()) as any;
    expect(setNames).toEqual([{ contactId: 11, name: 'bobby' }]);
    expect(account.display_name).toBe('bobby');
    expect(account.pleroma.deltanet).toEqual({ auth_name: 'bob', petname: 'bobby' });
  });

  it('clears the petname with an empty string, reverting to the auth name', async () => {
    const { transport, setNames } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    await post(app, '11', 'bobby');
    const res = await post(app, '11', '');
    expect(res.status).toBe(200);
    const account = (await res.json()) as any;
    expect(setNames).toEqual([
      { contactId: 11, name: 'bobby' },
      { contactId: 11, name: '' },
    ]);
    expect(account.display_name).toBe('bob');
    expect(account.pleroma.deltanet).toEqual({ auth_name: 'bob' });
  });
});

// --- mention autocomplete + addressing (meta/issues/mention-addressing-autocomplete.md)

describe('GET /api/v1/accounts/search', () => {
  it('401s when unconfigured', async () => {
    const app = createApp(makeUnconfiguredCtx(), { baseUrl: BASE });
    expect((await app.request('/api/v1/accounts/search?q=car')).status).toBe(401);
  });

  it('returns ranked known contacts (petname first), never SELF', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    // Give bob a petname so the petname-rank path is exercised end to end.
    await app.request('/api/deltanet/contacts/11/petname', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ petname: 'bobcat' }),
    });
    const res = await app.request('/api/v1/accounts/search?q=bob');
    expect(res.status).toBe(200);
    const accounts = (await res.json()) as any[];
    expect(accounts.length).toBe(1);
    expect(accounts[0].id).toBe('11');
    expect(accounts[0].display_name).toBe('bobcat');
    expect(accounts[0].pleroma.deltanet).toEqual({ auth_name: 'bob', petname: 'bobcat' });
  });

  it('returns [] for a blank query and respects the limit', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    expect(await (await app.request('/api/v1/accounts/search?q=')).json()).toEqual([]);
    const limited = (await (await app.request('/api/v1/accounts/search?q=b&limit=0')).json()) as any[];
    expect(limited).toEqual([]);
  });
});

describe('mention addressing on POST /api/v1/statuses', () => {
  it('DM-copies the same signed envelope to a mentioned key-contact', async () => {
    const { transport, dms, posts } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: `hey @${BOB.address} look` }),
    });
    expect(res.status).toBe(200);
    expect(dms).toHaveLength(1);
    expect(dms[0]!.contactId).toBe(11);
    // Verbatim copy of the posted wire text (same signed envelope).
    expect(dms[0]!.text).toBe(posts[0]!.text);
  });

  it('skips unknown addresses and never DMs itself', async () => {
    const { transport, dms } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cc @stranger@nowhere.example and @p6yalimhl@nine.testrun.org' }),
    });
    expect(res.status).toBe(200);
    expect(dms).toHaveLength(0);
  });

  it('does not double-DM the reply parent when the reply also mentions them', async () => {
    const { transport, dms } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    // Message 12 is authored by BOB in the fake timeline.
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: `agreed @${BOB.address}`, in_reply_to_id: '12' }),
    });
    expect(res.status).toBe(200);
    // Exactly ONE DM to bob: the reply copy. No extra mention copy.
    const bobDms = dms.filter((dm) => dm.contactId === 11);
    expect(bobDms).toHaveLength(1);
  });
});

describe('body mentions on status JSON', () => {
  it('resolves @addr body tokens to mention entries with names', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: `hey @${BOB.address}!` }),
    });
    expect(res.status).toBe(200);
    const status = (await res.json()) as any;
    expect(status.mentions).toEqual([
      {
        id: '11',
        username: 'zbie604yz',
        acct: BOB.address,
        url: `${BASE}/deltanet/contact/11`,
        display_name: 'bob',
        auth_name: 'bob',
      },
    ]);
  });

  it('does not duplicate the reply parent in mentions', async () => {
    const { transport } = makeFakeTransport();
    const app = createApp(makeConfiguredCtx(transport), { baseUrl: BASE });
    // Message 12 is authored by BOB; mentioning him in the reply body too
    // must yield ONE mention entry.
    const res = await app.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: `right @${BOB.address}?`, in_reply_to_id: '12' }),
    });
    expect(res.status).toBe(200);
    const status = (await res.json()) as any;
    expect(status.mentions.filter((m: any) => m.acct === BOB.address)).toHaveLength(1);
  });
});
