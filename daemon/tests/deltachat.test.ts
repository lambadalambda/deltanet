import { describe, expect, it } from 'vitest';
import {
  badgeOf,
  blockedContactIds,
  isFeedChat,
  matchesSelfAddr,
  shouldIngest,
} from '../src/transport/deltachat.js';
import { makeContact, makeMessage } from './entities.test.js';

describe('shouldIngest', () => {
  it('accepts an ordinary text message', () => {
    expect(shouldIngest(makeMessage({ text: 'hello' }))).toBe(true);
  });

  it('rejects info/system messages', () => {
    expect(shouldIngest(makeMessage({ isInfo: true, text: 'Member added' }))).toBe(false);
  });

  it('rejects messages with sender id 0', () => {
    expect(shouldIngest(makeMessage({ fromId: 0, text: 'hello' }))).toBe(false);
  });

  it('rejects messages with no text and no file', () => {
    expect(shouldIngest(makeMessage({ text: '', file: null }))).toBe(false);
  });

  it('accepts a fileless-text message with only a file attached', () => {
    expect(shouldIngest(makeMessage({ text: '', file: '/blobs/pic.jpg' }))).toBe(true);
  });

  it('accepts a message with text but no file', () => {
    expect(shouldIngest(makeMessage({ text: 'reacted with ❤', file: null }))).toBe(true);
  });
});

describe('isFeedChat', () => {
  it('treats Group, OutBroadcast, and InBroadcast as feed chats', () => {
    expect(isFeedChat('Group')).toBe(true);
    expect(isFeedChat('OutBroadcast')).toBe(true);
    expect(isFeedChat('InBroadcast')).toBe(true);
  });

  it('treats Single (DM) chats as not-feed', () => {
    expect(isFeedChat('Single')).toBe(false);
  });

  it('treats Mailinglist as not-feed', () => {
    expect(isFeedChat('Mailinglist')).toBe(false);
  });
});

describe('matchesSelfAddr', () => {
  const SELF_ADDR = 'carol123@nine.testrun.org';

  it('matches the full address', () => {
    expect(matchesSelfAddr('carol123@nine.testrun.org', SELF_ADDR)).toBe(true);
  });

  it('matches the bare local part (username)', () => {
    expect(matchesSelfAddr('carol123', SELF_ADDR)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(matchesSelfAddr('Carol123@Nine.Testrun.Org', SELF_ADDR)).toBe(true);
    expect(matchesSelfAddr('CAROL123', SELF_ADDR)).toBe(true);
  });

  it('does not match a different address', () => {
    expect(matchesSelfAddr('bob@nine.testrun.org', SELF_ADDR)).toBe(false);
  });

  it('does not match a different local part', () => {
    expect(matchesSelfAddr('bob', SELF_ADDR)).toBe(false);
  });

  it('does not match the local part with a foreign domain', () => {
    expect(matchesSelfAddr('carol123@elsewhere.org', SELF_ADDR)).toBe(false);
  });
});

describe('blockedContactIds', () => {
  it('returns the ids of blocked contacts', () => {
    const contacts = [
      makeContact({ id: 2, isBlocked: true }),
      makeContact({ id: 3, isBlocked: false }),
    ];
    expect(blockedContactIds(contacts)).toEqual([2]);
  });

  it('returns an empty array when no contact is blocked', () => {
    const contacts = [makeContact({ id: 2, isBlocked: false })];
    expect(blockedContactIds(contacts)).toEqual([]);
  });

  it('returns all ids when every contact is blocked', () => {
    const contacts = [
      makeContact({ id: 2, isBlocked: true }),
      makeContact({ id: 3, isBlocked: true }),
    ];
    expect(blockedContactIds(contacts)).toEqual([2, 3]);
  });
});

describe('badgeOf', () => {
  it('uses the configured self displayname for the SELF contact (id 1), not the raw "Me" placeholder', () => {
    const self = makeContact({ id: 1, displayName: 'Me', color: '#00ff00' });
    expect(badgeOf(self, 'carol')).toEqual({ initial: 'C', color: '#00ff00' });
  });

  it('falls back to the contact displayName for SELF when no configured displayname exists', () => {
    const self = makeContact({ id: 1, displayName: 'Me', color: '#00ff00' });
    expect(badgeOf(self, null)).toEqual({ initial: 'M', color: '#00ff00' });
  });

  it('ignores the self displayname for non-SELF contacts', () => {
    const bob = makeContact({ id: 11, displayName: 'bob', color: '#0000ff' });
    expect(badgeOf(bob, 'carol')).toEqual({ initial: 'B', color: '#0000ff' });
  });
});
