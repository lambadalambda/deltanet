import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type Store } from '../src/store.js';
import {
  buildInviteGrantText,
  buildInviteRequestText,
} from '../src/protocol.js';
import { buildInviteGrantEnvelope } from '../src/envelope.js';
import {
  deriveFollowbackActions,
  executeFollowbackAction,
  runFollowbackOnIngest,
} from '../src/ingest.js';
import type { Transport } from '../src/transport/types.js';
import { makeMessage } from './entities.test.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deltanet-followback-'));
  store = createStore(join(dir, 'store.json'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ALICE = 'alice@example.org';
const INVITE = 'https://i.delta.chat/#ALICEFEED';

const inviteRequestMsg = (over = {}) =>
  makeMessage({ id: 2, fromId: 11, text: buildInviteRequestText(), sender: { address: ALICE } as any, ...over });

const inviteGrantMsg = (link = INVITE, over = {}) =>
  makeMessage({ id: 3, fromId: 11, text: buildInviteGrantText(link), sender: { address: ALICE } as any, ...over });

describe('deriveFollowbackActions: invite-request', () => {
  it('returns a grant-invite action for a non-SELF invite-request DM', () => {
    const actions = deriveFollowbackActions(store, inviteRequestMsg(), false);
    expect(actions).toEqual([{ kind: 'grant-invite', toContactId: 11 }]);
  });

  it('ignores an invite-request from SELF (never grant to ourselves)', () => {
    const msg = inviteRequestMsg({ fromId: 1 });
    expect(deriveFollowbackActions(store, msg, false)).toEqual([]);
  });

  it('ignores an ordinary message', () => {
    const msg = makeMessage({ id: 2, fromId: 11, text: 'just chatting', sender: { address: ALICE } as any });
    expect(deriveFollowbackActions(store, msg, false)).toEqual([]);
  });
});

describe('deriveFollowbackActions: DM-only (feed messages never derive actions)', () => {
  it('ignores an invite-request delivered via a FEED chat (broadcast amplification guard)', () => {
    // A broadcast post containing the marker must NOT make every follower
    // auto-DM the poster a grant — the convention is 1:1 DM-only.
    expect(deriveFollowbackActions(store, inviteRequestMsg(), true)).toEqual([]);
  });

  it('ignores a grant delivered via a FEED chat even with a pending entry', () => {
    store.addPendingFollowRequest(ALICE, 1000);
    expect(deriveFollowbackActions(store, inviteGrantMsg(), true)).toEqual([]);
  });
});

describe('deriveFollowbackActions: invite grant', () => {
  it('returns an accept-grant action only when a pending request exists for the sender', () => {
    store.addPendingFollowRequest(ALICE, 1000);
    const actions = deriveFollowbackActions(store, inviteGrantMsg(), false);
    expect(actions).toEqual([{ kind: 'accept-grant', link: INVITE, fromAddr: ALICE }]);
  });

  it('ignores an unsolicited grant (no pending request for the sender)', () => {
    expect(deriveFollowbackActions(store, inviteGrantMsg(), false)).toEqual([]);
  });

  it('ignores a grant from SELF', () => {
    store.addPendingFollowRequest(ALICE, 1000);
    expect(deriveFollowbackActions(store, inviteGrantMsg(INVITE, { fromId: 1 }), false)).toEqual([]);
  });

  it('ignores a grant whose link is not a valid invite', () => {
    store.addPendingFollowRequest(ALICE, 1000);
    const msg = makeMessage({
      id: 3,
      fromId: 11,
      text: '⇋ invite https://evil.example.org/phish',
      sender: { address: ALICE } as any,
    });
    expect(deriveFollowbackActions(store, msg, false)).toEqual([]);
  });
});

const makeFakeTransport = () => {
  const dms: Array<{ contactId: number; text: string }> = [];
  const followed: string[] = [];
  const transport = {
    feedInvite: async () => INVITE,
    sendControlDm: async (contactId: number, text: string) => {
      dms.push({ contactId, text });
    },
    follow: async (link: string) => {
      followed.push(link);
      return 42;
    },
  } as unknown as Transport;
  return { transport, dms, followed };
};

describe('executeFollowbackAction: grant-invite', () => {
  it('replies to the requester with our feed invite', async () => {
    const { transport, dms } = makeFakeTransport();
    await executeFollowbackAction(store, transport, { kind: 'grant-invite', toContactId: 11 });
    expect(dms).toEqual([{ contactId: 11, text: buildInviteGrantEnvelope(INVITE) }]);
  });
});

describe('executeFollowbackAction: accept-grant', () => {
  it('joins the feed via follow() and clears the pending entry', async () => {
    store.addPendingFollowRequest(ALICE, 1000);
    const { transport, followed } = makeFakeTransport();
    await executeFollowbackAction(store, transport, { kind: 'accept-grant', link: INVITE, fromAddr: ALICE });
    expect(followed).toEqual([INVITE]);
    expect(store.hasPendingFollowRequest(ALICE)).toBe(false);
  });

  it('clears the pending entry even if follow() throws (never re-joins in a loop)', async () => {
    store.addPendingFollowRequest(ALICE, 1000);
    const transport = {
      follow: vi.fn(async () => {
        throw new Error('join failed');
      }),
    } as unknown as Transport;
    await executeFollowbackAction(store, transport, { kind: 'accept-grant', link: INVITE, fromAddr: ALICE });
    expect(store.hasPendingFollowRequest(ALICE)).toBe(false);
  });
});

describe('runFollowbackOnIngest: execute-once gating (freshness)', () => {
  /**
   * One live DM can reach the ingest hook multiple times: IncomingMsg AND the
   * MsgsChanged safety net (plus repeat MsgsChanged on state changes) can all
   * deliver the same msgId. Execution is gated on `store.ingestMessage`'s
   * freshness return, exactly as main.ts wires it — so a single
   * invite-request produces exactly one grant DM.
   */
  const liveIngest = async (transport: Transport, msg: ReturnType<typeof makeMessage>, mid: string) => {
    // Mirror of main.ts's ingestOnMessage for the live 'combined' path.
    const fresh = store.ingestMessage(msg, mid, false);
    await runFollowbackOnIngest(store, transport, msg, false, 'combined', fresh);
  };

  it('sends exactly one grant DM when the same invite-request msgId is processed twice', async () => {
    const { transport, dms } = makeFakeTransport();
    const msg = inviteRequestMsg();

    await liveIngest(transport, msg, 'req-mid@example.org'); // IncomingMsg
    await liveIngest(transport, msg, 'req-mid@example.org'); // MsgsChanged double-delivery

    expect(dms).toHaveLength(1);
    expect(dms[0]).toEqual({ contactId: 11, text: buildInviteGrantEnvelope(INVITE) });
  });

  it('joins exactly once when the same grant msgId is processed twice', async () => {
    store.addPendingFollowRequest(ALICE, 1000);
    const { transport, followed } = makeFakeTransport();
    const msg = inviteGrantMsg();

    await liveIngest(transport, msg, 'grant-mid@example.org');
    await liveIngest(transport, msg, 'grant-mid@example.org');

    expect(followed).toEqual([INVITE]);
    expect(store.hasPendingFollowRequest(ALICE)).toBe(false);
  });

  it('never executes for a feed-chat message carrying the marker, even when fresh', async () => {
    const { transport, dms } = makeFakeTransport();
    const msg = inviteRequestMsg();
    const fresh = store.ingestMessage(msg, 'feed-req-mid@example.org', true);
    expect(fresh).toBe(true);
    await runFollowbackOnIngest(store, transport, msg, true, 'combined', fresh);
    expect(dms).toHaveLength(0);
  });

  it('backfill derive phase only cleans up pending state, never executes', async () => {
    store.addPendingFollowRequest(ALICE, 1000);
    const { transport, followed, dms } = makeFakeTransport();

    await runFollowbackOnIngest(store, transport, inviteRequestMsg(), false, 'derive', false);
    await runFollowbackOnIngest(store, transport, inviteGrantMsg(), false, 'derive', false);

    expect(dms).toHaveLength(0); // no re-grant on restart
    expect(followed).toHaveLength(0); // no re-join on restart
    expect(store.hasPendingFollowRequest(ALICE)).toBe(false); // but pending cleared
  });

  it('does nothing on the index phase', async () => {
    store.addPendingFollowRequest(ALICE, 1000);
    const { transport, followed, dms } = makeFakeTransport();
    await runFollowbackOnIngest(store, transport, inviteGrantMsg(), false, 'index', true);
    expect(dms).toHaveLength(0);
    expect(followed).toHaveLength(0);
    expect(store.hasPendingFollowRequest(ALICE)).toBe(true);
  });

  it('does not execute when no transport is available yet (startup race)', async () => {
    store.addPendingFollowRequest(ALICE, 1000);
    const msg = inviteGrantMsg();
    const fresh = store.ingestMessage(msg, 'grant-mid@example.org', false);
    await runFollowbackOnIngest(store, null, msg, false, 'combined', fresh);
    // Nothing to assert against a transport; the pending entry stays intact.
    expect(store.hasPendingFollowRequest(ALICE)).toBe(true);
  });
});

describe('followback control DMs do not register edges or notifications', () => {
  it('deriveOnIngest never notifies on an invite-request or grant', async () => {
    const { deriveOnIngest } = await import('../src/ingest.js');
    store.addPendingFollowRequest(ALICE, 1000);
    expect(deriveOnIngest(store, inviteRequestMsg(), 'req-mid@example.org')).toEqual([]);
    expect(deriveOnIngest(store, inviteGrantMsg(), 'grant-mid@example.org')).toEqual([]);
    expect(store.listNotifications({})).toHaveLength(0);
  });
});
