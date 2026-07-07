import { describe, expect, it } from 'vitest';
import {
  DN_VERSION,
  buildBoostEnvelope,
  buildInviteGrantEnvelope,
  buildInviteRequestEnvelope,
  buildPostEnvelope,
  buildReactEnvelope,
  buildReplyEnvelope,
  buildUnreactEnvelope,
  envelopeRefKeyString,
  envelopeRefToken,
  mintUuid,
  parseEnvelope,
  refTokenToEnvelopeRef,
  type EnvelopeRef,
} from '../src/envelope.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const PARENT_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MID = 'abc123@nine.testrun.org';
const ADDR = 'bob@nine.testrun.org';

describe('envelope version + type', () => {
  it('emits dn:2', () => {
    expect(parseEnvelope(buildPostEnvelope('hi', UUID))?.dn).toBe(DN_VERSION);
    expect(DN_VERSION).toBe(2);
  });
});

describe('post envelope round-trip', () => {
  it('carries type, uuid, text', () => {
    const env = parseEnvelope(buildPostEnvelope('hello world', UUID));
    expect(env).toMatchObject({ dn: 2, type: 'post', uuid: UUID, text: 'hello world' });
    expect(env?.ref).toBeUndefined();
  });

  it('carries media.description when alt text is present', () => {
    const env = parseEnvelope(buildPostEnvelope('cat', UUID, { description: 'a cat' }));
    expect(env?.media?.description).toBe('a cat');
  });

  it('omits media when description is null/absent', () => {
    expect(parseEnvelope(buildPostEnvelope('x', UUID, { description: null }))?.media).toBeUndefined();
    expect(parseEnvelope(buildPostEnvelope('x', UUID))?.media).toBeUndefined();
  });

  it('round-trips a body that itself looks like a legacy marker', () => {
    const env = parseEnvelope(buildPostEnvelope('♻ hello', UUID));
    expect(env?.text).toBe('♻ hello');
    expect(env?.type).toBe('post');
  });
});

describe('reply envelope round-trip', () => {
  it('carries a uuid ref parent', () => {
    const ref: EnvelopeRef = { u: PARENT_UUID, addr: ADDR };
    const env = parseEnvelope(buildReplyEnvelope('nice', UUID, ref));
    expect(env).toMatchObject({ type: 'reply', uuid: UUID, text: 'nice' });
    expect(env?.ref).toEqual(ref);
    expect(envelopeRefKeyString(env!.ref!)).toBe(PARENT_UUID);
  });

  it('carries a legacy mid ref parent', () => {
    const ref: EnvelopeRef = { mid: MID, addr: ADDR };
    const env = parseEnvelope(buildReplyEnvelope('re', UUID, ref));
    expect(env?.ref).toEqual(ref);
    expect(envelopeRefKeyString(env!.ref!)).toBe(MID);
  });
});

describe('boost envelope round-trip', () => {
  it('carries a ref but never embeds original content', () => {
    const ref: EnvelopeRef = { u: PARENT_UUID, addr: ADDR };
    const env = parseEnvelope(buildBoostEnvelope(UUID, ref));
    expect(env).toMatchObject({ type: 'boost', uuid: UUID });
    expect(env?.ref).toEqual(ref);
    expect(env?.text).toBeUndefined();
  });
});

describe('react / unreact envelope round-trip', () => {
  it('carries emoji + ref', () => {
    const ref: EnvelopeRef = { u: PARENT_UUID, addr: ADDR };
    expect(parseEnvelope(buildReactEnvelope('❤', ref))).toMatchObject({
      type: 'react',
      emoji: '❤',
    });
    expect(parseEnvelope(buildUnreactEnvelope('👍', ref))).toMatchObject({
      type: 'unreact',
      emoji: '👍',
    });
  });
});

describe('invite control envelopes', () => {
  it('round-trips invite-request', () => {
    expect(parseEnvelope(buildInviteRequestEnvelope())?.type).toBe('invite-request');
  });

  it('round-trips invite-grant with the link', () => {
    const env = parseEnvelope(buildInviteGrantEnvelope('https://i.delta.chat/#abc'));
    expect(env).toMatchObject({ type: 'invite-grant', link: 'https://i.delta.chat/#abc' });
  });
});

describe('ref token <-> envelope ref', () => {
  it('serializes a uuid token', () => {
    expect(refTokenToEnvelopeRef({ kind: 'uuid', uuid: UUID }, ADDR)).toEqual({ u: UUID, addr: ADDR });
  });

  it('serializes a mid token', () => {
    expect(refTokenToEnvelopeRef({ kind: 'mid', mid: MID }, ADDR)).toEqual({ mid: MID, addr: ADDR });
  });

  it('recovers a uuid token', () => {
    expect(envelopeRefToken({ u: UUID, addr: ADDR })).toEqual({ kind: 'uuid', uuid: UUID });
  });

  it('recovers a mid token', () => {
    expect(envelopeRefToken({ mid: MID, addr: ADDR })).toEqual({ kind: 'mid', mid: MID });
  });
});

describe('strict dn===2 gate + malformed handling', () => {
  it('rejects a wrong dn version', () => {
    expect(parseEnvelope('{"dn":1,"type":"post","text":"x"}')).toBeNull();
    expect(parseEnvelope('{"dn":3,"type":"post","text":"x"}')).toBeNull();
  });

  it('rejects a missing dn', () => {
    expect(parseEnvelope('{"type":"post","text":"x"}')).toBeNull();
  });

  it('rejects an unknown type', () => {
    expect(parseEnvelope('{"dn":2,"type":"poll","text":"x"}')).toBeNull();
  });

  it('treats malformed JSON as non-envelope (null)', () => {
    expect(parseEnvelope('{not json')).toBeNull();
    expect(parseEnvelope('hello there')).toBeNull();
    expect(parseEnvelope('')).toBeNull();
    expect(parseEnvelope('   ')).toBeNull();
  });

  it('rejects a JSON array or scalar', () => {
    expect(parseEnvelope('[1,2,3]')).toBeNull();
    expect(parseEnvelope('42')).toBeNull();
    expect(parseEnvelope('"a string"')).toBeNull();
  });

  it('ignores unknown fields (forward-compat) while keeping known ones', () => {
    const env = parseEnvelope('{"dn":2,"type":"post","text":"hi","uuid":"' + UUID + '","future":123}');
    expect(env).toMatchObject({ type: 'post', text: 'hi', uuid: UUID });
  });

  it('never emits reserved pubkey/sig fields', () => {
    for (const wire of [
      buildPostEnvelope('x', UUID),
      buildReplyEnvelope('x', UUID, { u: PARENT_UUID, addr: ADDR }),
      buildBoostEnvelope(UUID, { u: PARENT_UUID, addr: ADDR }),
      buildReactEnvelope('❤', { u: PARENT_UUID, addr: ADDR }),
      buildInviteGrantEnvelope('https://i.delta.chat/#a'),
    ]) {
      expect(wire).not.toContain('pubkey');
      expect(wire).not.toContain('sig');
    }
  });

  it('tolerates pretty-printed JSON', () => {
    const pretty = JSON.stringify({ dn: 2, type: 'post', uuid: UUID, text: 'hi' }, null, 2);
    expect(parseEnvelope(pretty)).toMatchObject({ type: 'post', text: 'hi' });
  });
});

describe('mintUuid', () => {
  it('mints distinct uuids', () => {
    expect(mintUuid()).not.toBe(mintUuid());
  });
});
