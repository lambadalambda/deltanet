import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { UpgradeWebSocket, WSEvents } from 'hono/ws';
import type { T } from '@deltachat/jsonrpc-client';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthStore, type AuthStore } from '../src/auth.js';
import { createApp, type AppContext } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createStreamingHub } from '../src/streaming.js';
import type { Transport } from '../src/transport/types.js';

const BASE = 'http://localhost:4030';
const TRUSTED = 'http://localhost:5173';
const REDIRECT = `${TRUSTED}/auth/callback`;
const dirs: string[] = [];

const makeContact = (over: Partial<T.Contact> = {}): T.Contact => ({
  address: 'self@example.org',
  color: '#ff0000',
  authName: 'Self',
  status: '',
  displayName: 'Self',
  id: 1,
  name: 'Self',
  profileImage: null,
  nameAndAddr: 'Self (self@example.org)',
  isBlocked: false,
  isKeyContact: true,
  e2eeAvail: true,
  isVerified: false,
  verifierId: null,
  lastSeen: 0,
  wasSeenRecently: false,
  isBot: false,
  isProfileVerified: false,
  ...over,
}) as T.Contact;

const makeMessage = (over: Partial<T.Message> = {}): T.Message => ({
  id: 42,
  chatId: 12,
  fromId: 1,
  quote: null,
  parentId: null,
  text: 'hello',
  isEdited: false,
  hasLocation: false,
  hasHtml: false,
  viewType: 'Text',
  state: 26,
  error: null,
  timestamp: 1751800000,
  sortTimestamp: 1751800000,
  receivedTimestamp: 1751800000,
  hasDeviatingTimestamp: false,
  subject: '',
  showPadlock: true,
  isInfo: false,
  isForwarded: false,
  isBot: false,
  systemMessageType: 'Unknown',
  infoContactId: null,
  duration: 0,
  dimensionsHeight: 0,
  dimensionsWidth: 0,
  overrideSenderName: null,
  sender: makeContact(),
  file: null,
  fileMime: null,
  fileBytes: 0,
  fileName: null,
  webxdcInfo: null,
  downloadState: 'Done',
  reactions: null,
  vcardContact: null,
  originalMsgId: null,
  savedMessageId: null,
  isSetupmessage: false,
  setupCodeBegin: null,
  videochatType: null,
  videochatUrl: null,
  ...over,
}) as T.Message;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = (onEnrollmentCode?: (enrollment: { code: string; expiresAt: number }) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'deltanet-security-test-'));
  dirs.push(dir);
  const publicBlob = join(dir, 'public.png');
  const privateBlob = join(dir, 'private.png');
  const hiddenAvatar = join(dir, 'hidden.png');
  writeFileSync(publicBlob, 'public-bytes');
  writeFileSync(privateBlob, 'private-bytes');
  writeFileSync(hiddenAvatar, 'hidden-avatar');

  const self = makeContact();
  const bob = makeContact({ id: 11, address: 'bob@example.org', displayName: 'My private petname', authName: 'Bob Public', name: 'My private petname' });
  const publicMessage = makeMessage({ id: 10, fromId: 11, sender: bob, text: 'public post', file: publicBlob, fileMime: 'image/png', viewType: 'Image' });
  const privateMessage = makeMessage({
    id: 11,
    fromId: 11,
    sender: bob,
    text: JSON.stringify({ dn: 2, type: 'post', uuid: '11111111-1111-4111-8111-111111111111', text: 'private post', visibility: 'private' }),
    file: privateBlob,
    fileMime: 'image/png',
    viewType: 'Image',
  });
  const directMessage = makeMessage({
    id: 12,
    fromId: 11,
    sender: bob,
    text: JSON.stringify({ dn: 2, type: 'post', uuid: '22222222-2222-4222-8222-222222222222', text: 'direct post', visibility: 'direct' }),
  });
  const restrictedBoost = makeMessage({
    id: 13,
    fromId: 11,
    sender: bob,
    text: JSON.stringify({
      dn: 2,
      type: 'boost',
      uuid: '33333333-3333-4333-8333-333333333333',
      ref: { u: '11111111-1111-4111-8111-111111111111', addr: bob.address },
    }),
  });
  const malformedAttachment = makeMessage({ id: 14, text: '{"dn":', file: publicBlob, fileMime: 'image/png', viewType: 'Image' });
  const controlAttachment = makeMessage({
    id: 15,
    text: JSON.stringify({ dn: 2, type: 'react', emoji: 'x', ref: { u: 'target' } }),
    file: publicBlob,
    fileMime: 'image/png',
    viewType: 'Image',
  });
  const directAttachment = makeMessage({
    id: 16,
    fromId: 11,
    sender: bob,
    text: JSON.stringify({ dn: 2, type: 'post', uuid: '44444444-4444-4444-8444-444444444444', text: 'direct media', visibility: 'direct' }),
    file: privateBlob,
    fileMime: 'image/png',
    viewType: 'Image',
  });
  const messages = [publicMessage, privateMessage, directMessage, restrictedBoost, malformedAttachment, controlAttachment, directAttachment];

  const transport = {
    self: async () => self,
    stats: async () => ({ followers: 0, following: 1, statuses: 3 }),
    timeline: async () => messages.filter((message) => message.id <= 13),
    timelineFrom: async (contactId: number) => contactId === 11 ? messages.filter((message) => message.id <= 13) : [],
    message: async (id: number) => messages.find((message) => message.id === id) ?? null,
    messageMid: async (id: number) => `mid-${id}@example.org`,
    contact: async (id: number) => id === 1 ? self : id === 11 ? bob : id === 20 ? makeContact({ id: 20, address: 'hidden@example.org', displayName: 'Hidden' }) : null,
    contacts: async () => [self, bob],
    contactIdByAddr: async (addr: string) => addr === bob.address ? 11 : null,
    keyContactIdForAddr: async (addr: string) => addr === bob.address ? 11 : null,
    following: async () => [{ contactId: 11, chatId: 20, name: 'Bob', addr: bob.address }],
    avatarPath: async (id: number) => id === 20 ? hiddenAvatar : null,
    contactBadge: async (id: number) => id === 20 ? { initial: 'H', color: '#abcdef' } : { initial: 'B', color: '#123456' },
    blobPath: async (id: number) => [10, 14, 15].includes(id) ? publicBlob : [11, 16].includes(id) ? privateBlob : null,
  } as unknown as Transport;
  const ctx: AppContext = {
    getTransport: () => transport,
    signup: async () => transport,
  };
  const auth = createAuthStore(join(dir, 'auth.json'));
  const store = createStore(join(dir, 'store.json'));
  const app = createApp(ctx, {
    baseUrl: BASE,
    store,
    security: { auth, trustedOrigins: [TRUSTED], onEnrollmentCode },
  });
  return { app, auth, ctx, dir, store, transport };
};

const register = async (
  app: ReturnType<typeof createApp>,
  auth: AuthStore,
  proof: { enrollmentCode?: string; accessToken?: string } = { enrollmentCode: auth.createEnrollmentCode().code },
) => {
  const response = await app.request('/api/v1/apps', {
    method: 'POST',
    headers: {
      Origin: TRUSTED,
      ...(proof.accessToken ? { Authorization: `Bearer ${proof.accessToken}` } : {}),
    },
    body: new URLSearchParams({
      client_name: 'Headwater',
      redirect_uris: REDIRECT,
      scopes: 'read write follow push',
      ...(proof.enrollmentCode ? { enrollment_code: proof.enrollmentCode } : {}),
    }),
  });
  expect(response.status).toBe(200);
  return await response.json() as { client_id: string; client_secret: string; redirect_uri: string };
};

const authenticate = async (app: ReturnType<typeof createApp>, auth: AuthStore) => {
  const client = await register(app, auth);
  const authorize = new URL('/oauth/authorize', BASE);
  authorize.searchParams.set('client_id', client.client_id);
  authorize.searchParams.set('redirect_uri', client.redirect_uri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'read write follow push');
  authorize.searchParams.set('state', 'state-value');
  const authorization = await app.request(authorize.toString());
  expect(authorization.status).toBe(302);
  const code = new URL(authorization.headers.get('location')!).searchParams.get('code')!;
  const token = await app.request('/oauth/token', {
    method: 'POST',
    headers: { Origin: TRUSTED },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: client.redirect_uri,
      code,
    }),
  });
  expect(token.status).toBe(200);
  return { client, code, ...await token.json() as { access_token: string; scope: string } };
};

describe('fail-closed route matrix', () => {
  it.each([
    ['GET', '/api/deltanet/backup'],
    ['POST', '/api/deltanet/backup/export'],
    ['GET', '/api/v1/accounts/verify_credentials'],
    ['PATCH', '/api/v1/accounts/update_credentials'],
    ['POST', '/api/v1/accounts/11/remove_from_followers'],
    ['GET', '/api/v1/accounts/relationships'],
    ['GET', '/api/v1/accounts/lookup?acct=bob@example.org'],
    ['GET', '/api/v2/search?q=bob'],
    ['GET', '/api/v1/accounts/search?q=bob'],
    ['POST', '/api/v1/accounts/11/unfollow'],
    ['POST', '/api/v1/accounts/11/follow'],
    ['GET', '/api/v1/timelines/home'],
    ['GET', '/api/v1/notifications'],
    ['POST', '/api/deltanet/streaming/token'],
    ['POST', '/api/v1/media'],
    ['POST', '/api/v1/statuses/10/reblog'],
    ['POST', '/api/v1/statuses/10/unreblog'],
    ['POST', '/api/v1/statuses/10/favourite'],
    ['POST', '/api/v1/statuses/10/unfavourite'],
    ['PUT', '/api/v1/pleroma/statuses/10/reactions/%F0%9F%91%8D'],
    ['DELETE', '/api/v1/pleroma/statuses/10/reactions/%F0%9F%91%8D'],
    ['GET', '/api/v1/statuses/10/context'],
    ['POST', '/api/v1/pleroma/statuses/10/subscribe'],
    ['DELETE', '/api/v1/pleroma/statuses/10/subscribe'],
    ['GET', '/api/v1/statuses/10'],
    ['POST', '/api/v1/follow_requests/11/authorize'],
    ['POST', '/api/v1/follow_requests/11/reject'],
    ['POST', '/api/deltanet/contacts/11/request-locked'],
    ['POST', '/api/deltanet/contacts/11/petname'],
    ['GET', '/api/deltanet/invite'],
    ['GET', '/api/v1/bookmarks'],
    ['GET', '/api/v2/suggestions'],
    ['GET', '/api/v1/suggestions'],
    ['GET', '/api/v2/pleroma/chats'],
    ['GET', '/api/v1/filters'],
    ['GET', '/api/v1/follow_requests'],
    ['GET', '/api/v1/markers'],
    ['GET', '/api/v1/preferences'],
    ['POST', '/api/v1/statuses'],
    ['POST', '/api/deltanet/follow'],
    ['GET', '/api/not-yet-implemented-private-state'],
  ])('%s %s rejects a missing bearer', async (method, path) => {
    const { app } = fixture();
    expect((await app.request(path, { method })).status).toBe(401);
  });

  it.each(['', 'Basic abc', 'Bearer', 'Bearer deltanet-token', 'Bearer incorrect'])('rejects malformed or invalid Authorization %j', async (authorization) => {
    const { app } = fixture();
    const headers = authorization ? { Authorization: authorization } : undefined;
    expect((await app.request('/api/v1/accounts/verify_credentials', { headers })).status).toBe(401);
  });

  it('allows a real bearer to reach private REST routes', async () => {
    const { app, auth } = fixture();
    const { access_token } = await authenticate(app, auth);
    const response = await app.request('/api/v1/accounts/verify_credentials', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(response.status).toBe(200);
  });

  it.each([
    ['GET', '/api/v1/instance'],
    ['GET', '/api/v2/instance'],
    ['GET', '/api/deltanet/status'],
    ['GET', '/api/v1/timelines/public'],
    ['GET', '/api/v1/accounts/11'],
    ['GET', '/api/v1/accounts/11/statuses'],
    ['GET', '/deltanet/avatar/11'],
    ['GET', '/deltanet/header/11'],
    ['GET', '/api/v1/custom_emojis'],
    ['GET', '/api/v1/trends'],
  ])('%s %s is an explicit anonymous projection', async (method, path) => {
    const { app } = fixture();
    expect((await app.request(path, { method })).status).not.toBe(401);
  });
});

describe('onboarding configuration lock', () => {
  it('requires terminal enrollment proof before selecting an operator-approved custom relay', async () => {
    const base = fixture();
    let current: Transport | null = null;
    let selectedRelay: string | null = null;
    const ctx: AppContext = {
      getTransport: () => current,
      signup: async (_displayName, relay) => {
        selectedRelay = relay;
        current = base.transport;
        return current;
      },
    };
    const app = createApp(ctx, {
      baseUrl: BASE,
      security: { auth: base.auth, trustedOrigins: [TRUSTED] },
      signupRelays: ['https://127.0.0.1:8443'],
    });
    const request = (enrollmentCode?: string) => app.request('/api/deltanet/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: 'Alice',
        relay: 'https://127.0.0.1:8443/',
        ...(enrollmentCode ? { enrollment_code: enrollmentCode } : {}),
      }),
    });

    expect((await request()).status).toBe(403);
    expect((await request('incorrect')).status).toBe(403);
    expect(selectedRelay).toBeNull();
    const enrollment = base.auth.createEnrollmentCode();
    expect((await request(enrollment.code)).status).toBe(200);
    expect(selectedRelay).toBe('https://127.0.0.1:8443');
  });

  it('allows only one signup/restore configuration operation at a time', async () => {
    const base = fixture();
    let current: Transport | null = null;
    let releaseSignup!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseSignup = resolve; });
    const ctx: AppContext = {
      getTransport: () => current,
      signup: async () => {
        markStarted();
        await release;
        current = base.transport;
        return current;
      },
    };
    const app = createApp(ctx, {
      baseUrl: BASE,
      security: { auth: base.auth, trustedOrigins: [TRUSTED] },
    });
    const body = JSON.stringify({ display_name: 'Alice' });
    const first = app.request('/api/deltanet/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    await started;
    const second = await app.request('/api/deltanet/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'configuration already in progress' });
    releaseSignup();
    expect((await first).status).toBe(200);
  });
});

describe('OAuth security contract', () => {
  it('rejects client enrollment without a terminal code or existing bearer', async () => {
    const { app, auth } = fixture();
    const withoutProof = await app.request('/api/v1/apps', {
      method: 'POST',
      headers: { Origin: TRUSTED },
      body: new URLSearchParams({
        client_name: 'Headwater',
        redirect_uris: REDIRECT,
        scopes: 'read write follow push',
      }),
    });
    expect(withoutProof.status).toBe(403);

    const session = await authenticate(app, auth);
    const enrolled = await register(app, auth, { accessToken: session.access_token });
    expect(enrolled.client_id).toBeTypeOf('string');
  });

  it('requires the exact full local scope at registration', async () => {
    const { app, auth } = fixture();
    for (const scopes of ['read', 'read write follow', 'read write follow push admin']) {
      const enrollment = auth.createEnrollmentCode();
      const response = await app.request('/api/v1/apps', {
        method: 'POST',
        headers: { Origin: TRUSTED },
        body: new URLSearchParams({
          client_name: 'Headwater',
          redirect_uris: REDIRECT,
          scopes,
          enrollment_code: enrollment.code,
        }),
      });
      expect(response.status).toBe(422);
    }
  });

  it('rejects untrusted, fragmented, and multiple redirect registrations', async () => {
    const { app } = fixture();
    for (const redirect_uris of [
      'https://evil.example/callback',
      `${REDIRECT}#fragment`,
      `${REDIRECT} ${TRUSTED}/other`,
    ]) {
      const response = await app.request('/api/v1/apps', {
        method: 'POST',
        headers: { Origin: TRUSTED },
        body: new URLSearchParams({ client_name: 'Headwater', redirect_uris, scopes: 'read' }),
      });
      expect(response.status).toBe(422);
    }
  });

  it('returns randomized credentials/codes/tokens and rejects fixed legacy values', async () => {
    const { app, auth } = fixture();
    const first = await authenticate(app, auth);
    const second = await authenticate(app, auth);
    for (const value of [first.client.client_id, first.client.client_secret, first.code, first.access_token]) {
      expect(Buffer.from(value, 'base64url').byteLength).toBeGreaterThanOrEqual(32);
      expect(value).not.toMatch(/^deltanet-(code|token)$/);
    }
    expect(second.client.client_id).not.toBe(first.client.client_id);
    expect(second.client.client_secret).not.toBe(first.client.client_secret);
    expect(second.code).not.toBe(first.code);
    expect(second.access_token).not.toBe(first.access_token);
  });

  it('validates client, exact redirect, response_type, scope, secret, code binding, and code reuse', async () => {
    const { app, auth } = fixture();
    const client = await register(app, auth);
    const authorize = (overrides: Record<string, string> = {}) => {
      const values = {
        client_id: client.client_id,
        redirect_uri: client.redirect_uri,
        response_type: 'code',
        scope: 'read write follow push',
        ...overrides,
      };
      return app.request(`/oauth/authorize?${new URLSearchParams(values)}`);
    };
    expect((await authorize({ client_id: 'wrong' })).status).toBe(400);
    expect((await authorize({ redirect_uri: `${TRUSTED}/other` })).status).toBe(400);
    expect((await authorize({ response_type: 'token' })).status).toBe(400);
    expect((await authorize({ scope: 'admin' })).status).toBe(400);

    const approved = await authorize();
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const exchange = (overrides: Record<string, string> = {}) => app.request('/oauth/token', {
      method: 'POST',
      headers: { Origin: TRUSTED },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: client.redirect_uri,
        code,
        ...overrides,
      }),
    });
    expect((await exchange({ client_secret: 'wrong' })).status).toBe(401);
    expect((await exchange({ redirect_uri: `${TRUSTED}/other` })).status).toBe(400);
    const otherClient = await register(app, auth);
    expect((await exchange({
      client_id: otherClient.client_id,
      client_secret: otherClient.client_secret,
      redirect_uri: otherClient.redirect_uri,
    })).status).toBe(400);
    expect((await exchange()).status).toBe(200);
    expect((await exchange()).status).toBe(400);
  });

  it('marks OAuth app, authorization-code, and token responses as non-cacheable', async () => {
    const { app, auth } = fixture();
    const enrollment = auth.createEnrollmentCode();
    const appResponse = await app.request('/api/v1/apps', {
      method: 'POST',
      headers: { Origin: TRUSTED },
      body: new URLSearchParams({
        client_name: 'Headwater',
        redirect_uris: REDIRECT,
        scopes: 'read write follow push',
        enrollment_code: enrollment.code,
      }),
    });
    const client = await appResponse.json() as { client_id: string; client_secret: string; redirect_uri: string };
    const authorizeUrl = new URL('/oauth/authorize', BASE);
    authorizeUrl.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: client.redirect_uri,
      response_type: 'code',
      scope: 'read write follow push',
    }).toString();
    const authorizeResponse = await app.request(authorizeUrl);
    const code = new URL(authorizeResponse.headers.get('location')!).searchParams.get('code')!;
    const tokenResponse = await app.request('/oauth/token', {
      method: 'POST',
      headers: { Origin: TRUSTED },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: client.redirect_uri,
        code,
      }),
    });

    for (const response of [appResponse, authorizeResponse, tokenResponse]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');
    }
  });

  it('requires its bearer and unpairs the client so retained credentials and sessions are unusable', async () => {
    const enrollmentCodes: string[] = [];
    const { app, auth } = fixture((enrollment) => enrollmentCodes.push(enrollment.code));
    const authenticated = await authenticate(app, auth);
    const secondCode = auth.issueAuthorizationCode({
      clientId: authenticated.client.client_id,
      redirectUri: authenticated.client.redirect_uri,
      scope: 'read write follow push',
    });
    const secondSession = auth.exchangeAuthorizationCode({
      clientId: authenticated.client.client_id,
      clientSecret: authenticated.client.client_secret,
      redirectUri: authenticated.client.redirect_uri,
      code: secondCode,
    });
    const retainedCode = auth.issueAuthorizationCode({
      clientId: authenticated.client.client_id,
      redirectUri: authenticated.client.redirect_uri,
      scope: 'read write follow push',
    });
    expect((await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { Origin: TRUSTED },
      body: new URLSearchParams({ token: authenticated.access_token }),
    })).status).toBe(401);
    const revoke = await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { Origin: TRUSTED, Authorization: `Bearer ${authenticated.access_token}` },
      body: new URLSearchParams({ token: authenticated.access_token }),
    });
    expect(revoke.status).toBe(200);
    expect(enrollmentCodes).toHaveLength(1);
    expect(auth.validateAccessToken(authenticated.access_token)).toBeNull();
    expect(auth.validateAccessToken(secondSession.accessToken)).toBeNull();
    expect((await app.request('/api/v1/accounts/verify_credentials', {
      headers: { Authorization: `Bearer ${authenticated.access_token}` },
    })).status).toBe(401);
    const staleAuthorize = new URL('/oauth/authorize', BASE);
    staleAuthorize.search = new URLSearchParams({
      client_id: authenticated.client.client_id,
      redirect_uri: authenticated.client.redirect_uri,
      response_type: 'code',
      scope: 'read write follow push',
    }).toString();
    expect((await app.request(staleAuthorize)).status).toBe(400);
    expect((await app.request('/oauth/token', {
      method: 'POST',
      headers: { Origin: TRUSTED },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: authenticated.client.client_id,
        client_secret: authenticated.client.client_secret,
        redirect_uri: authenticated.client.redirect_uri,
        code: retainedCode,
      }),
    })).status).toBe(401);
  });
});

describe('trusted browser origins', () => {
  it('echoes trusted origins, never emits a wildcard, and varies by Origin', async () => {
    const { app, auth } = fixture();
    for (const origin of [new URL(BASE).origin, TRUSTED]) {
      const response = await app.request('/api/v2/instance', { headers: { Origin: origin } });
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
      expect(response.headers.get('vary')).toContain('Origin');
    }
  });

  it('omits CORS permission and rejects untrusted browser mutation, OAuth, and onboarding requests', async () => {
    const { app } = fixture();
    const origin = 'https://evil.example';
    const read = await app.request('/api/v2/instance', { headers: { Origin: origin } });
    expect(read.headers.get('access-control-allow-origin')).toBeNull();
    for (const [method, path] of [
      ['POST', '/api/v1/apps'],
      ['GET', '/oauth/authorize'],
      ['POST', '/oauth/token'],
      ['POST', '/api/deltanet/signup'],
      ['OPTIONS', '/api/v1/statuses'],
    ] as const) {
      expect((await app.request(path, { method, headers: { Origin: origin } })).status).toBe(403);
    }
  });

  it('sets trusted CORS headers even on early authentication failures', async () => {
    const { app } = fixture();
    const response = await app.request('/api/v1/notifications', { headers: { Origin: TRUSTED } });
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe(TRUSTED);
    expect(response.headers.get('vary')).toContain('Origin');
  });
});

describe('public projections and restricted blobs', () => {
  it('exposes only public statuses and strips local petnames/user action state anonymously', async () => {
    const { app } = fixture();
    for (const path of ['/api/v1/timelines/public', '/api/v1/accounts/11/statuses']) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const statuses = await response.json() as any[];
      expect(statuses.map((status) => status.content)).toEqual(['<p>public post</p>']);
      expect(statuses[0]).toMatchObject({
        visibility: 'public',
        reblog: null,
        in_reply_to_id: null,
        in_reply_to_account_id: null,
        favourites_count: 0,
        reblogs_count: 0,
        replies_count: 0,
        favourited: false,
        reblogged: false,
        mentions: [],
      });
      expect(statuses[0].account.display_name).toBe('Bob Public');
      expect(statuses[0].account.pleroma.relationship).toBeUndefined();
      expect(statuses[0].account.pleroma.headwater.petname).toBeUndefined();
      expect(statuses[0].account.pleroma.deltanet).toEqual(statuses[0].account.pleroma.headwater);
      expect(statuses[0].pleroma.headwater).toBeUndefined();
      expect(statuses[0].pleroma.deltanet).toBeUndefined();
    }
  });

  it('requires positive feed provenance for every local node in anonymous boost trees', async () => {
    const { app, store, transport } = fixture();
    const bob = makeContact({ id: 11, address: 'bob@example.org', authName: 'Bob Public' });
    const dmUuid = '55555555-5555-4555-8555-555555555555';
    const feedUuid = '66666666-6666-4666-8666-666666666666';
    const dmOnly = makeMessage({
      id: 100,
      chatId: 99,
      fromId: 11,
      sender: bob,
      text: JSON.stringify({ dn: 2, type: 'post', uuid: dmUuid, text: 'DM-only secret' }),
    });
    const smuggledBoost = makeMessage({
      id: 101,
      fromId: 11,
      sender: bob,
      text: JSON.stringify({ dn: 2, type: 'boost', uuid: '77777777-7777-4777-8777-777777777777', ref: { u: dmUuid, addr: bob.address } }),
    });
    const feedOriginal = makeMessage({
      id: 102,
      fromId: 11,
      sender: bob,
      text: JSON.stringify({ dn: 2, type: 'post', uuid: feedUuid, text: 'Feed-backed public post' }),
    });
    const feedBoost = makeMessage({
      id: 103,
      fromId: 11,
      sender: bob,
      text: JSON.stringify({ dn: 2, type: 'boost', uuid: '88888888-8888-4888-8888-888888888888', ref: { u: feedUuid, addr: bob.address } }),
    });
    const feedMessages = [smuggledBoost, feedOriginal, feedBoost];
    store.ingestMessage(dmOnly, 'dm-only@example.org', false);
    transport.timeline = async () => feedMessages;
    transport.timelineFrom = async () => feedMessages;
    transport.message = async (id: number) => [dmOnly, ...feedMessages].find((message) => message.id === id) ?? null;
    transport.messageMid = async (id: number) => `mid-${id}@example.org`;

    for (const path of ['/api/v1/timelines/public', '/api/v1/accounts/11/statuses']) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const statuses = await response.json() as any[];
      expect(JSON.stringify(statuses)).not.toContain('DM-only secret');
      expect(JSON.stringify(statuses)).not.toContain('[boosted post unavailable]');
      expect(statuses.some((status) => status.id === '103' && status.reblog?.content === '<p>Feed-backed public post</p>')).toBe(true);
      expect(statuses.some((status) => status.id === '101')).toBe(false);
    }
  });

  it('requires bearer or signed capability for every blob regardless of message shape', async () => {
    const { app, auth } = fixture();
    for (const msgId of [10, 11, 14, 15, 16, 999]) {
      const response = await app.request(`/deltanet/blob/${msgId}`);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }

    const { access_token } = await authenticate(app, auth);
    const bearerBlob = await app.request('/deltanet/blob/11', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(bearerBlob.status).toBe(200);
    expect(await bearerBlob.text()).toBe('private-bytes');
    expect(bearerBlob.headers.get('cache-control')).toBe('private, no-store');
    const arbitrary = auth.signBlobPath(14, 100);
    const signedArbitrary = await app.request(`/deltanet/blob/14?expires=${arbitrary.expires}&signature=${encodeURIComponent(arbitrary.signature)}`);
    expect(signedArbitrary.status).toBe(200);
    expect(signedArbitrary.headers.get('cache-control')).toBe('private, no-store');
    const timeline = await app.request('/api/v1/timelines/home', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const statuses = await timeline.json() as any[];
    const privateStatus = statuses.find((status) => status.content === '<p>private post</p>');
    const signedUrl = privateStatus!.media_attachments[0].url as string;
    expect(new URL(signedUrl).searchParams.get('signature')).toBeTruthy();
    expect(Number(new URL(signedUrl).searchParams.get('expires')) - Date.now()).toBeLessThanOrEqual(60_000);
    const signedBlob = await app.request(signedUrl);
    expect(signedBlob.status).toBe(200);
    expect(await signedBlob.text()).toBe('private-bytes');
    expect(signedBlob.headers.get('cache-control')).toBe('private, no-store');

    expect((await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}` },
      body: new URLSearchParams({ token: access_token }),
    })).status).toBe(200);
    const residualCapability = await app.request(signedUrl);
    expect(residualCapability.status).toBe(200);
    expect(residualCapability.headers.get('cache-control')).toBe('private, no-store');
  });

  it('returns a neutral anonymous avatar for contacts with no public profile', async () => {
    const { app, auth } = fixture();
    const anonymous = await app.request('/deltanet/avatar/20');
    expect(anonymous.status).toBe(200);
    expect(await anonymous.text()).toContain('>?<');

    const { access_token } = await authenticate(app, auth);
    const authenticated = await app.request('/deltanet/avatar/20', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(await authenticated.text()).toBe('hidden-avatar');
  });
});

describe('WebSocket authentication', () => {
  const fakeUpgrade = (opened: { count: number; closed: Array<[number?, string?]> }): UpgradeWebSocket =>
    ((createEvents: (c: Context) => WSEvents | Promise<WSEvents>) => async (c: Context) => {
      const events = await createEvents(c);
      const socket = {
        send: () => undefined,
        close: (code?: number, reason?: string) => opened.closed.push([code, reason]),
      };
      events.onOpen?.(new Event('open'), socket as any);
      opened.count += 1;
      return c.text('upgraded');
    }) as unknown as UpgradeWebSocket;

  it('requires a one-use REST-issued stream ticket and closes the socket on revocation', async () => {
    const { ctx, auth, dir } = fixture();
    const opened = { count: 0, closed: [] as Array<[number?, string?]> };
    const app = createApp(ctx, {
      baseUrl: BASE,
      store: createStore(join(dir, 'ws-store.json')),
      security: { auth, trustedOrigins: [TRUSTED] },
      upgradeWebSocket: fakeUpgrade(opened),
      hub: createStreamingHub(),
    });
    expect((await app.request('/api/v1/streaming?stream=user')).status).toBe(401);
    expect((await app.request('/api/v1/streaming?stream=user&access_token=deltanet-token')).status).toBe(401);
    expect(opened.count).toBe(0);

    const authenticated = await authenticate(app, auth);
    const secondCode = auth.issueAuthorizationCode({
      clientId: authenticated.client.client_id,
      redirectUri: authenticated.client.redirect_uri,
      scope: 'read write follow push',
    });
    const secondSession = auth.exchangeAuthorizationCode({
      clientId: authenticated.client.client_id,
      clientSecret: authenticated.client.client_secret,
      redirectUri: authenticated.client.redirect_uri,
      code: secondCode,
    });
    const issued = await app.request('/api/headwater/streaming/token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authenticated.access_token}` },
    });
    expect(issued.status).toBe(200);
    const { ticket } = await issued.json() as { ticket: string };
    expect((await app.request(`/api/v1/streaming?stream=user&ticket=${encodeURIComponent(ticket)}`, {
      headers: { Origin: 'https://evil.example' },
    })).status).toBe(403);
    expect(opened.count).toBe(0);
    expect((await app.request(`/api/v1/streaming?stream=user&ticket=${encodeURIComponent(ticket)}`)).status).toBe(200);
    expect(opened.count).toBe(1);
    expect((await app.request(`/api/v1/streaming?stream=user&ticket=${encodeURIComponent(ticket)}`)).status).toBe(401);

    const secondIssued = await app.request('/api/deltanet/streaming/token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secondSession.accessToken}` },
    });
    const secondTicket = (await secondIssued.json() as { ticket: string }).ticket;
    expect((await app.request(`/api/v1/streaming?stream=user&ticket=${encodeURIComponent(secondTicket)}`)).status).toBe(200);
    expect(opened.count).toBe(2);

    await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authenticated.access_token}` },
      body: new URLSearchParams({ token: authenticated.access_token }),
    });
    expect(opened.closed).toEqual([
      [4001, 'session revoked'],
      [4001, 'session revoked'],
    ]);
  });

  it('rejects expired stream tickets and closes an open socket when its session expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const base = fixture();
      const auth = createAuthStore(join(base.dir, 'expiring-auth.json'), {
        now: Date.now,
        streamTicketTtlMs: 100,
        sessionTtlMs: 1_000,
      });
      const opened = { count: 0, closed: [] as Array<[number?, string?]> };
      const app = createApp(base.ctx, {
        baseUrl: BASE,
        security: { auth, trustedOrigins: [TRUSTED] },
        upgradeWebSocket: fakeUpgrade(opened),
        hub: createStreamingHub(),
      });
      const { access_token } = await authenticate(app, auth);
      const expiredResponse = await app.request('/api/deltanet/streaming/token', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const expired = await expiredResponse.json() as { ticket: string };
      vi.advanceTimersByTime(101);
      expect((await app.request(`/api/v1/streaming?ticket=${encodeURIComponent(expired.ticket)}`)).status).toBe(401);

      const freshResponse = await app.request('/api/deltanet/streaming/token', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const fresh = await freshResponse.json() as { ticket: string };
      expect((await app.request(`/api/v1/streaming?ticket=${encodeURIComponent(fresh.ticket)}`)).status).toBe(200);
      vi.advanceTimersByTime(900);
      expect(opened.closed).toContainEqual([4001, 'session expired']);
    } finally {
      vi.useRealTimers();
    }
  });
});
