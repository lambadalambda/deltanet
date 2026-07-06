import { describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import {
  contactToAccount,
  messageToStatus,
  textToHtml,
  timelineLinkHeader,
  avatarPlaceholderSvg,
  headerSvg,
  initialOf,
  noopResolver,
  type StatusResolver,
} from '../src/mastodon/entities.js';
import { buildBoostText, buildQuotedText, buildReplyText, refFromToken } from '../src/protocol.js';

const BASE = 'http://localhost:4030';
const UUID = '11111111-2222-4333-8444-555555555555';

export const makeContact = (over: Partial<T.Contact> = {}): T.Contact =>
  ({
    address: 'p6yalimhl@nine.testrun.org',
    color: '#ff0000',
    authName: 'alice',
    status: 'just testing',
    displayName: 'alice',
    id: 1,
    name: 'alice',
    profileImage: null,
    nameAndAddr: 'alice (p6yalimhl@nine.testrun.org)',
    isBlocked: false,
    isKeyContact: true,
    e2eeAvail: true,
    isVerified: false,
    verifierId: null,
    lastSeen: 0,
    wasSeenRecently: false,
    isBot: false,
    isProfileVerified: false,
    ...over,
  }) as T.Contact;

export const makeMessage = (over: Partial<T.Message> = {}): T.Message =>
  ({
    id: 42,
    chatId: 12,
    fromId: 1,
    quote: null,
    parentId: null,
    text: 'hello fediverse',
    isEdited: false,
    hasLocation: false,
    hasHtml: false,
    viewType: 'Text',
    state: 26,
    error: null,
    timestamp: 1751800000,
    sortTimestamp: 1751800000,
    receivedTimestamp: 1751800000,
    hasDeviatingTimestamp: false,
    subject: '',
    showPadlock: true,
    isInfo: false,
    isForwarded: false,
    isBot: false,
    systemMessageType: 'Unknown',
    infoContactId: null,
    duration: 0,
    dimensionsHeight: 0,
    dimensionsWidth: 0,
    overrideSenderName: null,
    sender: makeContact(),
    file: null,
    fileMime: null,
    fileBytes: 0,
    fileName: null,
    webxdcInfo: null,
    downloadState: 'Done',
    reactions: null,
    vcardContact: null,
    originalMsgId: null,
    savedMessageId: null,
    isSetupmessage: false,
    setupCodeBegin: null,
    videochatType: null,
    videochatUrl: null,
    ...over,
  }) as T.Message;

describe('textToHtml', () => {
  it('escapes html and converts newlines', () => {
    expect(textToHtml('a <b> &\nc')).toBe('<p>a &lt;b&gt; &amp;<br/>c</p>');
  });

  it('linkifies http(s) urls', () => {
    expect(textToHtml('see https://example.com/x now')).toBe(
      '<p>see <a href="https://example.com/x" rel="nofollow noopener">https://example.com/x</a> now</p>',
    );
  });
});

describe('contactToAccount', () => {
  it('maps a chatmail contact to a mastodon account', () => {
    const account = contactToAccount(makeContact(), BASE);
    expect(account.id).toBe('1');
    expect(account.username).toBe('p6yalimhl');
    expect(account.acct).toBe('p6yalimhl@nine.testrun.org');
    expect(account.display_name).toBe('alice');
    expect(account.note).toBe('<p>just testing</p>');
    expect(account.avatar).toBe(`${BASE}/deltanet/avatar/1`);
    expect(account.url).toBe(`${BASE}/deltanet/contact/1`);
    // fields the frontend reads must exist
    expect(account.followers_count).toBe(0);
    expect(account.statuses_count).toBe(0);
    expect(account.locked).toBe(false);
    expect(account.bot).toBe(false);
    expect(account.emojis).toEqual([]);
  });

  it('escapes html in the bio', () => {
    const account = contactToAccount(makeContact({ status: '<script>' }), BASE);
    expect(account.note).toBe('<p>&lt;script&gt;</p>');
  });

  it('has no relationship by default', () => {
    const account = contactToAccount(makeContact(), BASE);
    expect((account.pleroma as any).relationship).toBeUndefined();
  });

  it('carries an optional relationship into pleroma.relationship', () => {
    const relationship = {
      id: '1',
      following: true,
      showing_reblogs: true,
      notifying: false,
      followed_by: false,
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      domain_blocking: false,
      endorsed: false,
      note: '',
    };
    const account = contactToAccount(makeContact(), BASE, relationship);
    expect((account.pleroma as any).relationship).toEqual(relationship);
  });
});

describe('messageToStatus', () => {
  it('maps a text message to a status', () => {
    const status = messageToStatus(makeMessage(), BASE);
    expect(status.id).toBe('42');
    expect(status.content).toBe('<p>hello fediverse</p>');
    expect(status.created_at).toBe('2025-07-06T11:06:40.000Z');
    expect(status.account.id).toBe('1');
    expect(status.visibility).toBe('public');
    expect(status.uri).toBe(`${BASE}/deltanet/message/42`);
    expect(status.media_attachments).toEqual([]);
    expect(status.reblog).toBeNull();
    expect(status.in_reply_to_id).toBeNull();
    expect(status.favourites_count).toBe(0);
    expect(status.pleroma.emoji_reactions).toEqual([]);
    expect(status.pleroma.local).toBe(true); // sender id 1 = DC self
  });

  it('marks messages from other contacts as remote', () => {
    const msg = makeMessage({ fromId: 11, sender: makeContact({ id: 11 }) });
    expect(messageToStatus(msg, BASE).pleroma.local).toBe(false);
  });

  it('never derives in_reply_to_id from parentId (parentId fallback removed)', () => {
    // Delta Chat sets parentId from email References to the previous message in
    // the same chat — NOT authorship-level reply intent. A message with only a
    // parentId (no reply marker) is not a reply as far as the wire convention is
    // concerned, so in_reply_to_id is null.
    const msg = makeMessage({ parentId: 40 });
    expect(messageToStatus(msg, BASE).in_reply_to_id).toBeNull();
  });

  it('exposes an image file as a media attachment', () => {
    const msg = makeMessage({
      file: '/blobs/x.png',
      fileMime: 'image/png',
      viewType: 'Image',
    });
    const status = messageToStatus(msg, BASE);
    expect(status.media_attachments).toEqual([
      {
        id: '42',
        type: 'image',
        url: `${BASE}/deltanet/blob/42`,
        preview_url: `${BASE}/deltanet/blob/42`,
        remote_url: null,
        description: null,
      },
    ]);
  });

  it('carries an optional description through to the attachment', () => {
    const msg = makeMessage({ file: '/blobs/x.png', fileMime: 'image/png', viewType: 'Image' });
    const status = messageToStatus(msg, BASE, 'a lovely photo');
    expect(status.media_attachments[0]?.description).toBe('a lovely photo');
  });
});

describe('messageToStatus: reply markers', () => {
  const parentRef = refFromToken({ kind: 'mid', mid: 'parent-mid@example.org' }, 'author@example.org');

  it('strips the marker from content and leaves in_reply_to_id null when unresolvable', () => {
    const msg = makeMessage({ text: buildReplyText('hi there', parentRef, UUID) });
    const status = messageToStatus(msg, BASE);
    expect(status.content).toBe('<p>hi there</p>');
    expect(status.in_reply_to_id).toBeNull();
  });

  it('leaves in_reply_to_id null on an unresolvable ref EVEN when parentId is set (no parentId fallback)', () => {
    // Regression for the parentId fallback bug: a reply whose marker ref can't
    // be resolved must render in_reply_to_id null, never fall back to the DC
    // parentId (which points at an unrelated same-chat message).
    const msg = makeMessage({ parentId: 99, text: buildReplyText('hi there', parentRef, UUID) });
    const status = messageToStatus(msg, BASE);
    expect(status.in_reply_to_id).toBeNull();
    expect(status.in_reply_to_account_id).toBeNull();
    expect(status.mentions).toEqual([]);
  });

  it('resolves in_reply_to_id via the resolver when the ref key is known', () => {
    const msg = makeMessage({ text: buildReplyText('hi there', parentRef, UUID) });
    const resolver: StatusResolver = {
      ...noopResolver,
      resolveMid: (key) => (key === parentRef.keyString ? 40 : null),
    };
    const status = messageToStatus(msg, BASE, null, resolver);
    expect(status.in_reply_to_id).toBe('40');
    expect(status.content).toBe('<p>hi there</p>');
  });

  it('reports replies_count from the resolver keyed by this message own mid', () => {
    const msg = makeMessage({ id: 55, text: 'a parent post' });
    const resolver: StatusResolver = {
      ...noopResolver,
      midForMsgId: (id) => (id === 55 ? 'own-mid@example.org' : null),
      childrenCount: (mid) => (mid === 'own-mid@example.org' ? 3 : 0),
    };
    const status = messageToStatus(msg, BASE, null, resolver);
    expect(status.replies_count).toBe(3);
  });

  it('fills in_reply_to_account_id and mentions when the parent mid resolves and the parent message loads', () => {
    const msg = makeMessage({ text: buildReplyText('hi there', parentRef, UUID) });
    const parentAuthor = makeContact({ id: 21, address: 'parentauthor@example.org', displayName: 'parent author' });
    const parent = makeMessage({ id: 40, sender: parentAuthor, text: 'the original post' });
    const resolver: StatusResolver = {
      ...noopResolver,
      resolveMid: (key) => (key === parentRef.keyString ? 40 : null),
    };
    const status = messageToStatus(msg, BASE, null, resolver, (id) => (id === 40 ? parent : null));
    expect(status.in_reply_to_id).toBe('40');
    expect(status.in_reply_to_account_id).toBe('21');
    expect(status.mentions).toEqual([
      {
        id: '21',
        username: 'parentauthor',
        acct: 'parentauthor@example.org',
        url: `${BASE}/deltanet/contact/21`,
      },
    ]);
  });

  it('leaves in_reply_to_account_id null and mentions empty when the mid resolves but the parent message does not load', () => {
    const msg = makeMessage({ text: buildReplyText('hi there', parentRef, UUID) });
    const resolver: StatusResolver = {
      ...noopResolver,
      resolveMid: (key) => (key === parentRef.keyString ? 40 : null),
    };
    const status = messageToStatus(msg, BASE, null, resolver, () => null);
    expect(status.in_reply_to_id).toBe('40');
    expect(status.in_reply_to_account_id).toBeNull();
    expect(status.mentions).toEqual([]);
  });

  it('leaves in_reply_to_account_id null and mentions empty when the mid does not resolve at all', () => {
    const msg = makeMessage({ text: buildReplyText('hi there', parentRef, UUID) });
    const status = messageToStatus(msg, BASE, null, noopResolver, () => {
      throw new Error('resolveMessage should not be called when the mid does not resolve');
    });
    expect(status.in_reply_to_id).toBeNull();
    expect(status.in_reply_to_account_id).toBeNull();
    expect(status.mentions).toEqual([]);
  });

  it('includes the mention even when replying to your own message (self-reply)', () => {
    const msg = makeMessage({ text: buildReplyText('hi there', parentRef, UUID) });
    const parent = makeMessage({ id: 40, sender: makeContact(), text: 'my own earlier post' });
    const resolver: StatusResolver = {
      ...noopResolver,
      resolveMid: (key) => (key === parentRef.keyString ? 40 : null),
    };
    const status = messageToStatus(msg, BASE, null, resolver, (id) => (id === 40 ? parent : null));
    expect(status.in_reply_to_account_id).toBe('1');
    expect(status.mentions).toEqual([
      {
        id: '1',
        username: 'p6yalimhl',
        acct: 'p6yalimhl@nine.testrun.org',
        url: `${BASE}/deltanet/contact/1`,
      },
    ]);
  });
});

describe('messageToStatus: boost markers', () => {
  const originalRef = refFromToken({ kind: 'mid', mid: 'original-mid@example.org' }, 'author@example.org');

  it('embeds the real message as reblog when the mid resolves', () => {
    const original = makeMessage({
      id: 7,
      text: 'the original post',
      sender: makeContact({ id: 11, displayName: 'orig author' }),
    });
    const boostMsg = makeMessage({ id: 8, text: buildBoostText(originalRef, UUID) });
    const resolver: StatusResolver = {
      ...noopResolver,
      resolveMid: (key) => (key === originalRef.keyString ? 7 : null),
    };
    const status = messageToStatus(boostMsg, BASE, null, resolver, (id) => (id === 7 ? original : null));
    expect(status.reblog).not.toBeNull();
    expect(status.reblog?.id).toBe('7');
    expect(status.reblog?.content).toBe('<p>the original post</p>');
    expect(status.reblog?.account.display_name).toBe('orig author');
  });

  it('synthesizes a minimal status when the mid does not resolve', () => {
    const quotedText = buildQuotedText('remote author', 'something interesting', 500);
    const boostMsg = makeMessage({
      id: 9,
      text: buildBoostText(originalRef, UUID),
      quote: { kind: 'JustText', text: quotedText },
    });
    const status = messageToStatus(boostMsg, BASE, null, noopResolver, () => null);
    expect(status.reblog).not.toBeNull();
    expect(status.reblog?.account.acct).toBe(originalRef.addr);
    expect(status.reblog?.account.display_name).toBe('remote author');
    expect(status.reblog?.content).toBe('<p>something interesting</p>');
  });

  it('strips the boost marker itself from the outer status content', () => {
    const boostMsg = makeMessage({ id: 9, text: buildBoostText(originalRef, UUID) });
    const status = messageToStatus(boostMsg, BASE);
    expect(status.content).toBe('<p></p>');
  });

  it('reports reblogs_count and reblogged from the resolver keyed by this message own mid', () => {
    const msg = makeMessage({ id: 66, text: 'a boostable post' });
    const resolver: StatusResolver = {
      ...noopResolver,
      midForMsgId: (id) => (id === 66 ? 'own-mid-2@example.org' : null),
      boostCount: (mid) => (mid === 'own-mid-2@example.org' ? 2 : 0),
      isOwnBoost: (mid) => mid === 'own-mid-2@example.org',
    };
    const status = messageToStatus(msg, BASE, null, resolver);
    expect(status.reblogs_count).toBe(2);
    expect(status.reblogged).toBe(true);
  });
});

describe('messageToStatus: reaction tallies', () => {
  it('defaults to favourited:false, favourites_count:0, empty emoji_reactions', () => {
    const status = messageToStatus(makeMessage({ id: 100 }), BASE);
    expect(status.favourited).toBe(false);
    expect(status.favourites_count).toBe(0);
    expect(status.pleroma.emoji_reactions).toEqual([]);
  });

  it('reports favourites_count/favourited from reaction tallies keyed by own mid', () => {
    const msg = makeMessage({ id: 101 });
    const resolver: StatusResolver = {
      ...noopResolver,
      midForMsgId: (id) => (id === 101 ? 'own-mid@example.org' : null),
      reactionTallies: (mid) =>
        mid === 'own-mid@example.org'
          ? [{ emoji: '❤', count: 2, reactors: ['bob@example.org', 'me@example.org'] }]
          : [],
      ownAddr: () => 'me@example.org',
    };
    const status = messageToStatus(msg, BASE, null, resolver);
    expect(status.favourites_count).toBe(2);
    expect(status.favourited).toBe(true);
  });

  it('favourited is false when our own address has not reacted with ❤', () => {
    const msg = makeMessage({ id: 102 });
    const resolver: StatusResolver = {
      ...noopResolver,
      midForMsgId: (id) => (id === 102 ? 'own-mid-2@example.org' : null),
      reactionTallies: (mid) =>
        mid === 'own-mid-2@example.org' ? [{ emoji: '❤', count: 1, reactors: ['bob@example.org'] }] : [],
      ownAddr: () => 'me@example.org',
    };
    const status = messageToStatus(msg, BASE, null, resolver);
    expect(status.favourites_count).toBe(1);
    expect(status.favourited).toBe(false);
  });

  it('maps non-heart reactions into pleroma.emoji_reactions with me flag, excluding heart', () => {
    const msg = makeMessage({ id: 103 });
    const resolver: StatusResolver = {
      ...noopResolver,
      midForMsgId: (id) => (id === 103 ? 'own-mid-3@example.org' : null),
      reactionTallies: (mid) =>
        mid === 'own-mid-3@example.org'
          ? [
              { emoji: '❤', count: 1, reactors: ['bob@example.org'] },
              { emoji: '🎉', count: 2, reactors: ['bob@example.org', 'me@example.org'] },
            ]
          : [],
      ownAddr: () => 'me@example.org',
    };
    const status = messageToStatus(msg, BASE, null, resolver);
    expect(status.pleroma.emoji_reactions).toEqual([{ name: '🎉', count: 2, me: true }]);
  });
});

describe('initialOf', () => {
  it('uppercases the first grapheme of a display name', () => {
    expect(initialOf('alice')).toBe('A');
  });

  it('handles emoji/multi-codepoint display names without splitting them', () => {
    expect(initialOf('👍cool person')).toBe('👍');
  });

  it('falls back to a neutral glyph for an empty name', () => {
    expect(initialOf('')).toBe('?');
  });
});

describe('avatarPlaceholderSvg', () => {
  it('renders the initial and color into an svg', () => {
    const svg = avatarPlaceholderSvg('A', '#ff0000');
    expect(svg).toContain('<svg');
    expect(svg).toContain('#ff0000');
    expect(svg).toContain('>A<');
  });

  it('produces a neutral placeholder for unknown contacts', () => {
    const svg = avatarPlaceholderSvg('?', '#2a3542');
    expect(svg).toContain('>?<');
    expect(svg).toContain('#2a3542');
  });
});

describe('headerSvg', () => {
  it('renders a banner svg', () => {
    const svg = headerSvg();
    expect(svg).toContain('<svg');
    expect(svg).toMatch(/<svg[^>]*width="1500"/);
  });
});

describe('timelineLinkHeader', () => {
  it('builds next/prev links from the returned page', () => {
    const header = timelineLinkHeader(`${BASE}/api/v1/timelines/home`, ['50', '43', '42']);
    expect(header).toBe(
      `<${BASE}/api/v1/timelines/home?max_id=42>; rel="next", ` +
        `<${BASE}/api/v1/timelines/home?min_id=50>; rel="prev"`,
    );
  });

  it('returns null for an empty page', () => {
    expect(timelineLinkHeader(`${BASE}/x`, [])).toBeNull();
  });
});
