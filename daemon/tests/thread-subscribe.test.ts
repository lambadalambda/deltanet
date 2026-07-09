import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import { openAttestor } from '../src/attest.js';
import {
  buildPostObject,
  buildReplyObject,
  buildThreadInviteGrantEnvelope,
  buildThreadInviteRequestEnvelope,
  buildEnvelopeBundle,
  parseEnvelope,
  serializeEnvelope,
  type Envelope,
  type EnvelopeRef,
} from '../src/envelope.js';
import { createBackfiller, type Backfiller } from '../src/backfill.js';
import { createStore, type Store } from '../src/store.js';
import { collectThreadUuids } from '../src/thread-collect.js';
import {
  handleThreadChannelBundle,
  handleThreadInviteGrant,
  handleThreadInviteRequest,
  republishReplyToThread,
} from '../src/thread-subscribe.js';
import type { Transport } from '../src/transport/types.js';
import { makeContact, makeMessage } from './entities.test.js';

const ALICE = 'alice@x'; // root author (host)
const BOB = 'bob@x'; // subscriber
const ROOT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const REPLY1 = 'cccccccc-dddd-4eee-8fff-000000000001';
const REPLY2 = 'cccccccc-dddd-4eee-8fff-000000000002';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deltanet-thread-sub-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const attestorFor = (name: string) => openAttestor(join(dir, `${name}-key.json`));
const sign = (env: Envelope, addr: string): Envelope => ({ ...env, ...attestorFor(addr).sign(env, addr) });

const rootRef = (): EnvelopeRef => ({ u: ROOT, addr: ALICE });

/** A minimal fake transport recording the effects thread-subscribe drives. */
const fakeTransport = (over: Partial<Transport> = {}) => {
  const sentDms: Array<{ contactId: number; text: string }> = [];
  const channelPosts: Array<{ chatId: number; text: string }> = [];
  let nextChatId = 500;
  const created: Array<{ chatId: number; name: string }> = [];
  const joined: string[] = [];
  const messages = new Map<number, T.Message>();
  const transport = {
    createBroadcast: async (name: string) => {
      const id = nextChatId++;
      created.push({ chatId: id, name });
      return id;
    },
    chatInvite: async (chatId: number) => `OPENPGP4FPR:CHAT${chatId}`,
    sendControlDm: async (contactId: number, text: string) => {
      sentDms.push({ contactId, text });
    },
    postToChat: async (chatId: number, text: string) => {
      channelPosts.push({ chatId, text });
      return makeMessage({ id: 9000 + channelPosts.length, text });
    },
    message: async (id: number) => messages.get(id) ?? null,
    follow: async (link: string) => {
      joined.push(link);
      return nextChatId++;
    },
    ...over,
  } as unknown as Transport;
  return { transport, sentDms, channelPosts, created, joined, messages };
};

describe('collectThreadUuids', () => {
  it('collects root + local + held descendants (uuid keys only)', () => {
    const store = createStore(join(dir, 's.json'));
    // Root (local), reply1 (local reply to root), reply2 (held reply to reply1).
    store.ingestMessage(
      makeMessage({ id: 1, text: serializeEnvelope(buildPostObject('root', ROOT)) }),
      'm1@x',
      true,
    );
    store.ingestMessage(
      makeMessage({ id: 2, text: serializeEnvelope(buildReplyObject('r1', REPLY1, rootRef())) }),
      'm2@x',
      true,
    );
    store.addHeldEnvelope(
      sign(buildReplyObject('r2', REPLY2, { u: REPLY1, addr: BOB }, undefined, rootRef()), BOB),
      BOB,
      22,
      BOB,
      1,
    );
    const uuids = collectThreadUuids(store, ROOT);
    expect(uuids).toContain(ROOT);
    expect(uuids).toContain(REPLY1);
    expect(uuids).toContain(REPLY2);
    expect(uuids[0]).toBe(ROOT);
  });
});

describe('HOST: handleThreadInviteRequest', () => {
  const setupHost = (): Store => {
    const store = createStore(join(dir, 'host.json'));
    // Alice hosts: she holds the root + a reply as LOCAL signed messages.
    store.ingestMessage(
      makeMessage({ id: 1, text: serializeEnvelope(sign(buildPostObject('root', ROOT), ALICE)) }),
      'm1@x',
      true,
    );
    store.ingestMessage(
      makeMessage({
        id: 2,
        text: serializeEnvelope(sign(buildReplyObject('r1', REPLY1, rootRef()), BOB)),
      }),
      'm2@x',
      true,
    );
    return store;
  };

  const requestMsg = () =>
    makeMessage({
      id: 50,
      fromId: 22,
      sender: makeContact({ id: 22, address: BOB }),
      text: buildThreadInviteRequestEnvelope(ROOT),
    });

  it('lazily creates a channel, auto-grants (scoped grant) + sends the thread-so-far bundle', async () => {
    const store = setupHost();
    const { transport, sentDms, created } = fakeTransport({
      message: async (id: number) =>
        id === 1
          ? makeMessage({ id: 1, text: serializeEnvelope(sign(buildPostObject('root', ROOT), ALICE)) })
          : id === 2
            ? makeMessage({ id: 2, text: serializeEnvelope(sign(buildReplyObject('r1', REPLY1, rootRef()), BOB)) })
            : null,
    });
    const handled = await handleThreadInviteRequest(store, transport, requestMsg(), false);
    expect(handled).toBe(true);
    // Channel created + bound.
    expect(created).toHaveLength(1);
    expect(store.hostedThreadChatId(ROOT)).toBe(created[0]!.chatId);
    // A scoped grant DM went back to the requester (contact 22).
    const grant = sentDms.find((d) => parseEnvelope(d.text)?.type === 'invite-grant');
    expect(grant?.contactId).toBe(22);
    expect(parseEnvelope(grant!.text)?.scope?.thread).toBe(`u:${ROOT}`);
    // A thread-so-far bundle DM (envelope-bundle) also went back, carrying the
    // signed root + reply verbatim.
    const bundleDm = sentDms.find((d) => parseEnvelope(d.text)?.type === 'envelope-bundle');
    expect(bundleDm?.contactId).toBe(22);
    const uuids = (parseEnvelope(bundleDm!.text)!.envs ?? []).map((e) => e.uuid);
    expect(uuids).toContain(ROOT);
    expect(uuids).toContain(REPLY1);
  });

  it('reuses the existing channel on a second subscriber (no re-create)', async () => {
    const store = setupHost();
    const { transport, created } = fakeTransport({
      message: async (id: number) =>
        id === 1
          ? makeMessage({ id: 1, text: serializeEnvelope(sign(buildPostObject('root', ROOT), ALICE)) })
          : null,
    });
    await handleThreadInviteRequest(store, transport, requestMsg(), false);
    await handleThreadInviteRequest(store, transport, requestMsg(), false);
    expect(created).toHaveLength(1);
  });

  it('ignores a request for a thread whose root we do not hold', async () => {
    const store = createStore(join(dir, 'empty.json'));
    const { transport, created, sentDms } = fakeTransport();
    const handled = await handleThreadInviteRequest(store, transport, requestMsg(), false);
    // Consumed (it WAS a thread request) but no channel created, no grant sent.
    expect(handled).toBe(true);
    expect(created).toHaveLength(0);
    expect(sentDms).toHaveLength(0);
  });

  it('does not act on a feed-chat message or an unscoped request', async () => {
    const store = setupHost();
    const { transport, created } = fakeTransport();
    expect(await handleThreadInviteRequest(store, transport, requestMsg(), true)).toBe(false);
    const unscoped = makeMessage({ id: 51, fromId: 22, sender: makeContact({ id: 22, address: BOB }), text: JSON.stringify({ dn: 2, type: 'invite-request' }) });
    expect(await handleThreadInviteRequest(store, transport, unscoped, false)).toBe(false);
    expect(created).toHaveLength(0);
  });
});

describe('HOST: republishReplyToThread', () => {
  const hostedStore = (): Store => {
    const store = createStore(join(dir, 'rep.json'));
    store.addHostedThread(ROOT, 777);
    return store;
  };
  const replyMsg = (uuid: string, signer = BOB) =>
    makeMessage({
      id: 60,
      fromId: 22,
      sender: makeContact({ id: 22, address: signer }),
      text: serializeEnvelope(sign(buildReplyObject('deep', uuid, { u: REPLY1, addr: BOB }, undefined, rootRef()), signer)),
    });

  it('republishes a signed reply whose root is hosted, VERBATIM, into the channel', async () => {
    const store = hostedStore();
    const { transport, channelPosts } = fakeTransport();
    const msg = replyMsg(REPLY2);
    const posted = await republishReplyToThread(store, transport, msg, true);
    expect(posted).toBe(true);
    expect(channelPosts).toHaveLength(1);
    expect(channelPosts[0]!.chatId).toBe(777);
    // Verbatim: the bundle carries the reply's OWN signed envelope byte-for-byte.
    const bundle = parseEnvelope(channelPosts[0]!.text)!;
    expect(bundle.type).toBe('envelope-bundle');
    expect(bundle.envs).toHaveLength(1);
    expect(bundle.envs?.[0]).toEqual(parseEnvelope(msg.text));
    expect(bundle.envs?.[0]?.sig).toBeDefined();
  });

  it('dedupes: never republishes the same uuid twice', async () => {
    const store = hostedStore();
    const { transport, channelPosts } = fakeTransport();
    await republishReplyToThread(store, transport, replyMsg(REPLY2), true);
    await republishReplyToThread(store, transport, replyMsg(REPLY2), true); // second copy (feed+DM)
    expect(channelPosts).toHaveLength(1);
  });

  it('omits an unsigned reply (never fabricate) and a reply for a non-hosted thread', async () => {
    const store = hostedStore();
    const { transport, channelPosts } = fakeTransport();
    const unsigned = makeMessage({
      id: 61,
      fromId: 22,
      sender: makeContact({ id: 22, address: BOB }),
      text: serializeEnvelope(buildReplyObject('u', REPLY2, { u: REPLY1, addr: BOB }, undefined, rootRef())),
    });
    expect(await republishReplyToThread(store, transport, unsigned, true)).toBe(false);
    // A reply whose root is NOT hosted.
    const other = makeMessage({
      id: 62,
      fromId: 22,
      sender: makeContact({ id: 22, address: BOB }),
      text: serializeEnvelope(sign(buildReplyObject('x', REPLY2, { u: REPLY1, addr: BOB }, undefined, { u: 'other-root', addr: ALICE }), BOB)),
    });
    expect(await republishReplyToThread(store, transport, other, true)).toBe(false);
    expect(channelPosts).toHaveLength(0);
  });

  it('does not republish from a DM copy (feed-only)', async () => {
    const store = hostedStore();
    const { transport, channelPosts } = fakeTransport();
    await republishReplyToThread(store, transport, replyMsg(REPLY2), false);
    expect(channelPosts).toHaveLength(0);
  });

  it('does not republish a reply whose signature does not verify against the sender', async () => {
    // Defense in depth: the host must re-verify before broadcasting to
    // subscribers, so a signature/sender mismatch is never amplified into the
    // channel (nor does it burn the republish-dedupe slot for that uuid).
    const store = hostedStore();
    const { transport, channelPosts } = fakeTransport();
    // Signed by BOB but arriving with a sender address of ALICE → verify fails.
    const mismatched = makeMessage({
      id: 63,
      fromId: 22,
      sender: makeContact({ id: 22, address: ALICE }),
      text: serializeEnvelope(sign(buildReplyObject('deep', REPLY2, { u: REPLY1, addr: BOB }, undefined, rootRef()), BOB)),
    });
    expect(await republishReplyToThread(store, transport, mismatched, true)).toBe(false);
    expect(channelPosts).toHaveLength(0);
    // The uuid was NOT marked republished, so a later genuine copy still can.
    expect(store.wasRepublished(REPLY2)).toBe(false);
  });
});

describe('SUBSCRIBER: handleThreadInviteGrant', () => {
  const grantMsg = () =>
    makeMessage({
      id: 70,
      fromId: 33,
      sender: makeContact({ id: 33, address: ALICE }),
      text: buildThreadInviteGrantEnvelope(ROOT, 'OPENPGP4FPR:THREADLINK'),
    });

  it('joins a SOLICITED scoped grant + records it as a thread subscription (not a feed)', async () => {
    const store = createStore(join(dir, 'sub.json'));
    store.addPendingThreadRequest(ROOT, 1);
    const { transport, joined } = fakeTransport();
    const handled = await handleThreadInviteGrant(store, transport, grantMsg(), false);
    expect(handled).toBe(true);
    expect(joined).toEqual(['OPENPGP4FPR:THREADLINK']);
    const chatId = store.threadSubscriptionChatId(ROOT);
    expect(chatId).not.toBeNull();
    expect(store.isThreadSubscriptionChat(chatId!)).toBe(true);
    expect(store.hasPendingThreadRequest(ROOT)).toBe(false); // cleared
  });

  it('consumes but does NOT join an UNSOLICITED scoped grant', async () => {
    const store = createStore(join(dir, 'unsol.json'));
    const { transport, joined } = fakeTransport();
    const handled = await handleThreadInviteGrant(store, transport, grantMsg(), false);
    expect(handled).toBe(true); // consumed
    expect(joined).toHaveLength(0); // never joined
    expect(store.isSubscribedToThread(ROOT)).toBe(false);
  });

  it('ignores a feed-chat message or a non-thread grant', async () => {
    const store = createStore(join(dir, 'ign.json'));
    store.addPendingThreadRequest(ROOT, 1);
    const { transport } = fakeTransport();
    expect(await handleThreadInviteGrant(store, transport, grantMsg(), true)).toBe(false);
    const plain = makeMessage({ id: 71, fromId: 33, sender: makeContact({ id: 33, address: ALICE }), text: JSON.stringify({ dn: 2, type: 'invite-grant', link: 'OPENPGP4FPR:X' }) });
    expect(await handleThreadInviteGrant(store, transport, plain, false)).toBe(false);
  });
});

describe('SUBSCRIBER: handleThreadChannelBundle', () => {
  const bundleMsg = (chatId: number) => {
    const reply = sign(buildReplyObject('deep', REPLY2, { u: REPLY1, addr: ALICE }, undefined, rootRef()), ALICE);
    return makeMessage({
      id: 80,
      chatId,
      fromId: 33,
      sender: makeContact({ id: 33, address: ALICE }),
      text: buildEnvelopeBundle([reply]),
    });
  };
  const backfiller = (store: Store): Backfiller =>
    createBackfiller({ store, send: async () => {}, schedule: () => null, cancel: () => {} });

  it('admits a bundle from a SUBSCRIBED thread channel into held envelopes', () => {
    const store = createStore(join(dir, 'chan.json'));
    store.addThreadSubscription(ROOT, 424);
    const bf = backfiller(store);
    const handled = handleThreadChannelBundle(store, bf, bundleMsg(424), 1000);
    expect(handled).toBe(true);
    expect(store.heldEnvelope(REPLY2)).not.toBeNull();
  });

  it('does NOT admit a bundle from an unknown (non-subscribed) chat', () => {
    const store = createStore(join(dir, 'chan2.json'));
    const bf = backfiller(store);
    const handled = handleThreadChannelBundle(store, bf, bundleMsg(999), 1000);
    expect(handled).toBe(false);
    expect(store.heldEnvelope(REPLY2)).toBeNull();
  });

  it('self-echo is idempotent: a channel bundle never overwrites a LOCAL resolution', () => {
    const store = createStore(join(dir, 'echo.json'));
    store.addThreadSubscription(ROOT, 424);
    // The subscriber authored REPLY2 and holds it locally already.
    store.ingestMessage(
      makeMessage({ id: 5, text: serializeEnvelope(sign(buildReplyObject('mine', REPLY2, { u: REPLY1, addr: ALICE }, undefined, rootRef()), BOB)) }),
      'm5@x',
      true,
    );
    expect(store.resolveKey(REPLY2)).not.toBeNull();
    const bf = backfiller(store);
    handleThreadChannelBundle(store, bf, bundleMsg(424), 1000);
    // Held ingest refused to overwrite the local resolution — no held entry.
    expect(store.heldEnvelope(REPLY2)).toBeNull();
    expect(store.resolveKey(REPLY2)).not.toBeNull();
  });
});

describe('leak prevention: locked/private thread gating', () => {
  it('a private-marked reply is never republished into a thread channel', async () => {
    const store = createStore(join(dir, 'rep-priv.json'));
    store.addHostedThread(ROOT, 777);
    const { transport, channelPosts } = fakeTransport();
    const privReply = makeMessage({
      id: 62,
      fromId: 22,
      sender: makeContact({ id: 22, address: BOB }),
      text: serializeEnvelope(
        sign({ ...buildReplyObject('locked reply', REPLY2, { u: REPLY1, addr: BOB }, undefined, rootRef()), visibility: 'private' as const }, BOB),
      ),
    });
    expect(await republishReplyToThread(store, transport, privReply, true)).toBe(false);
    expect(channelPosts).toHaveLength(0);
  });

  it('a thread-invite request for a LOCKED root is refused (no grant, no channel)', async () => {
    const store = createStore(join(dir, 'host-priv.json'));
    store.ingestMessage(
      makeMessage({ id: 1, text: serializeEnvelope(sign({ ...buildPostObject('locked root', ROOT), visibility: 'private' as const }, ALICE)) }),
      'm1@x',
      true,
    );
    store.markLockedPost(ROOT);
    const { transport, sentDms, created } = fakeTransport();
    const handled = await handleThreadInviteRequest(
      store,
      transport,
      makeMessage({
        id: 50,
        fromId: 22,
        sender: makeContact({ id: 22, address: BOB }),
        text: buildThreadInviteRequestEnvelope(ROOT),
      }),
      false,
    );
    // Consumed (it WAS a thread request) but nothing granted or created.
    expect(handled).toBe(true);
    expect(sentDms).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(store.hostedThreadChatId(ROOT)).toBeNull();
  });
});
