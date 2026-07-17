import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import { createStore, type Store } from '../src/store.js';
import { createUnsafeTestApp, type AppContext } from '../src/server.js';
import { openAttestor } from '../src/attest.js';
import {
  buildPostObject,
  buildReplyObject,
  parseEnvelope,
  serializeEnvelope,
  type Envelope,
} from '../src/envelope.js';
import type { Transport } from '../src/transport/types.js';
import { makeMessage, makeContact } from './entities.test.js';

const BASE = 'http://localhost:4030';
const ALICE = 'alice@relay.example';
const BOB = 'bob@relay.example';

// The concrete QA thread: alice(root) <- bob(reply). carol follows bob only.
const A_ROOT = 'aaaa0000-1111-4222-8333-444444444444'; // alice's root post (held by carol)
const A_MID = 'aaaa1111-2222-4333-8444-555555555555'; // alice's mid-thread reply (held by carol)
const B_REPLY = 'bbbb2222-3333-4444-8555-666666666666'; // bob's reply carol holds locally

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backfill-render-'));
  store = createStore(join(dir, 'store.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const aliceAttestor = () => openAttestor(join(dir, 'alice-key.json'));
const signAlice = (env: Envelope): Envelope => ({ ...env, ...aliceAttestor().sign(env, ALICE) });

/** A transport that only knows bob's locally-held reply (msgId 30). Held content is NOT a message. */
const makeTransport = (localMsgs: Map<number, T.Message>): Transport =>
  ({
    self: async () => makeContact({ id: 1, address: 'carol@relay.example', displayName: 'carol' }),
    message: async (id: number) => localMsgs.get(id) ?? null,
    contactIdByAddr: async (addr: string) => (addr.toLowerCase() === ALICE ? 55 : null),
    contact: async (id: number) =>
      id === 55 ? makeContact({ id: 55, address: ALICE, displayName: 'alice' }) : null,
    messageMid: async (id: number) => `mid-${id}@x`,
    blobPath: async () => null,
  }) as unknown as Transport;

const ctxFor = (t: Transport): AppContext => ({
  getTransport: () => t,
  signup: async () => {
    throw new Error('nope');
  },
});

/**
 * Seed carol's store: she holds bob's reply LOCALLY (msgId 30, replies to alice's
 * mid A_MID) and, via backfill, holds alice's mid-reply + alice's root as HELD
 * envelopes. This is the post-backfill state.
 */
const seedCarol = (): { transport: Transport } => {
  // Alice's root post (held).
  store.addHeldEnvelope(signAlice(buildPostObject('alice root', A_ROOT)), BOB, 22, ALICE, 1);
  // Alice's mid-thread reply to her own root (held), carrying root=A_ROOT.
  store.addHeldEnvelope(
    signAlice(buildReplyObject('alice mid', A_MID, { u: A_ROOT, addr: ALICE }, undefined, { u: A_ROOT, addr: ALICE })),
    BOB,
    22,
    ALICE,
    2,
  );
  // Bob's reply to alice's mid (LOCAL), carrying root=A_ROOT.
  const bobReplyBody = serializeEnvelope(
    buildReplyObject('bob reply', B_REPLY, { u: A_MID, addr: ALICE }, undefined, { u: A_ROOT, addr: ALICE }),
  );
  const bobMsg = makeMessage({
    id: 30,
    fromId: 22,
    text: bobReplyBody,
    sender: makeContact({ id: 22, address: BOB, displayName: 'bob' }),
    timestamp: 1751800300,
  });
  store.ingestMessage(bobMsg, 'mid-30@x', true);
  return { transport: makeTransport(new Map([[30, bobMsg]])) };
};

describe('suppression: held envelopes stay out of timelines + notifications', () => {
  it('home/public timelines never contain held-envelope content', async () => {
    // carol holds alice's root as a held envelope but has an EMPTY feed timeline.
    store.addHeldEnvelope(signAlice(buildPostObject('alice root', A_ROOT)), BOB, 22, ALICE, 1);
    const transport = {
      self: async () => makeContact({ id: 1, address: 'carol@relay.example' }),
      timeline: async () => [], // no feed messages
      message: async () => null,
      messageMid: async () => null,
    } as unknown as Transport;
    const app = createUnsafeTestApp(ctxFor(transport), { baseUrl: BASE, store });
    for (const path of ['/api/v1/timelines/home', '/api/v1/timelines/public']) {
      const statuses = (await (await app.request(path)).json()) as any[];
      expect(statuses.every((s) => !String(s.id).startsWith('orig-'))).toBe(true);
      expect(statuses).toHaveLength(0);
    }
    // And no notification was ever produced by holding it.
    expect(store.listNotifications({})).toHaveLength(0);
  });
});

describe('resolveOrigStatus: held-envelope path', () => {
  it('GET /statuses/orig-<uuid> renders a verified held post attributed to its author', async () => {
    const { transport } = seedCarol();
    const app = createUnsafeTestApp(ctxFor(transport), { baseUrl: BASE, store });
    const res = await app.request(`/api/v1/statuses/orig-${A_ROOT}`);
    expect(res.status).toBe(200);
    const status = (await res.json()) as any;
    expect(status.id).toBe(`orig-${A_ROOT}`);
    expect(status.content).toContain('alice root');
    // Contact-first attribution: carol met alice's contact (id 55) → real account.
    expect(status.account.acct).toBe(ALICE);
    expect(status.account.display_name).toBe('alice');
  });

  it('drops + 404s a tampered held envelope (body changed after signing)', async () => {
    const tampered = { ...signAlice(buildPostObject('orig', A_ROOT)), text: 'HACKED' };
    store.addHeldEnvelope(tampered, BOB, 22, ALICE, 1);
    const app = createUnsafeTestApp(ctxFor(makeTransport(new Map())), { baseUrl: BASE, store });
    const res = await app.request(`/api/v1/statuses/orig-${A_ROOT}`);
    expect(res.status).toBe(404);
    // Hard-failed verification drops it from the store.
    expect(store.heldEnvelope(A_ROOT)).toBeNull();
  });
});

describe('context endpoint: held-envelope thread traversal', () => {
  it("carol's context of alice's ROOT shows the COMPLETE thread (held alice posts + local bob reply)", async () => {
    const { transport } = seedCarol();
    const app = createUnsafeTestApp(ctxFor(transport), { baseUrl: BASE, store });
    // Ask for the thread of alice's root (which carol only holds as a held envelope).
    const res = await app.request(`/api/v1/statuses/orig-${A_ROOT}/context`);
    expect(res.status).toBe(200);
    const ctx = (await res.json()) as any;

    const descIds: string[] = ctx.descendants.map((s: any) => s.id);
    // Alice's mid-reply (held) AND bob's reply (local) both appear as descendants.
    expect(descIds).toContain(`orig-${A_MID}`);
    expect(descIds).toContain('30');

    // Alice's held mid-reply is a real, verified, attributed status.
    const aliceMid = ctx.descendants.find((s: any) => s.id === `orig-${A_MID}`);
    expect(aliceMid.content).toContain('alice mid');
    expect(aliceMid.account.acct).toBe(ALICE);
    // It links into the thread: in_reply_to_id points at alice's root (orig id).
    expect(aliceMid.in_reply_to_id).toBe(`orig-${A_ROOT}`);
    // Bob's local reply links to alice's held mid (its orig id).
    const bobReply = ctx.descendants.find((s: any) => s.id === '30');
    expect(bobReply.in_reply_to_id).toBe(`orig-${A_MID}`);
  });

  it("carol's context of bob's LOCAL reply climbs held ancestors up to alice's root", async () => {
    const { transport } = seedCarol();
    const app = createUnsafeTestApp(ctxFor(transport), { baseUrl: BASE, store });
    const res = await app.request('/api/v1/statuses/30/context');
    const ctx = (await res.json()) as any;
    const ancestorIds: string[] = ctx.ancestors.map((s: any) => s.id);
    // Bob's reply -> alice mid (held) -> alice root (held).
    expect(ancestorIds).toEqual([`orig-${A_ROOT}`, `orig-${A_MID}`]);
    for (const a of ctx.ancestors) expect(a.account.acct).toBe(ALICE);
  });

  it('a tampered held ancestor renders nothing (climb stops, no placeholder)', async () => {
    // Replace alice's mid with a tampered copy: the climb must not render it and
    // must not surface alice's root through it.
    seedCarol();
    store.dropHeldEnvelope(A_MID);
    store.addHeldEnvelope({ ...signAlice(buildReplyObject('x', A_MID, { u: A_ROOT, addr: ALICE })), text: 'TAMPER' }, BOB, 22, ALICE, 2);
    const bobMsg = (await makeTransport(new Map()).message(30)) as T.Message | null;
    const app = createUnsafeTestApp(ctxFor(makeTransport(new Map([[30, makeMessage({
      id: 30,
      fromId: 22,
      text: serializeEnvelope(buildReplyObject('bob reply', B_REPLY, { u: A_MID, addr: ALICE }, undefined, { u: A_ROOT, addr: ALICE })),
      sender: makeContact({ id: 22, address: BOB }),
    })]]))), { baseUrl: BASE, store });
    void bobMsg;
    const res = await app.request('/api/v1/statuses/30/context');
    const ctx = (await res.json()) as any;
    // The tampered mid does not render; the climb stops before alice's root.
    expect(ctx.ancestors.map((s: any) => s.id)).not.toContain(`orig-${A_MID}`);
    expect(ctx.ancestors.map((s: any) => s.id)).not.toContain(`orig-${A_ROOT}`);
  });
});

describe('unconfirmed-author mark + thread-view key confirmation', () => {
  it('an unpinned held author renders author_unconfirmed; a matching pin clears it', async () => {
    const { transport } = seedCarol();
    const app = createUnsafeTestApp(ctxFor(transport), { baseUrl: BASE, store });
    const before = (await (await app.request(`/api/v1/statuses/orig-${A_ROOT}`)).json()) as any;
    expect(before.pleroma.headwater?.author_unconfirmed).toBe(true);
    expect(before.pleroma.deltanet).toEqual(before.pleroma.headwater);

    store.pinKey(ALICE, aliceAttestor().publicKeyBase64());
    const after = (await (await app.request(`/api/v1/statuses/orig-${A_ROOT}`)).json()) as any;
    expect(after.pleroma.headwater?.author_unconfirmed).toBeUndefined();
  });

  it('viewing held content from an unpinned author triggers ONE background confirmation', async () => {
    // A held root carrying alice's contact invite (unsigned field, added after
    // signing — exactly how send paths stamp it).
    const INVITE = 'OPENPGP4FPR:ALICE-CONTACT-INVITE';
    store.addHeldEnvelope(
      { ...signAlice(buildPostObject('alice root', A_ROOT)), invite: INVITE },
      BOB,
      22,
      ALICE,
      1,
    );
    const introductions: Array<{ invite: string; addr: string }> = [];
    const dms: Array<{ contactId: number; text: string }> = [];
    const transport = {
      ...makeTransport(new Map()),
      // Alice is a total stranger: no key contact until the introduction runs.
      keyContactIdForAddr: async () => null,
      introduceViaInvite: async (invite: string, addr: string) => {
        introductions.push({ invite, addr });
        return 55;
      },
      sendControlDm: async (contactId: number, text: string) => {
        dms.push({ contactId, text });
      },
    } as unknown as Transport;
    const app = createUnsafeTestApp(ctxFor(transport), { baseUrl: BASE, store });

    expect((await app.request(`/api/v1/statuses/orig-${A_ROOT}`)).status).toBe(200);
    await vi.waitFor(() => {
      expect(introductions).toEqual([{ invite: INVITE, addr: ALICE }]);
      expect(dms).toHaveLength(1);
    });
    const request = parseEnvelope(dms[0]!.text);
    expect(request?.type).toBe('envelope-request');
    expect(request?.refs).toEqual([{ u: A_ROOT, addr: ALICE }]);

    // A second view within the attempt window never re-introduces.
    expect((await app.request(`/api/v1/statuses/orig-${A_ROOT}`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(introductions).toHaveLength(1);
    expect(dms).toHaveLength(1);
  });
});
