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

const bodyOf = (m: T.Message): string => parseWire(m.text).body;

/**
 * Acceptance scenario from
 * ../../meta/issues/mention-addressing-autocomplete.md: mentioning someone
 * ADDRESSES them. A follows B (one-way: B never joins A's feed, so B can't
 * receive A's broadcast). A posts mentioning B's address. B still gets the
 * post — the same signed envelope arrives as a control DM — and derives a
 * `mention` notification from the body grammar.
 */
describe('mention addressing over the relay', () => {
  const transports: DeltaChatTransport[] = [];
  afterAll(() => {
    for (const t of transports) t.close();
  });

  const wireIngest = (store: Store, transportRef: () => Transport | null) =>
    async (msg: T.Message, isFeedMessage: boolean, mid: string | null, phase: IngestPhase): Promise<void> => {
      if (!mid) return;
      if (phase === 'combined' || phase === 'index') store.ingestMessage(msg, mid, isFeedMessage);
      if (phase === 'combined' || phase === 'derive') {
        const t = transportRef();
        const ownAddr = t ? (await t.self()).address : msg.fromId === 1 ? msg.sender.address : undefined;
        deriveOnIngest(store, msg, mid, ownAddr);
      }
    };

  it('a one-way-followed contact receives a mention as a DM copy + notification', async () => {
    const A_DATA = 'data/int-men-a';
    const B_DATA = 'data/int-men-b';
    for (const d of [A_DATA, B_DATA]) rmSync(d, { recursive: true, force: true });

    const [aCreds, bCreds] = await Promise.all([register(), register()]);
    const aStore = createStore(join(A_DATA, 'deltanet-store.json'));
    const bStore = createStore(join(B_DATA, 'deltanet-store.json'));

    const refs: { a: Transport | null; b: Transport | null } = { a: null, b: null };
    const a = await openRelayTransport(
      A_DATA,
      { addr: aCreds.addr, password: aCreds.password, displayName: 'int-men-a' },
      { onMessage: wireIngest(aStore, () => refs.a) },
    );
    const b = await openRelayTransport(
      B_DATA,
      { addr: bCreds.addr, password: bCreds.password, displayName: 'int-men-b' },
      { onMessage: wireIngest(bStore, () => refs.b) },
    );
    refs.a = a;
    refs.b = b;
    transports.push(a, b);

    const aApp = createUnsafeTestApp(
      { getTransport: () => a, signup: async () => { throw new Error('configured'); } },
      { baseUrl: 'http://localhost:4030', store: aStore, dataDir: A_DATA },
    );

    // ONE-WAY: A joins B's feed (giving both sides key-contacts via the
    // securejoin); B never joins A's feed, so B cannot receive A's broadcast.
    // Wait for BOTH sides: the inviter event fires on B, but A (the joiner)
    // finishes its own handshake a beat later — posting before that leaves
    // A without an e2ee-capable contact for B and the mention resolves to
    // nothing (observed live).
    const bSide = b.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    const aSide = a.waitForEvent('SecurejoinJoinerProgress', 120_000, (e) => e.progress === 1000);
    await a.follow(await b.feedInvite());
    await Promise.all([bSide, aSide]);

    // A's autocomplete offers B (known key-contact) by name.
    const search = (await (
      await aApp.request('/api/v1/accounts/search?q=int-men-b')
    ).json()) as any[];
    expect(search.some((acc) => acc.acct === bCreds.addr), 'search finds B by name').toBe(true);

    // A posts mentioning B's address.
    const stamp = Date.now();
    const text = `ping @${bCreds.addr} — mention test ${stamp}`;
    const postRes = await aApp.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: text }),
    });
    expect(postRes.status).toBe(200);
    const posted = (await postRes.json()) as any;
    expect(
      posted.mentions.some((m: any) => m.acct === bCreds.addr),
      "the posted status carries B's mention entry",
    ).toBe(true);

    // B (who does NOT follow A) receives the DM copy and derives the
    // mention notification.
    const deadline = Date.now() + 240_000;
    let mentionNotification: any = null;
    while (Date.now() < deadline && !mentionNotification) {
      mentionNotification = bStore
        .listNotifications({ limit: 20 })
        .find((n) => n.type === 'mention' && n.accountAddr === aCreds.addr);
      if (!mentionNotification) await new Promise((r) => setTimeout(r, 4000));
    }
    expect(mentionNotification, "B derived a mention notification from A's DM copy").toBeTruthy();

    // The delivered copy is the SAME signed post (verbatim body).
    const delivered = await b.message(mentionNotification.statusMsgId);
    expect(delivered && bodyOf(delivered)).toBe(text);
  }, 1_800_000);
});
