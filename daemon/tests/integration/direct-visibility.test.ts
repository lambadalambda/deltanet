import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import { type DeltaChatTransport, type IngestPhase } from '../../src/transport/deltachat.js';
import { openRelayTransport, register } from './relay.js';
import type { Transport } from '../../src/transport/types.js';
import { createStore, type Store } from '../../src/store.js';
import { createUnsafeTestApp, type AppContext } from '../../src/server.js';
import { deriveOnIngest } from '../../src/ingest.js';
import { parseWire } from '../../src/wire.js';

const bodyOf = (message: T.Message): string => parseWire(message.text).body;

describe('direct visibility over the relay', () => {
  const transports: DeltaChatTransport[] = [];
  afterAll(() => {
    for (const transport of transports) transport.close();
  });

  const wireIngest = (store: Store, transportRef: () => Transport | null) =>
    async (message: T.Message, isFeedMessage: boolean, mid: string | null, phase: IngestPhase): Promise<void> => {
      if (!mid) return;
      if (phase === 'combined' || phase === 'index') store.ingestMessage(message, mid, isFeedMessage);
      if (phase === 'combined' || phase === 'derive') {
        const transport = transportRef();
        const ownAddr = transport
          ? (await transport.self()).address
          : message.fromId === 1
            ? message.sender.address
            : undefined;
        deriveOnIngest(store, message, mid, ownAddr);
      }
    };

  const contextFor = (transport: Transport): AppContext => ({
    getTransport: () => transport,
    signup: async () => {
      throw new Error('already configured');
    },
  });

  const until = async <Value>(
    read: () => Value | null | undefined | false,
    what: string,
    timeoutMs = 240_000,
  ): Promise<Value> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  it('delivers only to mentions, stays out of feeds, notifies, threads, and inherits direct on reply', async () => {
    const A_DATA = 'data/int-direct-a';
    const B_DATA = 'data/int-direct-b';
    const C_DATA = 'data/int-direct-c';
    for (const directory of [A_DATA, B_DATA, C_DATA]) rmSync(directory, { recursive: true, force: true });

    const [aCreds, bCreds, cCreds] = await Promise.all([register(), register(), register()]);
    const aStore = createStore(join(A_DATA, 'deltanet-store.json'));
    const bStore = createStore(join(B_DATA, 'deltanet-store.json'));
    const cStore = createStore(join(C_DATA, 'deltanet-store.json'));
    const refs: { a: Transport | null; b: Transport | null; c: Transport | null } = {
      a: null,
      b: null,
      c: null,
    };
    const a = await openRelayTransport(
      A_DATA,
      { addr: aCreds.addr, password: aCreds.password, displayName: 'int-direct-a' },
      { onMessage: wireIngest(aStore, () => refs.a) },
    );
    const b = await openRelayTransport(
      B_DATA,
      { addr: bCreds.addr, password: bCreds.password, displayName: 'int-direct-b' },
      { onMessage: wireIngest(bStore, () => refs.b) },
    );
    const c = await openRelayTransport(
      C_DATA,
      { addr: cCreds.addr, password: cCreds.password, displayName: 'int-direct-c' },
      { onMessage: wireIngest(cStore, () => refs.c) },
    );
    refs.a = a;
    refs.b = b;
    refs.c = c;
    transports.push(a, b, c);

    const aApp = createUnsafeTestApp(contextFor(a), { baseUrl: 'http://localhost:4030', store: aStore, dataDir: A_DATA });
    const bApp = createUnsafeTestApp(contextFor(b), { baseUrl: 'http://localhost:4031', store: bStore, dataDir: B_DATA });

    // B and C both follow A's public feed. This gives A E2EE key contacts for
    // both and makes C an active leak canary if direct ever hits the broadcast.
    for (const follower of [b, c]) {
      const inviterDone = a.waitForEvent('SecurejoinInviterProgress', 120_000, (event) => event.progress === 1000);
      const joinerDone = follower.waitForEvent('SecurejoinJoinerProgress', 120_000, (event) => event.progress === 1000);
      await follower.follow(await a.feedInvite());
      await Promise.all([inviterDone, joinerDone]);
    }

    const stamp = Date.now();
    const directText = `only for @${bCreds.addr} direct ${stamp}`;
    const postResponse = await aApp.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: directText, visibility: 'direct' }),
    });
    expect(postResponse.status).toBe(200);
    const posted = (await postResponse.json()) as any;
    expect(posted.visibility).toBe('direct');

    const bMention = await until(
      () => bStore.listNotifications({ limit: 20 }).find(
        (notification) => notification.type === 'mention' && notification.accountAddr === aCreds.addr,
      ),
      "B's direct mention notification",
    );
    const directOnB = await b.message(bMention.statusMsgId!);
    expect(directOnB && bodyOf(directOnB)).toBe(directText);
    const bStatus = (await (await bApp.request(`/api/v1/statuses/${bMention.statusMsgId}`)).json()) as any;
    expect(bStatus.visibility).toBe('direct');
    const notifications = (await (await bApp.request('/api/v1/notifications')).json()) as any[];
    expect(notifications.find((notification) => notification.id === bMention.id)?.status?.id).toBe(
      String(bMention.statusMsgId),
    );

    // Direct is status/thread/notification-addressable but absent from every
    // feed. C is a public follower and therefore catches any broadcast leak.
    expect((await a.timeline({ limit: 60 })).map(bodyOf)).not.toContain(directText);
    expect((await b.timeline({ limit: 60 })).map(bodyOf)).not.toContain(directText);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    expect((await c.timeline({ limit: 60 })).map(bodyOf)).not.toContain(directText);
    expect((await (await aApp.request(`/api/v1/statuses/${posted.id}/context`)).json()) as any).toEqual({
      ancestors: [],
      descendants: [],
    });
    expect((await bApp.request(`/api/v1/statuses/${bMention.statusMsgId}/reblog`, { method: 'POST' })).status).toBe(422);
    expect((await bApp.request(`/api/v1/pleroma/statuses/${bMention.statusMsgId}/subscribe`, { method: 'POST' })).status).toBe(422);

    // Requested public, but a direct parent forces direct. The parent author A
    // is the recipient; C still receives nothing.
    const replyText = `direct reply ${stamp}`;
    const replyResponse = await bApp.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: replyText,
        visibility: 'public',
        in_reply_to_id: String(bMention.statusMsgId),
      }),
    });
    expect(replyResponse.status).toBe(200);
    expect(((await replyResponse.json()) as any).visibility).toBe('direct');
    await until(
      () => aStore.listNotifications({ limit: 20 }).find(
        (notification) => notification.type === 'mention' && notification.accountAddr === bCreds.addr,
      ),
      "A's direct reply notification",
    );
    const context = (await (await aApp.request(`/api/v1/statuses/${posted.id}/context`)).json()) as any;
    expect(context.descendants.some((status: any) => status.content.includes(replyText))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    expect((await c.timeline({ limit: 60 })).map(bodyOf)).not.toContain(replyText);
  }, 1_800_000);
});
