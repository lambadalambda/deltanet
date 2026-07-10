import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import {
  restoreTransport,
  type DeltaChatTransport,
  type IngestPhase,
} from '../../src/transport/deltachat.js';
import { openRelayTransport, register } from './relay.js';
import type { Transport } from '../../src/transport/types.js';
import { createStore, type Store } from '../../src/store.js';
import { createUnsafeTestApp, type AppContext } from '../../src/server.js';
import { deriveOnIngest } from '../../src/ingest.js';
import { parseEnvelope } from '../../src/envelope.js';
import { parseWire } from '../../src/wire.js';

const bodyOf = (m: T.Message): string => parseWire(m.text).body;

/**
 * Acceptance scenario from ../../meta/issues/backup-second-device.md:
 * export → wipe the node → restore → identity, follows, and history intact.
 * The load-bearing assertion is the ATTESTATION KEY surviving: B TOFU-pins A's
 * ed25519 pubkey before the wipe, and A's first post-restore post must carry
 * that same pubkey — a restore that lost the sidecar would mint a fresh key
 * and break every follower's pin.
 */
describe('backup & restore over the relay', () => {
  const transports: DeltaChatTransport[] = [];
  afterAll(() => {
    for (const t of transports) t.close();
  });

  /** Minimal main.ts-style ingest: index + derive (enough for pins/notifications). */
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

  const waitFor = async (transport: Transport, pred: (m: T.Message) => boolean, ms = 180_000): Promise<T.Message> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = (await transport.timeline({ limit: 60 })).find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('timed out waiting for feed message');
  };

  it('export → wipe → restore keeps identity, follows, history, and the attestation key', async () => {
    const A_DATA = 'data/int-bak-a';
    const B_DATA = 'data/int-bak-b';
    for (const d of [A_DATA, B_DATA]) rmSync(d, { recursive: true, force: true });

    const [aCreds, bCreds] = await Promise.all([register(), register()]);
    const aStore = createStore(join(A_DATA, 'deltanet-store.json'));
    const bStore = createStore(join(B_DATA, 'deltanet-store.json'));

    const refs: { a: Transport | null; b: Transport | null } = { a: null, b: null };
    const a = await openRelayTransport(
      A_DATA,
      { addr: aCreds.addr, password: aCreds.password, displayName: 'int-bak-a' },
      { onMessage: wireIngest(aStore, () => refs.a) },
    );
    const b = await openRelayTransport(
      B_DATA,
      { addr: bCreds.addr, password: bCreds.password, displayName: 'int-bak-b' },
      { onMessage: wireIngest(bStore, () => refs.b) },
    );
    refs.a = a;
    refs.b = b;
    transports.push(a, b);

    const ctxFor = (t: Transport): AppContext => ({
      getTransport: () => t,
      signup: async () => {
        throw new Error('already configured');
      },
    });
    const aApp = createUnsafeTestApp(ctxFor(a), { baseUrl: 'http://localhost:4030', store: aStore, dataDir: A_DATA });

    // Mutual follow: B joins A's feed (so B pins A's key from A's posts), and
    // A joins B's feed (so `following` has something to survive the wipe).
    const bJoinsA = a.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await b.follow(await a.feedInvite());
    await bJoinsA;
    const aJoinsB = b.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await a.follow(await b.feedInvite());
    await aJoinsB;

    const post = async (app: ReturnType<typeof createUnsafeTestApp>, status: string): Promise<void> => {
      const res = await app.request('/api/v1/statuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      expect(res.status).toBe(200);
    };

    const stamp = Date.now();
    const preText = `pre-backup ${stamp}`;
    await post(aApp, preText);

    // B receives the signed post and TOFU-pins A's attestation pubkey.
    await waitFor(b, (m) => bodyOf(m) === preText);
    const pinnedBefore = bStore.pinnedKey(aCreds.addr);
    expect(pinnedBefore, "B pinned A's key from the pre-backup post").toBeTruthy();

    // A sets a petname for B (real core changeContactName). It lives in dc.db,
    // so the restore below must bring it back.
    const bContactId = await a.contactIdByAddr(bCreds.addr);
    expect(bContactId).not.toBeNull();
    const petRes = await aApp.request(`/api/deltanet/contacts/${bContactId}/petname`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ petname: 'bobby' }),
    });
    expect(petRes.status).toBe(200);
    const petAccount = (await petRes.json()) as any;
    expect(petAccount.display_name).toBe('bobby');
    expect(petAccount.pleroma.deltanet.petname).toBe('bobby');
    expect((await a.contact(bContactId!))?.displayName).toBe('bobby');

    // Export a .dnbk through the endpoint (real core exportBackup underneath).
    const exportRes = await aApp.request('/api/deltanet/backup/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: 'hunter2' }),
    });
    expect(exportRes.status).toBe(200);
    const container = Buffer.from(await exportRes.arrayBuffer());
    expect(container.length).toBeGreaterThan(1000);
    const info = (await (await aApp.request('/api/deltanet/backup')).json()) as any;
    expect(typeof info.last_backup_at).toBe('number');

    // THE WIPE: kill A's core and delete the whole data dir — the disk is gone.
    a.close();
    transports.splice(transports.indexOf(a), 1);
    refs.a = null;
    rmSync(A_DATA, { recursive: true, force: true });

    // A fresh, unconfigured node at the same path, wired like main.ts's restore.
    const a2Store = createStore(join(A_DATA, 'deltanet-store.json'));
    let a2: Transport | null = null;
    const restoreCtx: AppContext = {
      getTransport: () => a2,
      signup: async () => {
        throw new Error('unused');
      },
      restore: async (tarPath, passphrase, beforeOpen) => {
        const { transport, creds } = await restoreTransport(
          A_DATA,
          tarPath,
          passphrase,
          { onMessage: wireIngest(a2Store, () => a2) },
          beforeOpen,
        );
        expect(creds.addr).toBe(aCreds.addr);
        a2 = transport;
        transports.push(transport);
        return transport;
      },
    };
    const a2App = createUnsafeTestApp(restoreCtx, { baseUrl: 'http://localhost:4030', store: a2Store, dataDir: A_DATA });

    // Wrong passphrase: clean 422, node untouched (GCM rejects before core import).
    const badFd = new FormData();
    badFd.append('file', new File([new Uint8Array(container)], 'backup.dnbk'));
    badFd.append('passphrase', 'wrong');
    const badRes = await a2App.request('/api/deltanet/restore', { method: 'POST', body: badFd });
    expect(badRes.status).toBe(422);
    expect(a2).toBeNull();

    // The real restore.
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(container)], 'backup.dnbk'));
    fd.append('passphrase', 'hunter2');
    const res = await a2App.request('/api/deltanet/restore', { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).account.acct).toBe(aCreds.addr);

    // Identity, follows, history.
    expect((await a2!.self()).address).toBe(aCreds.addr);
    const follows = await a2!.following();
    expect(follows.some((f) => f.addr === bCreds.addr), 'A still follows B').toBe(true);
    const timelineTexts = (await a2!.timeline({ limit: 60 })).map(bodyOf);
    expect(timelineTexts, 'pre-backup history restored').toContain(preText);

    // The petname survived the wipe (it lives in dc.db inside the backup).
    const bContactIdAfter = await a2!.contactIdByAddr(bCreds.addr);
    expect(bContactIdAfter).not.toBeNull();
    const bAfter = await a2!.contact(bContactIdAfter!);
    expect(bAfter?.displayName, "A's petname for B survived the restore").toBe('bobby');
    expect(bAfter?.name).toBe('bobby');

    // The last-backup stamp traveled inside the backup's config.
    const restoredInfo = (await (await a2App.request('/api/deltanet/backup')).json()) as any;
    expect(typeof restoredInfo.last_backup_at).toBe('number');

    // THE key assertion: a post-restore post signs with the restored key, so
    // B's existing TOFU pin still matches.
    const postText = `post-restore ${stamp}`;
    await post(a2App, postText);
    const postOnB = await waitFor(b, (m) => bodyOf(m) === postText);
    const env = parseEnvelope(postOnB.text);
    expect(env?.pubkey, "post-restore post carries the pubkey B pinned pre-wipe").toBe(pinnedBefore);
    expect(bStore.pinnedKey(aCreds.addr)).toBe(pinnedBefore);
  }, 1_800_000);
});
