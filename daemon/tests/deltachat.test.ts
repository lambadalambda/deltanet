import { describe, expect, it } from 'vitest';
import {
  badgeOf,
  blockedContactIds,
  credsFromConfig,
  isFeedChat,
  matchesSelfAddr,
  openTransport,
  readCompatibleConfig,
  shouldIngest,
  writeCompatibleConfig,
  type OpenTransportOptions,
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

describe('credsFromConfig (backup restore)', () => {
  it('prefers configured_addr and falls back to addr', () => {
    expect(
      credsFromConfig({ configuredAddr: 'a@x.y', addr: 'stale@x.y', password: 'pw', displayName: 'A' }),
    ).toEqual({ addr: 'a@x.y', password: 'pw', displayName: 'A' });
    expect(credsFromConfig({ addr: 'b@x.y', password: 'pw', displayName: 'B' })?.addr).toBe('b@x.y');
  });

  it('derives a display name from the addr local part when the backup has none', () => {
    expect(credsFromConfig({ addr: 'carol@relay.example', password: 'pw' })?.displayName).toBe('carol');
  });

  it('is null without any address (unusable backup)', () => {
    expect(credsFromConfig({ password: 'pw', displayName: 'X' })).toBeNull();
    expect(credsFromConfig({ configuredAddr: null, addr: '' })).toBeNull();
  });
});

describe('compatible Delta Chat config', () => {
  it('prefers the Headwater key and falls back without creating replacement state', async () => {
    const values = new Map([
      ['ui.headwater.feed_chat_id', '41'],
      ['ui.deltanet.feed_chat_id', '12'],
    ]);
    const get = async (key: string) => values.get(key) ?? null;
    const set = async (key: string, value: string) => { values.set(key, value); };

    expect(await readCompatibleConfig(get, set, 'ui.headwater.feed_chat_id', 'ui.deltanet.feed_chat_id')).toBe('41');
    values.delete('ui.headwater.feed_chat_id');
    expect(await readCompatibleConfig(get, set, 'ui.headwater.feed_chat_id', 'ui.deltanet.feed_chat_id')).toBe('12');
    expect(values.get('ui.headwater.feed_chat_id')).toBe('12');
  });

  it('dual-writes Headwater and legacy keys during compatibility', async () => {
    const writes: [string, string][] = [];
    await writeCompatibleConfig(
      async (key, value) => { writes.push([key, value]); },
      'ui.headwater.last_backup_at',
      'ui.deltanet.last_backup_at',
      '123',
    );
    expect(writes).toEqual([
      ['ui.deltanet.last_backup_at', '123'],
      ['ui.headwater.last_backup_at', '123'],
    ]);
  });

  it('leaves the legacy key usable when the preferred alias write fails', async () => {
    const values = new Map<string, string>();
    await expect(writeCompatibleConfig(
      async (key, value) => {
        if (key === 'ui.headwater.feed_chat_id') throw new Error('preferred write failed');
        values.set(key, value);
      },
      'ui.headwater.feed_chat_id',
      'ui.deltanet.feed_chat_id',
      '41',
    )).rejects.toThrow('preferred write failed');

    expect(values.get('ui.deltanet.feed_chat_id')).toBe('41');
    expect(values.has('ui.headwater.feed_chat_id')).toBe(false);
  });
});

describe('Delta Chat core lifecycle', () => {
  it('closes a spawned core when transport initialization fails', async () => {
    let closes = 0;
    const fakeCore = {
      rpc: {
        getAllAccountIds: async () => { throw new Error('rpc initialization failed'); },
      },
      close: async () => { closes += 1; },
      exited: new Promise(() => {}),
    };
    const startCore = (() => fakeCore) as unknown as NonNullable<OpenTransportOptions['startCore']>;

    await expect(openTransport('unused', {
      addr: 'alice@example.org',
      password: 'secret',
      displayName: 'Alice',
    }, { startCore })).rejects.toThrow('rpc initialization failed');
    expect(closes).toBe(1);
  });

  it('closes a core that exits while an initialization RPC is pending', async () => {
    let closes = 0;
    const fakeCore = {
      rpc: {
        getAllAccountIds: () => new Promise<number[]>(() => {}),
      },
      close: async () => { closes += 1; },
      exited: Promise.resolve({ expected: false, code: 9, signal: null }),
    };
    const startCore = (() => fakeCore) as unknown as NonNullable<OpenTransportOptions['startCore']>;

    await expect(openTransport('unused', {
      addr: 'alice@example.org',
      password: 'secret',
      displayName: 'Alice',
    }, { startCore })).rejects.toThrow(/exited during startup \(9\)/);
    expect(closes).toBe(1);
  });
});
