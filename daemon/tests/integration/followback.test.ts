import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import {
  type DeltaChatTransport,
  type IngestPhase,
} from '../../src/transport/deltachat.js';
import { openRelayTransport, register } from './relay.js';
import type { Transport } from '../../src/transport/types.js';
import { createStore, type Store } from '../../src/store.js';
import { buildInviteRequestEnvelope } from '../../src/envelope.js';
import {
  deriveFollowbackActions,
  deriveOnIngest,
  runFollowbackOnIngest,
} from '../../src/ingest.js';

/**
 * Real follow-back over chatmail (local podman relay by default,
 * nine.testrun.org with HEADWATER_TEST_RELAY=testrun), driven the way `main.ts` wires
 * ingestion — no test shortcuts: the invite-request travels over the real
 * network, B's auto-grant comes from B's own ingest handling, and A joins
 * B's feed off the grant B DMs back.
 *
 * Flow: A and B both create feeds. B follows A via A's invite link (existing
 * pattern). Then A follows B back by DMing an `⇋ invite-request` over their
 * shared 1:1 channel; B's ingest auto-grants (replies with B's feed invite);
 * A's ingest — because A recorded a pending request to B — securejoins B's
 * feed and clears the pending marker. Finally B posts and A receives it.
 */
describe('follow-back via invite-request over chatmail', () => {
  const transports: DeltaChatTransport[] = [];

  afterAll(() => {
    for (const transport of transports) transport.close();
  });

  /**
   * A minimal ingest handler mirroring `main.ts`'s `ingestOnMessage`: index
   * the message (capturing the freshness return, which gates execute-once
   * follow-back actions against IncomingMsg/MsgsChanged double-delivery),
   * derive notifications, then hand the follow-back half to
   * `runFollowbackOnIngest` — the same function `main.ts` calls, with all its
   * phase/DM-only/freshness gating. `getTransport()` is a thunk so the
   * handler can reach the transport the moment it's assigned, exactly as
   * `main.ts` reads its module-level `transport` variable.
   */
  const wireIngest = (store: Store, getTransport: () => Transport | null) => {
    return async (
      msg: T.Message,
      isFeedMessage: boolean,
      mid: string | null,
      phase: IngestPhase,
    ): Promise<void> => {
      if (!mid) return;
      let fresh = false;
      if (phase === 'combined' || phase === 'index') {
        fresh = store.ingestMessage(msg, mid, isFeedMessage);
      }
      if (phase === 'combined' || phase === 'derive') deriveOnIngest(store, msg, mid);
      await runFollowbackOnIngest(store, getTransport(), msg, isFeedMessage, phase, fresh);
    };
  };

  const scratchStore = (): Store => createStore(join(mkdtempSync(join(tmpdir(), 'deltanet-fb-')), 'store.json'));

  it('lets A follow B back via an invite-request (no link paste) and receive B\'s feed', async () => {
    rmSync('data/int-followback-alice', { recursive: true, force: true });
    rmSync('data/int-followback-bob', { recursive: true, force: true });

    const [aliceCreds, bobCreds] = await Promise.all([register(), register()]);

    const aliceStore = scratchStore();
    const bobStore = scratchStore();
    let alice: DeltaChatTransport | null = null;
    let bob: DeltaChatTransport | null = null;

    alice = await openRelayTransport(
      'data/int-followback-alice',
      { addr: aliceCreds.addr, password: aliceCreds.password, displayName: 'int-fb-alice' },
      { onMessage: wireIngest(aliceStore, () => alice) },
    );
    bob = await openRelayTransport(
      'data/int-followback-bob',
      { addr: bobCreds.addr, password: bobCreds.password, displayName: 'int-fb-bob' },
      { onMessage: wireIngest(bobStore, () => bob) },
    );
    transports.push(alice, bob);

    // Ensure both feeds exist (creates the broadcast chat under the hood).
    await alice.feedInvite();
    await bob.feedInvite();

    // --- B follows A via A's invite link (existing pattern) ---
    const aliceInvite = await alice.feedInvite();
    const bJoinsA = alice.waitForEvent(
      'SecurejoinInviterProgress',
      120_000,
      (event) => event.progress === 1000,
    );
    await bob.follow(aliceInvite);
    // The inviter-side securejoin event carries the joiner's (B's) contact id
    // — the reliable way for A to learn B as a contact (broadcast followers
    // don't post into A's feed, so `contactIdByAddr` may not resolve yet).
    const bobContactId = (await bJoinsA).contactId;
    expect(bobContactId).toBeGreaterThan(0);

    // --- A follows B back: DM a v2 invite-request envelope, record pending ---
    // This is exactly what the follow endpoint does; we drive the transport
    // directly here since the request must genuinely traverse the network.
    await alice.sendControlDm(bobContactId, buildInviteRequestEnvelope());
    aliceStore.addPendingFollowRequest(bobCreds.addr, Date.now());

    // B's ingest sees the request, auto-grants (DMs its feed invite); A's
    // ingest sees the grant, joins B's feed, clears pending. Poll A's
    // following() until B's feed appears.
    let aliceFollowsBob;
    {
      const deadline = Date.now() + 180_000;
      while (aliceFollowsBob === undefined && Date.now() < deadline) {
        aliceFollowsBob = (await alice.following()).find((f) => f.addr === bobCreds.addr);
        if (aliceFollowsBob === undefined) await new Promise((r) => setTimeout(r, 4000));
      }
    }
    expect(aliceFollowsBob).toBeDefined();

    // Pending entry was cleared once the join completed.
    expect(aliceStore.hasPendingFollowRequest(bobCreds.addr)).toBe(false);

    // --- B posts; A (now following B) receives it ---
    const text = `hello alice, follow-back post ${Date.now()}`;
    await bob.post(text);

    let arrived;
    {
      const deadline = Date.now() + 180_000;
      while (arrived === undefined && Date.now() < deadline) {
        const timeline = await alice.timeline({ limit: 20 });
        arrived = timeline.find((msg) => msg.text === text);
        if (arrived === undefined) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    expect(arrived).toBeDefined();
    expect(arrived?.sender.address).toBe(bobCreds.addr);
  }, 300_000);

  /**
   * Security: an *unsolicited* `⇋ invite <link>` grant (no recorded pending
   * request from the sender) must never trigger a join. This is the pure
   * gating guarantee, exercised here as a unit-style check (no network) so
   * it's fast and deterministic — `deriveFollowbackActions` returns no action
   * for a grant whose sender has no pending entry.
   */
  it('does not join on an unsolicited grant (no pending entry)', () => {
    const store = scratchStore();
    // No pending request recorded for the sender.
    const grant = {
      id: 1,
      fromId: 11,
      text: '⇋ invite https://i.delta.chat/#EVILUNSOLICITED',
      sender: { address: 'stranger@example.org' },
    } as unknown as T.Message;
    expect(deriveFollowbackActions(store, grant, false)).toEqual([]);

    // With a pending entry, the same grant would be accepted — proving the
    // gate is what makes the difference, not some unrelated rejection.
    store.addPendingFollowRequest('stranger@example.org', Date.now());
    expect(deriveFollowbackActions(store, grant, false)).toEqual([
      { kind: 'accept-grant', link: 'https://i.delta.chat/#EVILUNSOLICITED', fromAddr: 'stranger@example.org' },
    ]);
  });
});
