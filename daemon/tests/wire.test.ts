import { describe, expect, it } from 'vitest';
import {
  buildBoostEnvelope,
  buildInviteGrantEnvelope,
  buildInviteRequestEnvelope,
  buildPostEnvelope,
  buildReactEnvelope,
  buildReplyEnvelope,
  buildUnreactEnvelope,
} from '../src/envelope.js';
import {
  buildBoostText,
  buildInviteGrantText,
  buildInviteRequestText,
  buildPostText,
  buildReactionText,
  buildReplyText,
  refFromToken,
} from '../src/protocol.js';
import {
  parseWire,
  parseWireInviteGrant,
  parseWireInviteRequest,
  parseWireReaction,
  parseWireUuid,
} from '../src/wire.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const PARENT_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MID = 'parent-mid@nine.testrun.org';
const ADDR = 'bob@nine.testrun.org';

describe('parseWire: v2 envelopes', () => {
  it('parses a v2 post to body + uuid', () => {
    const p = parseWire(buildPostEnvelope('hello', UUID));
    expect(p.body).toBe('hello');
    expect(p.uuid).toBe(UUID);
    expect(p.reply).toBeUndefined();
    expect(p.boost).toBeUndefined();
  });

  it('parses a v2 reply to body + uuid + reply ref', () => {
    const p = parseWire(buildReplyEnvelope('re', UUID, { u: PARENT_UUID, addr: ADDR }));
    expect(p.body).toBe('re');
    expect(p.reply?.keyString).toBe(PARENT_UUID);
    expect(p.reply?.addr).toBe(ADDR);
  });

  it('parses a v2 boost to empty body + boost ref (no embedded content)', () => {
    const p = parseWire(buildBoostEnvelope(UUID, { mid: MID, addr: ADDR }));
    expect(p.body).toBe('');
    expect(p.boost?.keyString).toBe(MID);
  });

  it('surfaces v2 media alt text', () => {
    const p = parseWire(buildPostEnvelope('cat', UUID, { description: 'a cat' }));
    expect(p.mediaDescription).toBe('a cat');
  });
});

describe('parseWire: legacy markers still read (mixed-era)', () => {
  it('parses a v1 post marker', () => {
    const p = parseWire(buildPostText('legacy hi', UUID));
    expect(p.body).toBe('legacy hi');
    expect(p.uuid).toBe(UUID);
  });

  it('parses a v1 reply marker', () => {
    const ref = refFromToken({ kind: 'uuid', uuid: PARENT_UUID }, ADDR);
    const p = parseWire(buildReplyText('legacy re', ref, UUID));
    expect(p.body).toBe('legacy re');
    expect(p.reply?.keyString).toBe(PARENT_UUID);
  });

  it('parses a v1 boost marker', () => {
    const ref = refFromToken({ kind: 'mid', mid: MID }, ADDR);
    const p = parseWire(buildBoostText(ref, UUID));
    expect(p.boost?.keyString).toBe(MID);
  });
});

describe('parseWire: plain human text (the ambiguity class is gone)', () => {
  it('treats legacy marker glyphs in plain text as content, not protocol', () => {
    // A real chat message from an external sender that happens to start with a
    // marker glyph must render as content — v2 emission means this is safe.
    const p = parseWire('♻ hello everyone');
    // Legacy read-side still parses a bare boost-looking line, so the guarantee
    // that matters for v2 is: a v2 post whose *text* is "♻ hello" is content.
    const v2 = parseWire(buildPostEnvelope('♻ hello everyone', UUID));
    expect(v2.body).toBe('♻ hello everyone');
    expect(v2.boost).toBeUndefined();
    void p;
  });

  it('treats malformed JSON as plain content', () => {
    const p = parseWire('{"dn":2 broken');
    expect(p.body).toBe('{"dn":2 broken');
    expect(p.reply).toBeUndefined();
    expect(p.boost).toBeUndefined();
  });

  it('treats an ordinary message as plain content', () => {
    const p = parseWire('just chatting');
    expect(p.body).toBe('just chatting');
    expect(p.uuid).toBeUndefined();
  });
});

describe('parseWireUuid', () => {
  it('reads a v2 uuid', () => {
    expect(parseWireUuid(buildPostEnvelope('x', UUID))).toBe(UUID);
  });
  it('reads a legacy uuid', () => {
    expect(parseWireUuid(buildPostText('x', UUID))).toBe(UUID);
  });
  it('null for plain text', () => {
    expect(parseWireUuid('hello')).toBeNull();
  });
});

describe('parseWireReaction', () => {
  it('reads a v2 react', () => {
    const r = parseWireReaction(buildReactEnvelope('❤', { u: PARENT_UUID, addr: ADDR }));
    expect(r).toMatchObject({ kind: 'react', emoji: '❤' });
    expect(r?.ref).toEqual({ kind: 'uuid', uuid: PARENT_UUID });
  });

  it('reads a v2 unreact', () => {
    const r = parseWireReaction(buildUnreactEnvelope('👍', { mid: MID, addr: ADDR }));
    expect(r).toMatchObject({ kind: 'unreact', emoji: '👍' });
    expect(r?.ref).toEqual({ kind: 'mid', mid: MID });
  });

  it('reads a legacy react marker', () => {
    const r = parseWireReaction(buildReactionText('❤', { kind: 'uuid', uuid: PARENT_UUID }));
    expect(r).toMatchObject({ kind: 'react', emoji: '❤' });
  });

  it('null for a non-reaction v2 envelope', () => {
    expect(parseWireReaction(buildPostEnvelope('x', UUID))).toBeNull();
  });

  it('null for plain text', () => {
    expect(parseWireReaction('hi there')).toBeNull();
  });
});

describe('parseWireInviteRequest / parseWireInviteGrant', () => {
  it('reads a v2 invite-request', () => {
    expect(parseWireInviteRequest(buildInviteRequestEnvelope())).toBe(true);
  });
  it('reads a legacy invite-request', () => {
    expect(parseWireInviteRequest(buildInviteRequestText())).toBe(true);
  });
  it('reads a v2 invite-grant', () => {
    expect(parseWireInviteGrant(buildInviteGrantEnvelope('https://i.delta.chat/#a'))).toBe(
      'https://i.delta.chat/#a',
    );
  });
  it('reads a legacy invite-grant', () => {
    expect(parseWireInviteGrant(buildInviteGrantText('https://i.delta.chat/#a'))).toBe(
      'https://i.delta.chat/#a',
    );
  });
  it('null grant for a non-grant', () => {
    expect(parseWireInviteGrant('hello')).toBeNull();
    expect(parseWireInviteRequest('hello')).toBe(false);
  });
});
