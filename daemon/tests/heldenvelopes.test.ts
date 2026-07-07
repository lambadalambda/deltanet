import { describe, expect, it } from 'vitest';
import { openAttestor } from '../src/attest.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  danglingTargets,
  heldDanglingTargets,
  storableBundleItem,
  verifyHeld,
} from '../src/heldenvelopes.js';
import {
  buildPostObject,
  buildReplyObject,
  buildBoostObject,
  serializeEnvelope,
  type Envelope,
} from '../src/envelope.js';

const ALICE = 'alice@relay.example';
const BOB = 'bob@relay.example';
const AU = 'aaaa1111-2222-4333-8444-555555555555';
const PARENT = 'pppp1111-2222-4333-8444-555555555555';
const ROOT = 'rrrr1111-2222-4333-8444-555555555555';

const never = () => false;
const always = () => true;

describe('danglingTargets: unresolved uuid refs of a message', () => {
  it('surfaces a reply parent + root uuid, attributed to their ref addrs', () => {
    const reply = serializeEnvelope(
      buildReplyObject('hi', AU, { u: PARENT, addr: ALICE }, undefined, { u: ROOT, addr: 'root@x' }),
    );
    const targets = danglingTargets(reply, BOB, never);
    expect(targets).toContainEqual({ uuid: PARENT, peer: BOB, authorAddr: ALICE });
    expect(targets).toContainEqual({ uuid: ROOT, peer: BOB, authorAddr: 'root@x' });
  });

  it('surfaces a boost target uuid', () => {
    const boost = serializeEnvelope(buildBoostObject(AU, { u: PARENT, addr: ALICE }));
    expect(danglingTargets(boost, BOB, never)).toContainEqual({ uuid: PARENT, peer: BOB, authorAddr: ALICE });
  });

  it('skips refs that already resolve (not dangling)', () => {
    const reply = serializeEnvelope(buildReplyObject('hi', AU, { u: PARENT, addr: ALICE }));
    expect(danglingTargets(reply, BOB, always)).toEqual([]);
  });

  it('skips legacy mid refs (not requestable) and plain posts', () => {
    const midReply = serializeEnvelope(buildReplyObject('hi', AU, { mid: 'x@y', addr: ALICE }));
    expect(danglingTargets(midReply, BOB, never)).toEqual([]);
    expect(danglingTargets(serializeEnvelope(buildPostObject('plain', AU)), BOB, never)).toEqual([]);
  });

  it('dedupes when reply and root point at the same uuid', () => {
    const reply = serializeEnvelope(
      buildReplyObject('hi', AU, { u: PARENT, addr: ALICE }, undefined, { u: PARENT, addr: ALICE }),
    );
    expect(danglingTargets(reply, BOB, never)).toHaveLength(1);
  });
});

describe('heldDanglingTargets: transitive refs of a held envelope', () => {
  it('chases a held reply parent + root', () => {
    const held: Envelope = buildReplyObject('r', AU, { u: PARENT, addr: ALICE }, undefined, { u: ROOT, addr: 'root@x' });
    const targets = heldDanglingTargets(held, BOB, never);
    expect(targets).toContainEqual({ uuid: PARENT, peer: BOB, authorAddr: ALICE });
    expect(targets).toContainEqual({ uuid: ROOT, peer: BOB, authorAddr: 'root@x' });
  });
});

describe('storableBundleItem: only signed content envelopes', () => {
  const sign = (env: Envelope): Envelope => ({ ...env, ts: 1, pubkey: 'PK', sig: 'SIG' });
  it('accepts a signed post/reply/boost with a uuid', () => {
    expect(storableBundleItem(sign(buildPostObject('x', AU)))).not.toBeNull();
    expect(storableBundleItem(sign(buildReplyObject('x', AU, { u: PARENT, addr: ALICE })))).not.toBeNull();
  });
  it('rejects an unsigned envelope', () => {
    expect(storableBundleItem(buildPostObject('x', AU))).toBeNull();
  });
  it('rejects a control envelope and a uuid-less one', () => {
    expect(storableBundleItem({ dn: 2, type: 'react', emoji: '❤', sig: 'S', pubkey: 'P', ts: 1 } as Envelope)).toBeNull();
    expect(storableBundleItem({ dn: 2, type: 'post', text: 'x', ts: 1, pubkey: 'P', sig: 'S' } as Envelope)).toBeNull();
  });
});

describe('verifyHeld: render-time ladder (sig + pin consistency)', () => {
  let dir: string;
  const withAttestor = <T>(fn: (a: ReturnType<typeof openAttestor>) => T): T => {
    dir = mkdtempSync(join(tmpdir(), 'held-verify-'));
    try {
      return fn(openAttestor(join(dir, 'key.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('accepts a validly-signed envelope with no conflicting pin', () => {
    withAttestor((a) => {
      const env = buildPostObject('signed', AU);
      const signed: Envelope = { ...env, ...a.sign(env, ALICE) };
      expect(verifyHeld(signed, ALICE, () => null)).toBe(true);
    });
  });

  it('rejects a tampered envelope (body changed after signing)', () => {
    withAttestor((a) => {
      const env = buildPostObject('signed', AU);
      const signed: Envelope = { ...env, ...a.sign(env, ALICE) };
      const tampered: Envelope = { ...signed, text: 'HACKED' };
      expect(verifyHeld(tampered, ALICE, () => null)).toBe(false);
    });
  });

  it('rejects when a pinned key disagrees with the envelope pubkey (impersonation)', () => {
    withAttestor((a) => {
      const env = buildPostObject('signed', AU);
      const signed: Envelope = { ...env, ...a.sign(env, ALICE) };
      expect(verifyHeld(signed, ALICE, () => 'A-DIFFERENT-PINNED-KEY')).toBe(false);
    });
  });
});
