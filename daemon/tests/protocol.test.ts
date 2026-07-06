import { describe, expect, it } from 'vitest';
import {
  buildBoostText,
  buildInviteGrantText,
  buildInviteRequestText,
  buildQuotedText,
  buildReactionText,
  buildReplyText,
  buildReplyTextWithCanonical,
  buildUnreactionText,
  parseCanonicalMid,
  parseInviteGrant,
  parseInviteRequest,
  parseMarkers,
  parseQuotedAuthor,
  parseReaction,
} from '../src/protocol.js';

const REF = { mid: 'abc123@nine.testrun.org', addr: 'bob@nine.testrun.org' };

describe('buildReplyText / parseMarkers (reply round-trip)', () => {
  it('appends a reply marker as the final line', () => {
    const text = buildReplyText('hello there', REF);
    expect(text).toBe('hello there\n\n↳re abc123@nine.testrun.org bob@nine.testrun.org');
  });

  it('round-trips: parseMarkers recovers the body and reply ref', () => {
    const text = buildReplyText('hello there', REF);
    const parsed = parseMarkers(text);
    expect(parsed.body).toBe('hello there');
    expect(parsed.reply).toEqual(REF);
    expect(parsed.boost).toBeUndefined();
  });

  it('round-trips multi-line bodies', () => {
    const text = buildReplyText('line one\nline two', REF);
    const parsed = parseMarkers(text);
    expect(parsed.body).toBe('line one\nline two');
    expect(parsed.reply).toEqual(REF);
  });
});

describe('buildBoostText / parseMarkers (boost round-trip)', () => {
  it('is just the marker, no body', () => {
    const text = buildBoostText(REF);
    expect(text).toBe('♻ abc123@nine.testrun.org bob@nine.testrun.org');
  });

  it('round-trips: parseMarkers recovers the boost ref with empty body', () => {
    const text = buildBoostText(REF);
    const parsed = parseMarkers(text);
    expect(parsed.body).toBe('');
    expect(parsed.boost).toEqual(REF);
    expect(parsed.reply).toBeUndefined();
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

  it('does not treat a boost-marker-shaped prefix as a marker unless it is the whole text', () => {
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
    const ref = { mid: '<weird+id.123@sub.nine.testrun.org>', addr: 'a.b+tag@nine.testrun.org' };
    const text = buildReplyText('body text', ref);
    expect(parseMarkers(text)).toEqual({ body: 'body text', reply: ref });
  });
});

describe('buildReactionText / parseReaction (reaction round-trip)', () => {
  it('builds "<emoji> ↳ <mid>"', () => {
    expect(buildReactionText('❤', REF.mid)).toBe('❤ ↳ abc123@nine.testrun.org');
  });

  it('round-trips: parseReaction recovers the emoji, mid, and kind', () => {
    const text = buildReactionText('❤', REF.mid);
    expect(parseReaction(text)).toEqual({ kind: 'react', emoji: '❤', mid: REF.mid });
  });

  it('round-trips a non-heart emoji', () => {
    const text = buildReactionText('🎉', REF.mid);
    expect(parseReaction(text)).toEqual({ kind: 'react', emoji: '🎉', mid: REF.mid });
  });
});

describe('buildUnreactionText / parseReaction (unreaction round-trip)', () => {
  it('builds "✖ ↳ <mid> <emoji>"', () => {
    expect(buildUnreactionText('❤', REF.mid)).toBe('✖ ↳ abc123@nine.testrun.org ❤');
  });

  it('round-trips: parseReaction recovers the emoji, mid, and kind', () => {
    const text = buildUnreactionText('❤', REF.mid);
    expect(parseReaction(text)).toEqual({ kind: 'unreact', emoji: '❤', mid: REF.mid });
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

  it('returns null for a malformed reaction (missing mid)', () => {
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

describe('canonical-mid marker (buildReplyTextWithCanonical / parseCanonicalMid)', () => {
  const CANON = 'feed-copy-mid@nine.testrun.org';

  it('appends a canonical marker line after the reply marker', () => {
    const text = buildReplyTextWithCanonical('hello there', REF, CANON);
    // reply marker first (last-line reply parse still works), canonical marker after it.
    expect(text).toBe(
      `hello there\n\n↳re ${REF.mid} ${REF.addr}\n⚓ ${CANON}`,
    );
  });

  it('parseCanonicalMid recovers the canonical mid from a DM reply copy', () => {
    const text = buildReplyTextWithCanonical('hello there', REF, CANON);
    expect(parseCanonicalMid(text)).toBe(CANON);
  });

  it('parseMarkers still recovers the body and reply ref from a canonical DM copy', () => {
    const text = buildReplyTextWithCanonical('hello there\nsecond line', REF, CANON);
    const parsed = parseMarkers(text);
    expect(parsed.body).toBe('hello there\nsecond line');
    expect(parsed.reply).toEqual(REF);
  });

  it('parseCanonicalMid returns null when there is no canonical marker', () => {
    expect(parseCanonicalMid(buildReplyText('plain reply', REF))).toBeNull();
    expect(parseCanonicalMid('just a normal post')).toBeNull();
    expect(parseCanonicalMid('')).toBeNull();
  });

  it('parseCanonicalMid ignores a marker-shaped line that is not the final line', () => {
    const text = `⚓ ${CANON}\nmore text after`;
    expect(parseCanonicalMid(text)).toBeNull();
  });

  it('parseCanonicalMid ignores a malformed marker (empty mid)', () => {
    expect(parseCanonicalMid('body\n\n↳re m a\n⚓ ')).toBeNull();
    expect(parseCanonicalMid('body\n\n↳re m a\n⚓ has space')).toBeNull();
  });

  it('round-trips a canonical marker on a multi-line body', () => {
    const text = buildReplyTextWithCanonical('line one\nline two', REF, CANON);
    expect(parseCanonicalMid(text)).toBe(CANON);
    expect(parseMarkers(text).reply).toEqual(REF);
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
