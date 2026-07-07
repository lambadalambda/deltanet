import { describe, expect, it } from 'vitest';
import { parseBodyMentions } from '../src/mentions.js';

describe('parseBodyMentions', () => {
  it('extracts @local@domain tokens from a plain body', () => {
    expect(parseBodyMentions('hey @zbie604yz@nine.testrun.org check this out')).toEqual([
      'zbie604yz@nine.testrun.org',
    ]);
  });

  it('extracts multiple mentions and dedupes case-insensitively', () => {
    expect(
      parseBodyMentions(
        '@a@x.org and @B@Y.org and again @A@X.ORG plus @c@z.example.co',
      ),
    ).toEqual(['a@x.org', 'b@y.org', 'c@z.example.co']);
  });

  it('requires a full address — bare @usernames are not addressing', () => {
    // A bare @name can't be delivered to (no relay); only full addresses
    // address someone. Bare handles stay plain text.
    expect(parseBodyMentions('thanks @carol, and @bob!')).toEqual([]);
  });

  it('handles mentions at start, end, and against punctuation', () => {
    expect(parseBodyMentions('@a@x.org: hi')).toEqual(['a@x.org']);
    expect(parseBodyMentions('hi (@a@x.org)')).toEqual(['a@x.org']);
    expect(parseBodyMentions('bye @a@x.org')).toEqual(['a@x.org']);
    expect(parseBodyMentions('really, @a@x.org?')).toEqual(['a@x.org']);
  });

  it('does not fire inside plain email addresses (no @ prefix)', () => {
    expect(parseBodyMentions('mail me at someone@example.org')).toEqual([]);
  });

  it('ignores malformed or TLD-less targets', () => {
    expect(parseBodyMentions('@a@localhost and @@x.org and @a@@b.org')).toEqual([]);
  });

  it('allows underscores in domain labels (real chatmail relays use them)', () => {
    expect(parseBodyMentions('ping @jt6hwfn4e@_chatmail.example now')).toEqual([
      'jt6hwfn4e@_chatmail.example',
    ]);
  });

  it('returns [] for empty/plain text', () => {
    expect(parseBodyMentions('')).toEqual([]);
    expect(parseBodyMentions('no mentions here')).toEqual([]);
  });
});

import { rankedContactMatches } from '../src/mentions.js';
import { makeContact } from './entities.test.js';

describe('rankedContactMatches', () => {
  const carol = makeContact({
    id: 12, address: 'zbie604yz@nine.testrun.org',
    authName: 'Carol Sparkle', displayName: 'carol', name: 'carol',
  });
  const carlos = makeContact({
    id: 13, address: 'x99carolx@nine.testrun.org',
    authName: 'Carlos', displayName: 'Carlos', name: '',
  });
  const bob = makeContact({
    id: 11, address: 'aab3ff9@nine.testrun.org',
    authName: 'bob', displayName: 'bob', name: '',
  });
  const self = makeContact({ id: 1, address: 'me@nine.testrun.org', name: 'me', authName: '' });
  const addressOnly = makeContact({
    id: 44, address: 'carolina@other.org', authName: 'carolina',
    displayName: 'carolina', name: '', isKeyContact: false,
  });

  it('matches petname first, then their name, then the address', () => {
    const results = rankedContactMatches([bob, addressOnly, carlos, carol], 'car', 10);
    // carol: petname prefix; carlos: name prefix; carolx address substring.
    expect(results.map((c) => c.id)).toEqual([12, 13]);
  });

  it('excludes SELF and keyless address-contacts (not addressable)', () => {
    expect(rankedContactMatches([self, addressOnly], 'car', 10)).toEqual([]);
    expect(rankedContactMatches([self], 'me', 10)).toEqual([]);
  });

  it('matches on the address too, ranked last', () => {
    const results = rankedContactMatches([carol, bob], 'aab3', 10);
    expect(results.map((c) => c.id)).toEqual([11]);
  });

  it('substring matches rank below prefix matches within the same field', () => {
    const sparkle = makeContact({ id: 20, address: 'q1@x.org', authName: 'Old Carol', displayName: 'Old Carol', name: '' });
    const results = rankedContactMatches([sparkle, carlos], 'car', 10);
    expect(results.map((c) => c.id)).toEqual([13, 20]);
  });

  it('respects the limit and returns [] for a blank query', () => {
    expect(rankedContactMatches([carol, carlos], 'c', 1).length).toBe(1);
    expect(rankedContactMatches([carol], '  ', 10)).toEqual([]);
  });
});
