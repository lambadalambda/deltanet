import { describe, expect, it } from 'vitest';
import {
  buildBoostText,
  buildInviteGrantText,
  buildInviteRequestText,
  buildPostText,
  buildQuotedText,
  buildReactionText,
  buildRefToken,
  buildReplyText,
  buildUnreactionText,
  mintPostUuid,
  parseCanonicalMid,
  parseInviteGrant,
  parseInviteRequest,
  parseMarkers,
  parsePostUuid,
  parseQuotedAuthor,
  parseReaction,
  parseRefToken,
  refFromToken,
  type RefToken,
} from '../src/protocol.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MID = 'abc123@nine.testrun.org';
const ADDR = 'bob@nine.testrun.org';
// A ref targeting a legacy mid (a target that never minted a uuid).
const MID_REF = refFromToken({ kind: 'mid', mid: MID }, ADDR);
// A ref targeting a uuid post.
const UUID_REF = refFromToken({ kind: 'uuid', uuid: UUID }, ADDR);

describe('ref token discrimination (buildRefToken / parseRefToken)', () => {
  it('serializes a uuid ref with a u: prefix', () => {
    expect(buildRefToken({ kind: 'uuid', uuid: UUID })).toBe(`u:${UUID}`);
  });

  it('serializes a mid ref bare', () => {
    expect(buildRefToken({ kind: 'mid', mid: MID })).toBe(MID);
  });

  it('round-trips a uuid ref', () => {
    expect(parseRefToken(`u:${UUID}`)).toEqual({ kind: 'uuid', uuid: UUID });
  });

  it('round-trips a mid ref (mids contain @, never a u: prefix)', () => {
    expect(parseRefToken(MID)).toEqual({ kind: 'mid', mid: MID });
  });

  it('refFromToken exposes the opaque key string for the store', () => {
    expect(UUID_REF.keyString).toBe(UUID);
    expect(MID_REF.keyString).toBe(MID);
  });
});

describe('mintPostUuid / parsePostUuid', () => {
  it('mints a distinct uuid each call', () => {
    expect(mintPostUuid()).not.toBe(mintPostUuid());
  });

  it('parses the trailing ⚑ marker of a plain post', () => {
    expect(parsePostUuid(buildPostText('hi', UUID))).toBe(UUID);
  });

  it('returns null for a message with no ⚑ marker (legacy / vanilla DC)', () => {
    expect(parsePostUuid('just a normal post')).toBeNull();
    expect(parsePostUuid('')).toBeNull();
  });

  it('ignores a ⚑-shaped line that is not the final line', () => {
    expect(parsePostUuid(`⚑ ${UUID}\nmore text after`)).toBeNull();
  });
});

describe('buildPostText / parseMarkers (plain post uuid marker)', () => {
  it('appends a ⚑ uuid marker as the final line', () => {
    expect(buildPostText('hello there', UUID)).toBe(`hello there\n⚑ ${UUID}`);
  });

  it('a media-only (empty body) post is just the marker line', () => {
    expect(buildPostText('', UUID)).toBe(`⚑ ${UUID}`);
  });

  it('parseMarkers strips the uuid line from the body and exposes the uuid', () => {
    const parsed = parseMarkers(buildPostText('line one\nline two', UUID));
    expect(parsed.body).toBe('line one\nline two');
    expect(parsed.uuid).toBe(UUID);
    expect(parsed.reply).toBeUndefined();
    expect(parsed.boost).toBeUndefined();
  });
});

describe('buildReplyText / parseMarkers (reply round-trip)', () => {
  it('appends a reply marker then a ⚑ uuid line (mid ref, bare token)', () => {
    const text = buildReplyText('hello there', MID_REF, UUID);
    expect(text).toBe(`hello there\n\n↳re ${MID} ${ADDR}\n⚑ ${UUID}`);
  });

  it('appends a u:-prefixed token when the reply targets a uuid post', () => {
    const text = buildReplyText('hello there', UUID_REF, OTHER_UUID);
    expect(text).toBe(`hello there\n\n↳re u:${UUID} ${ADDR}\n⚑ ${OTHER_UUID}`);
  });

  it('round-trips: parseMarkers recovers the body, reply ref, and this reply\'s own uuid', () => {
    const text = buildReplyText('hello there', MID_REF, UUID);
    const parsed = parseMarkers(text);
    expect(parsed.body).toBe('hello there');
    expect(parsed.reply).toEqual(MID_REF);
    expect(parsed.uuid).toBe(UUID);
    expect(parsed.boost).toBeUndefined();
  });

  it('round-trips a uuid-targeting reply ref', () => {
    const parsed = parseMarkers(buildReplyText('hi', UUID_REF, OTHER_UUID));
    expect(parsed.reply).toEqual(UUID_REF);
    expect(parsed.reply?.key).toEqual({ kind: 'uuid', uuid: UUID });
    expect(parsed.uuid).toBe(OTHER_UUID);
  });

  it('round-trips multi-line bodies', () => {
    const text = buildReplyText('line one\nline two', MID_REF, UUID);
    const parsed = parseMarkers(text);
    expect(parsed.body).toBe('line one\nline two');
    expect(parsed.reply).toEqual(MID_REF);
  });
});

describe('buildBoostText / parseMarkers (boost round-trip)', () => {
  it('is the boost marker then a ⚑ uuid line, no body', () => {
    const text = buildBoostText(MID_REF, UUID);
    expect(text).toBe(`♻ ${MID} ${ADDR}\n⚑ ${UUID}`);
  });

  it('round-trips: parseMarkers recovers the boost ref, empty body, and the boost\'s own uuid', () => {
    const text = buildBoostText(MID_REF, UUID);
    const parsed = parseMarkers(text);
    expect(parsed.body).toBe('');
    expect(parsed.boost).toEqual(MID_REF);
    expect(parsed.uuid).toBe(UUID);
    expect(parsed.reply).toBeUndefined();
  });

  it('round-trips a uuid-targeting boost ref', () => {
    const parsed = parseMarkers(buildBoostText(UUID_REF, OTHER_UUID));
    expect(parsed.boost).toEqual(UUID_REF);
    expect(parsed.uuid).toBe(OTHER_UUID);
  });
});

describe('parseMarkers tolerance', () => {
  it('treats plain text with no marker as a plain body', () => {
    const parsed = parseMarkers('just a normal post');
    expect(parsed).toEqual({ body: 'just a normal post' });
  });

  it('does not treat a reply-marker-shaped line in the middle of text as a marker', () => {
    const text = 'look at this:\n↳re abc123@nine.testrun.org bob@nine.testrun.org\nmore stuff after';
    const parsed = parseMarkers(text);
    expect(parsed).toEqual({ body: text });
  });

  it('does not treat a boost-marker-shaped prefix as a marker unless it (plus its uuid line) is the whole text', () => {
    const text = '♻ abc123@nine.testrun.org bob@nine.testrun.org\nplus extra commentary';
    const parsed = parseMarkers(text);
    expect(parsed).toEqual({ body: text });
  });

  it('ignores malformed reply marker lines (missing addr)', () => {
    const text = 'hello\n\n↳re onlymid';
    const parsed = parseMarkers(text);
    expect(parsed).toEqual({ body: text });
  });

  it('ignores malformed boost marker (missing addr)', () => {
    const parsed = parseMarkers('♻ onlymid');
    expect(parsed).toEqual({ body: '♻ onlymid' });
  });

  it('handles empty string', () => {
    expect(parseMarkers('')).toEqual({ body: '' });
  });

  it('does not choke on a mid or addr containing no spaces but odd chars', () => {
    const ref = refFromToken({ kind: 'mid', mid: '<weird+id.123@sub.nine.testrun.org>' }, 'a.b+tag@nine.testrun.org');
    const text = buildReplyText('body text', ref, UUID);
    const parsed = parseMarkers(text);
    expect(parsed.body).toBe('body text');
    expect(parsed.reply).toEqual(ref);
    expect(parsed.uuid).toBe(UUID);
  });
});

describe('buildReactionText / parseReaction (reaction round-trip)', () => {
  const MID_TOKEN: RefToken = { kind: 'mid', mid: MID };
  const UUID_TOKEN: RefToken = { kind: 'uuid', uuid: UUID };

  it('builds "<emoji> ↳ <mid>" for a mid target', () => {
    expect(buildReactionText('❤', MID_TOKEN)).toBe(`❤ ↳ ${MID}`);
  });

  it('builds a u:-prefixed token for a uuid target', () => {
    expect(buildReactionText('❤', UUID_TOKEN)).toBe(`❤ ↳ u:${UUID}`);
  });

  it('round-trips: parseReaction recovers the emoji, ref, and kind (mid)', () => {
    expect(parseReaction(buildReactionText('❤', MID_TOKEN))).toEqual({
      kind: 'react',
      emoji: '❤',
      ref: MID_TOKEN,
    });
  });

  it('round-trips a uuid-targeting reaction', () => {
    expect(parseReaction(buildReactionText('🎉', UUID_TOKEN))).toEqual({
      kind: 'react',
      emoji: '🎉',
      ref: UUID_TOKEN,
    });
  });
});

describe('buildUnreactionText / parseReaction (unreaction round-trip)', () => {
  const MID_TOKEN: RefToken = { kind: 'mid', mid: MID };
  const UUID_TOKEN: RefToken = { kind: 'uuid', uuid: UUID };

  it('builds "✖ ↳ <mid> <emoji>"', () => {
    expect(buildUnreactionText('❤', MID_TOKEN)).toBe(`✖ ↳ ${MID} ❤`);
  });

  it('round-trips: parseReaction recovers the emoji, ref, and kind (mid)', () => {
    expect(parseReaction(buildUnreactionText('❤', MID_TOKEN))).toEqual({
      kind: 'unreact',
      emoji: '❤',
      ref: MID_TOKEN,
    });
  });

  it('round-trips a uuid-targeting unreaction', () => {
    expect(parseReaction(buildUnreactionText('❤', UUID_TOKEN))).toEqual({
      kind: 'unreact',
      emoji: '❤',
      ref: UUID_TOKEN,
    });
  });
});

describe('parseReaction tolerance', () => {
  it('returns null for plain text', () => {
    expect(parseReaction('just a normal message')).toBeNull();
  });

  it('returns null for a multi-line reaction-shaped text (single-line only)', () => {
    expect(parseReaction('❤ ↳ abc123@nine.testrun.org\nextra line')).toBeNull();
  });

  it('returns null for a multi-line unreaction-shaped text (single-line only)', () => {
    expect(parseReaction('✖ ↳ abc123@nine.testrun.org ❤\nextra line')).toBeNull();
  });

  it('returns null for a malformed reaction (missing token)', () => {
    expect(parseReaction('❤ ↳ ')).toBeNull();
  });

  it('returns null for a malformed unreaction (missing emoji)', () => {
    expect(parseReaction('✖ ↳ abc123@nine.testrun.org')).toBeNull();
  });

  it('handles empty string', () => {
    expect(parseReaction('')).toBeNull();
  });
});

describe('buildInviteRequestText / parseInviteRequest (invite-request round-trip)', () => {
  it('builds the human-readable "⇋ invite-request" marker', () => {
    expect(buildInviteRequestText()).toBe('⇋ invite-request');
  });

  it('round-trips: parseInviteRequest recognizes the exact marker', () => {
    expect(parseInviteRequest(buildInviteRequestText())).toBe(true);
  });

  it('tolerates trailing text after the marker on the first line', () => {
    expect(parseInviteRequest('⇋ invite-request (please let me follow you!)')).toBe(true);
  });

  it('tolerates the marker as the first line of a multi-line message', () => {
    expect(parseInviteRequest('⇋ invite-request\nsent by deltanet')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(parseInviteRequest('just a normal message')).toBe(false);
  });

  it('returns false when the marker is not at the start of the line', () => {
    expect(parseInviteRequest('please: ⇋ invite-request')).toBe(false);
  });

  it('does not confuse an invite grant for an invite request', () => {
    expect(parseInviteRequest(buildInviteGrantText('https://i.delta.chat/#FOO'))).toBe(false);
  });

  it('handles empty string', () => {
    expect(parseInviteRequest('')).toBe(false);
  });
});

describe('buildInviteGrantText / parseInviteGrant (invite-grant round-trip)', () => {
  const HTTPS_LINK = 'https://i.delta.chat/#FOO&a=b';
  const FPR_LINK = 'OPENPGP4FPR:ABCDEF#a=b';

  it('builds "⇋ invite <link>"', () => {
    expect(buildInviteGrantText(HTTPS_LINK)).toBe(`⇋ invite ${HTTPS_LINK}`);
  });

  it('round-trips an https i.delta.chat invite link', () => {
    expect(parseInviteGrant(buildInviteGrantText(HTTPS_LINK))).toBe(HTTPS_LINK);
  });

  it('round-trips an OPENPGP4FPR invite link', () => {
    expect(parseInviteGrant(buildInviteGrantText(FPR_LINK))).toBe(FPR_LINK);
  });

  it('returns null for plain text', () => {
    expect(parseInviteGrant('just a normal message')).toBeNull();
  });

  it('returns null when the link does not look like an invite', () => {
    expect(parseInviteGrant('⇋ invite https://evil.example.org/phish')).toBeNull();
  });

  it('returns null for a grant with no link', () => {
    expect(parseInviteGrant('⇋ invite')).toBeNull();
    expect(parseInviteGrant('⇋ invite ')).toBeNull();
  });

  it('does not confuse an invite request for an invite grant', () => {
    expect(parseInviteGrant(buildInviteRequestText())).toBeNull();
  });

  it('handles empty string', () => {
    expect(parseInviteGrant('')).toBeNull();
  });
});

describe('legacy canonical-mid marker (parse-only; no longer emitted)', () => {
  // v1 stops emitting the `⚓` canonical marker (the shared `⚑` uuid subsumes
  // it) but must still PARSE it for pre-v1 data on migrated stores.
  const CANON = 'feed-copy-mid@nine.testrun.org';
  const legacyDmCopy = `hello there\n\n↳re ${MID} ${ADDR}\n⚓ ${CANON}`;

  it('parseCanonicalMid recovers the canonical mid from a legacy DM reply copy', () => {
    expect(parseCanonicalMid(legacyDmCopy)).toBe(CANON);
  });

  it('parseMarkers still recovers the body and reply ref from a legacy canonical DM copy', () => {
    const parsed = parseMarkers(`hello there\nsecond line\n\n↳re ${MID} ${ADDR}\n⚓ ${CANON}`);
    expect(parsed.body).toBe('hello there\nsecond line');
    expect(parsed.reply).toEqual(MID_REF);
    expect(parsed.uuid).toBeUndefined();
  });

  it('parseCanonicalMid returns null when there is no canonical marker', () => {
    expect(parseCanonicalMid(buildReplyText('plain reply', MID_REF, UUID))).toBeNull();
    expect(parseCanonicalMid('just a normal post')).toBeNull();
    expect(parseCanonicalMid('')).toBeNull();
  });

  it('parseCanonicalMid ignores a marker-shaped line that is not the final line', () => {
    expect(parseCanonicalMid(`⚓ ${CANON}\nmore text after`)).toBeNull();
  });

  it('parseCanonicalMid ignores a malformed marker (empty mid)', () => {
    expect(parseCanonicalMid('body\n\n↳re m a\n⚓ ')).toBeNull();
    expect(parseCanonicalMid('body\n\n↳re m a\n⚓ has space')).toBeNull();
  });
});

describe('buildQuotedText / parseQuotedAuthor', () => {
  it('builds "<authorName>: <capped text>"', () => {
    expect(buildQuotedText('alice', 'hello world', 120)).toBe('alice: hello world');
  });

  it('caps the text at the given length with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const quoted = buildQuotedText('alice', long, 120);
    expect(quoted.startsWith('alice: ')).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual('alice: '.length + 120 + 1); // +1 for the ellipsis char
  });

  it('parseQuotedAuthor recovers the author and text (best-effort)', () => {
    const quoted = buildQuotedText('alice', 'hello world', 120);
    expect(parseQuotedAuthor(quoted)).toEqual({ authorName: 'alice', text: 'hello world' });
  });

  it('parseQuotedAuthor falls back when there is no "name: " prefix', () => {
    expect(parseQuotedAuthor('just some text')).toEqual({
      authorName: null,
      text: 'just some text',
    });
  });

  it('parseQuotedAuthor handles a colon inside the text without a real author prefix gracefully', () => {
    // "authorName: text" pattern requires a short-ish name before the first colon;
    // best-effort: this is ambiguous, but should not throw and should return *something* sane.
    const result = parseQuotedAuthor('note: remember to buy milk');
    expect(result.text).toContain('remember to buy milk');
  });

  it('round-trips through build/parse', () => {
    const quoted = buildQuotedText('Bob Ross', 'happy little trees', 500);
    expect(parseQuotedAuthor(quoted)).toEqual({ authorName: 'Bob Ross', text: 'happy little trees' });
  });
});
