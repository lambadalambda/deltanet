import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import { createStore, type Store } from '../src/store.js';
import { createBackfiller, type Backfiller } from '../src/backfill.js';
import { openAttestor } from '../src/attest.js';
import {
  enqueueDangling,
  buildServeBundles,
  processBundle,
  handleBackfillControlDm,
  seedBackfillQueue,
} from '../src/backfill-ingest.js';
import {
  buildPostObject,
  buildReplyObject,
  buildEnvelopeRequest,
  buildEnvelopeBundle,
  parseEnvelope,
  serializeEnvelope,
  type Envelope,
} from '../src/envelope.js';
import type { Transport } from '../src/transport/types.js';
import { makeMessage, makeContact } from './entities.test.js';

const ALICE = 'alice@relay.example';
const BOB = 'bob@relay.example';
const AU = 'aaaa1111-2222-4333-8444-555555555555';
const BU = 'bbbb2222-3333-4444-8555-666666666666';
const RU = 'rrrr3333-4444-4555-8666-777777777777';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backfill-ingest-'));
  store = createStore(join(dir, 'store.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const aliceAttestor = () => openAttestor(join(dir, 'alice-key.json'));
const signAlice = (env: Envelope): Envelope => ({ ...env, ...aliceAttestor().sign(env, ALICE) });

/** A no-timer backfiller wired to the real store + a spy send. */
const makeBackfiller = (): { bf: Backfiller; sent: { peer: string; contactId: number; refs: any[] }[] } => {
  const sent: { peer: string; contactId: number; refs: any[] }[] = [];
  const bf = createBackfiller({
    store,
    send: async (peer, contactId, refs) => {
      sent.push({ peer, contactId, refs });
    },
    schedule: () => null,
    cancel: () => {},
  });
  return { bf, sent };
};

/** A minimal transport that serves message bodies by uuid via the store. */
const makeTransport = (bodyByMsgId: Map<number, string>): Transport =>
  ({
    message: async (id: number) => {
      const text = bodyByMsgId.get(id);
      return text ? makeMessage({ id, text }) : null;
    },
    sendControlDm: async () => {},
  }) as unknown as Transport;

describe('enqueueDangling', () => {
  it("enqueues a reply's unresolved parent uuid against the sender", () => {
    const { bf } = makeBackfiller();
    const reply = serializeEnvelope(buildReplyObject('r', BU, { u: AU, addr: ALICE }));
    const msg = makeMessage({ id: 5, fromId: 22, text: reply, sender: makeContact({ id: 22, address: BOB }) });
    enqueueDangling(store, bf, msg);
    expect(bf.pendingFor(BOB)).toEqual([AU]);
    expect(bf.attributedAddr(AU)).toBe(ALICE);
  });

  it('does nothing for SELF messages', () => {
    const { bf } = makeBackfiller();
    const reply = serializeEnvelope(buildReplyObject('r', BU, { u: AU, addr: ALICE }));
    enqueueDangling(store, bf, makeMessage({ id: 5, fromId: 1, text: reply }));
    expect(bf.pendingFor(BOB)).toEqual([]);
  });

  it('does not enqueue a ref already held', () => {
    const { bf } = makeBackfiller();
    store.addHeldEnvelope(signAlice(buildPostObject('held', AU)), BOB, 22, ALICE, 1);
    const reply = serializeEnvelope(buildReplyObject('r', BU, { u: AU, addr: ALICE }));
    const msg = makeMessage({ id: 5, fromId: 22, text: reply, sender: makeContact({ id: 22, address: BOB }) });
    enqueueDangling(store, bf, msg);
    expect(bf.pendingFor(BOB)).toEqual([]);
  });
});

describe('serve side (buildServeBundles)', () => {
  it('serves a signed local envelope verbatim, omits what we do not hold', async () => {
    const aliceEnv = signAlice(buildPostObject('alice post', AU));
    // We locally hold alice's post as msgId 9 (bob is the responder here).
    store.ingestMessage(makeMessage({ id: 9, text: serializeEnvelope(aliceEnv) }), 'mid-9@x', true);
    const transport = makeTransport(new Map([[9, serializeEnvelope(aliceEnv)]]));
    const bundles = await buildServeBundles(store, transport, [
      { u: AU, addr: ALICE },
      { u: 'unheld-uuid', addr: ALICE },
    ]);
    expect(bundles).toHaveLength(1);
    const envs = parseEnvelope(bundles[0]!)?.envs;
    expect(envs).toHaveLength(1);
    expect(envs![0]!.uuid).toBe(AU);
    expect(envs![0]!.sig).toBeDefined(); // verbatim, keeps its signature
  });

  it('omits an unsigned local target (never fabricates a signature)', async () => {
    const unsigned = serializeEnvelope(buildPostObject('legacy', AU));
    store.ingestMessage(makeMessage({ id: 9, text: unsigned }), 'mid-9@x', true);
    const transport = makeTransport(new Map([[9, unsigned]]));
    expect(await buildServeBundles(store, transport, [{ u: AU, addr: ALICE }])).toEqual([]);
  });

  it('never serves an own LOCKED post (visibility channels, leak guard)', async () => {
    const lockedEnv = signAlice(buildPostObject('followers only', AU));
    store.ingestMessage(makeMessage({ id: 9, text: serializeEnvelope(lockedEnv) }), 'mid-9@x', true);
    store.markLockedPost(AU);
    const transport = makeTransport(new Map([[9, serializeEnvelope(lockedEnv)]]));
    expect(await buildServeBundles(store, transport, [{ u: AU, addr: ALICE }])).toEqual([]);
  });

  it('serves a held envelope onward (relaying)', async () => {
    store.addHeldEnvelope(signAlice(buildPostObject('held', AU)), BOB, 22, ALICE, 1);
    const transport = makeTransport(new Map());
    const bundles = await buildServeBundles(store, transport, [{ u: AU, addr: ALICE }]);
    expect(parseEnvelope(bundles[0]!)?.envs?.[0]?.uuid).toBe(AU);
  });
});

describe('bundle receipt (processBundle)', () => {
  it('stores signed items as held, marks them resolved, and re-chases transitive refs', () => {
    const { bf } = makeBackfiller();
    // A held reply whose OWN parent (RU) still dangles → should be enqueued next.
    const heldReply = signAlice(buildReplyObject('alice reply', AU, { u: RU, addr: ALICE }));
    // Pretend we asked for AU (in-flight, attributed to ALICE).
    bf.enqueue({ uuid: AU, peer: BOB, peerContactId: 22, authorAddr: ALICE });
    const bundle = parseEnvelope(buildEnvelopeBundle([heldReply]))!;
    processBundle(store, bf, BOB, 22, bundle, 1000);

    expect(store.heldEnvelope(AU)?.env.text).toBe('alice reply');
    expect(store.heldEnvelope(AU)?.authorAddr).toBe(ALICE); // attributed from the request ref
    expect(bf.isInFlight(AU)).toBe(false); // resolved
    // Transitive: RU (the held reply's parent) is now queued against BOB.
    expect(bf.pendingFor(BOB)).toContain(RU);
  });

  it('drops unsigned / non-content bundle items', () => {
    const { bf } = makeBackfiller();
    const unsigned = buildPostObject('nope', AU);
    const bundle = parseEnvelope(buildEnvelopeBundle([unsigned]))!;
    processBundle(store, bf, BOB, 22, bundle, 1);
    expect(store.heldEnvelope(AU)).toBeNull();
  });

  it('a tampered item is stored but self-drops at render; siblings survive', () => {
    // processBundle stores structurally-signed items; render-time verify drops
    // the tampered one. Here we just assert both are STORED (render is server's
    // job, tested there) — the sibling is never lost due to a bad sibling.
    const { bf } = makeBackfiller();
    const good = signAlice(buildPostObject('good', AU));
    const tampered = { ...signAlice(buildPostObject('orig', BU)), text: 'TAMPERED' };
    const bundle = parseEnvelope(buildEnvelopeBundle([good, tampered]))!;
    processBundle(store, bf, BOB, 22, bundle, 1);
    expect(store.heldEnvelope(AU)).not.toBeNull();
    expect(store.heldEnvelope(BU)).not.toBeNull();
  });

  it('does not overwrite an existing local resolution', () => {
    const { bf } = makeBackfiller();
    store.ingestMessage(makeMessage({ id: 3, text: serializeEnvelope(buildPostObject('local', AU)) }), 'mid-3@x', true);
    const bundle = parseEnvelope(buildEnvelopeBundle([signAlice(buildPostObject('bundled', AU))]))!;
    processBundle(store, bf, BOB, 22, bundle, 1);
    expect(store.heldEnvelope(AU)).toBeNull(); // local copy wins
  });
});

describe('handleBackfillControlDm: serve + suppression', () => {
  const contactMsg = (text: string, over: Partial<T.Message> = {}) =>
    makeMessage({ id: 40, fromId: 22, text, sender: makeContact({ id: 22, address: BOB }), ...over });

  it('serves an envelope-request from a contact (rate-limited)', async () => {
    const { bf } = makeBackfiller();
    const aliceEnv = signAlice(buildPostObject('alice', AU));
    store.ingestMessage(makeMessage({ id: 9, text: serializeEnvelope(aliceEnv) }), 'mid-9@x', true);
    const sent: string[] = [];
    const transport = {
      message: async (id: number) => (id === 9 ? makeMessage({ id: 9, text: serializeEnvelope(aliceEnv) }) : null),
      sendControlDm: async (_id: number, text: string) => {
        sent.push(text);
      },
    } as unknown as Transport;

    const req = contactMsg(buildEnvelopeRequest([{ u: AU, addr: ALICE }]));
    const handled = await handleBackfillControlDm(store, bf, transport, req, false, 1, () => true);
    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(parseEnvelope(sent[0]!)?.type).toBe('envelope-bundle');
  });

  it('does not serve when the rate limiter blocks', async () => {
    const { bf } = makeBackfiller();
    const sent: string[] = [];
    const transport = { message: async () => null, sendControlDm: async (_i: number, t: string) => { sent.push(t); } } as unknown as Transport;
    const req = contactMsg(buildEnvelopeRequest([{ u: AU, addr: ALICE }]));
    const handled = await handleBackfillControlDm(store, bf, transport, req, false, 1, () => false);
    expect(handled).toBe(true); // still a backfill DM (suppression applies)
    expect(sent).toHaveLength(0);
  });

  it('processes an envelope-bundle DM (held stored, no notifications)', async () => {
    const { bf } = makeBackfiller();
    const transport = { message: async () => null, sendControlDm: async () => {} } as unknown as Transport;
    const bundle = contactMsg(buildEnvelopeBundle([signAlice(buildPostObject('held', AU))]));
    const handled = await handleBackfillControlDm(store, bf, transport, bundle, false, 5, () => true);
    expect(handled).toBe(true);
    expect(store.heldEnvelope(AU)?.env.text).toBe('held');
    // Suppression: no notifications produced by backfill processing.
    expect(store.listNotifications({})).toHaveLength(0);
  });

  it('ignores a feed-chat message (control DMs are DM-only) and non-backfill DMs', async () => {
    const { bf } = makeBackfiller();
    const transport = { message: async () => null, sendControlDm: async () => {} } as unknown as Transport;
    const req = contactMsg(buildEnvelopeRequest([{ u: AU, addr: ALICE }]));
    expect(await handleBackfillControlDm(store, bf, transport, req, true, 1, () => true)).toBe(false);
    const plain = contactMsg(serializeEnvelope(buildPostObject('hi', AU)));
    expect(await handleBackfillControlDm(store, bf, transport, plain, false, 1, () => true)).toBe(false);
  });
});

describe('seedBackfillQueue', () => {
  it('seeds transitive refs from existing held envelopes at startup', () => {
    const { bf } = makeBackfiller();
    // A held reply whose parent RU is not held → seed should enqueue RU.
    store.addHeldEnvelope(signAlice(buildReplyObject('r', AU, { u: RU, addr: ALICE })), BOB, 22, ALICE, 1);
    seedBackfillQueue(store, bf);
    expect(bf.pendingFor(BOB)).toContain(RU);
  });
});

describe('self-served-bundle pin rule (key confirmation)', () => {
  it('pins the SENDER when a bundle item verifies against their own address', () => {
    const own = signAlice(buildPostObject('my own post, served by me', AU));
    const bundle = parseEnvelope(buildEnvelopeBundle([own]))!;
    expect(store.pinnedKey(ALICE)).toBeNull();
    processBundle(store, makeBackfiller().bf, ALICE, 7, bundle, 1000);
    expect(store.pinnedKey(ALICE)).toBe(own.pubkey);
  });

  it('never pins from RELAYED items (author != sender)', () => {
    const alicePost = signAlice(buildPostObject('alice post relayed by bob', AU));
    const bundle = parseEnvelope(buildEnvelopeBundle([alicePost]))!;
    processBundle(store, makeBackfiller().bf, BOB, 22, bundle, 1000);
    expect(store.pinnedKey(ALICE)).toBeNull();
    expect(store.pinnedKey(BOB)).toBeNull();
  });

  it('never overwrites an existing pin (first-wins, like direct deliveries)', () => {
    store.pinKey(ALICE, 'EXISTING_PIN');
    const own = signAlice(buildPostObject('later self-serve', AU));
    processBundle(store, makeBackfiller().bf, ALICE, 7, parseEnvelope(buildEnvelopeBundle([own]))!, 1000);
    expect(store.pinnedKey(ALICE)).toBe('EXISTING_PIN');
  });
});

describe('leak prevention: serve refusal on the wire marker', () => {
  it('never serves a private-marked envelope (local or held)', async () => {
    const marked = signAlice({ ...buildPostObject('their locked post', AU), visibility: 'private' as const });
    store.ingestMessage(makeMessage({ id: 9, text: serializeEnvelope(marked) }), 'mid-9@x', true);
    const transport = makeTransport(new Map([[9, serializeEnvelope(marked)]]));
    expect(await buildServeBundles(store, transport, [{ u: AU, addr: ALICE }])).toEqual([]);

    const heldUuid = 'cccc0000-1111-4222-8333-444444444444';
    store.addHeldEnvelope(
      signAlice({ ...buildPostObject('held locked', heldUuid), visibility: 'private' as const }),
      BOB, 22, ALICE, 1,
    );
    expect(await buildServeBundles(store, transport, [{ u: heldUuid, addr: ALICE }])).toEqual([]);
  });

  it('never serves or holds direct-marked envelopes', async () => {
    const directUuid = 'dddd0000-1111-4222-8333-444444444444';
    const direct = signAlice({ ...buildPostObject('direct post', directUuid), visibility: 'direct' as const });
    store.ingestMessage(makeMessage({ id: 10, text: serializeEnvelope(direct) }), 'mid-10@x', false);
    const transport = makeTransport(new Map([[10, serializeEnvelope(direct)]]));
    expect(await buildServeBundles(store, transport, [{ u: directUuid, addr: ALICE }])).toEqual([]);

    const heldUuid = 'eeee0000-1111-4222-8333-444444444444';
    const heldDirect = signAlice({ ...buildPostObject('held direct', heldUuid), visibility: 'direct' as const });
    processBundle(
      store,
      makeBackfiller().bf,
      BOB,
      22,
      parseEnvelope(buildEnvelopeBundle([heldDirect]))!,
      1000,
    );
    expect(store.heldEnvelope(heldUuid)).toBeNull();
  });
});
