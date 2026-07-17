import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountConflictError,
  CredentialsFileError,
  compareExchangeAccount,
  readAccounts,
  resolveDaemonConfig,
  resolveDataFilePath,
  writeAccount,
} from '../src/config.js';

describe('daemon environment configuration', () => {
  it('prefers HEADWATER variables over DELTANET fallbacks', () => {
    const config = resolveDaemonConfig({
      HEADWATER_ACCOUNT: 'preferred',
      DELTANET_ACCOUNT: 'legacy',
      HEADWATER_DATA: 'headwater-data',
      DELTANET_DATA: 'deltanet-data',
      HEADWATER_BASE_URL: 'https://headwater.example',
      DELTANET_BASE_URL: 'https://deltanet.example',
    }, 4030);

    expect(config.account).toBe('preferred');
    expect(config.dataDir).toBe('headwater-data');
    expect(config.baseUrl).toBe('https://headwater.example');
  });

  it('uses legacy DELTANET variables when HEADWATER variables are absent', () => {
    const config = resolveDaemonConfig({
      DELTANET_ACCOUNT: 'legacy',
      DELTANET_DATA: 'legacy-data',
      DELTANET_ALLOWED_ORIGINS: 'https://one.example, https://two.example',
      DELTANET_SIGNUP_RELAYS: 'https://relay.example',
    }, 4040);

    expect(config.account).toBe('legacy');
    expect(config.dataDir).toBe('legacy-data');
    expect(config.baseUrl).toBe('http://localhost:4040');
    expect(config.allowedOrigins).toEqual(['https://one.example', 'https://two.example']);
    expect(config.signupRelays).toEqual(['https://relay.example']);
  });
});

describe('resolveDataFilePath', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('uses a legacy persisted file instead of creating a new identity file', () => {
    dir = mkdtempSync(join(tmpdir(), 'headwater-data-path-'));
    const legacy = join(dir, 'deltanet-signing-key.json');
    writeFileSync(legacy, '{}');

    expect(resolveDataFilePath(dir, 'headwater-signing-key.json', 'deltanet-signing-key.json')).toBe(legacy);
  });

  it('prefers the Headwater file when both names exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'headwater-data-path-'));
    const preferred = join(dir, 'headwater-store.json');
    writeFileSync(preferred, '{}');
    writeFileSync(join(dir, 'deltanet-store.json'), '{}');

    expect(resolveDataFilePath(dir, 'headwater-store.json', 'deltanet-store.json')).toBe(preferred);
  });

  it('selects a legacy store when only its recovery generation survives', () => {
    dir = mkdtempSync(join(tmpdir(), 'headwater-data-path-'));
    writeFileSync(join(dir, 'deltanet-store.json.recovery'), '{}');

    expect(resolveDataFilePath(dir, 'headwater-store.json', 'deltanet-store.json')).toBe(
      join(dir, 'deltanet-store.json'),
    );
  });

  it('propagates state-file probe errors instead of selecting a fresh path', () => {
    dir = mkdtempSync(join(tmpdir(), 'headwater-data-path-'));

    expect(() => resolveDataFilePath(dir, '\0invalid', 'deltanet-store.json')).toThrow();
  });
});

describe('readAccounts', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty object when the file does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-'));
    expect(readAccounts(join(dir, 'nope.json'))).toEqual({});
  });

  it('reads existing credentials', () => {
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-'));
    const path = join(dir, 'accounts.local.json');
    writeAccount(path, 'main', { addr: 'a@b.org', password: 'p', displayName: 'alice' });
    expect(readAccounts(path)).toEqual({
      main: { addr: 'a@b.org', password: 'p', displayName: 'alice' },
    });
  });
});

describe('writeAccount', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file and adds the named account', () => {
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-'));
    const path = join(dir, 'accounts.local.json');
    writeAccount(path, 'main', { addr: 'a@b.org', password: 'p', displayName: 'alice' });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written).toEqual({ main: { addr: 'a@b.org', password: 'p', displayName: 'alice' } });
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('creates missing credential directories with owner-only permissions', () => {
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-'));
    const parent = join(dir, 'private', 'account');
    const path = join(parent, 'accounts.local.json');
    const previousUmask = process.umask(process.platform === 'win32' ? process.umask() : 0o777);
    try {
      writeAccount(path, 'main', { addr: 'a@b.org', password: 'p', displayName: 'alice' });
    } finally {
      process.umask(previousUmask);
    }
    if (process.platform !== 'win32') {
      expect(statSync(parent).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'private')).mode & 0o777).toBe(0o700);
    }
  });

  it('corrects broad existing file permissions before returning secrets', () => {
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-'));
    const path = join(dir, 'accounts.local.json');
    writeFileSync(path, '{"main":{"addr":"a@b.org","password":"secret","displayName":"alice"}}', { mode: 0o644 });
    chmodSync(path, 0o644);

    expect(readAccounts(path).main?.addr).toBe('a@b.org');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('preserves file ownership while replacing an existing credentials file', () => {
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-'));
    const path = join(dir, 'accounts.local.json');
    writeAccount(path, 'main', { addr: 'a@b.org', password: 'p', displayName: 'alice' });
    const before = statSync(path);

    writeAccount(path, 'main', { addr: 'new@b.org', password: 'new', displayName: 'alice' });

    const after = statSync(path);
    expect({ uid: after.uid, gid: after.gid }).toEqual({ uid: before.uid, gid: before.gid });
  });

  it('does not include malformed credential contents in parse errors', () => {
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-'));
    const path = join(dir, 'accounts.local.json');
    writeFileSync(path, '{"main":{"password":"super-secret"', { mode: 0o600 });

    expect(() => readAccounts(path)).toThrow(CredentialsFileError);
    try {
      readAccounts(path);
    } catch (error) {
      expect(String(error)).not.toContain('super-secret');
    }
  });

  it('rejects directories and symbolic links as credential files', () => {
    if (process.platform === 'win32') return;
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-'));
    const target = join(dir, 'target.json');
    const linked = join(dir, 'accounts.local.json');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, linked);
    expect(() => readAccounts(linked)).toThrow(CredentialsFileError);
    expect(readFileSync(target, 'utf8')).toBe('{}');

    rmSync(linked);
    symlinkSync(join(dir, 'missing-target'), linked);
    expect(() => readAccounts(linked)).toThrow(CredentialsFileError);
    rmSync(linked);
    mkdirSync(linked);
    expect(() => readAccounts(linked)).toThrow(CredentialsFileError);
  });

  it('rejects a group-writable credential parent with a clear diagnostic', () => {
    if (process.platform === 'win32') return;
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-'));
    chmodSync(dir, 0o770);
    const path = join(dir, 'accounts.local.json');
    expect(() => writeAccount(path, 'main', {
      addr: 'a@b.org', password: 'secret', displayName: 'alice',
    })).toThrow('parent-is-group-or-world-writable');
  });

  it('preserves existing accounts when adding another', () => {
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-'));
    const path = join(dir, 'accounts.local.json');
    writeAccount(path, 'main', { addr: 'a@b.org', password: 'p', displayName: 'alice' });
    writeAccount(path, 'peer', { addr: 'c@d.org', password: 'q', displayName: 'bob' });
    expect(readAccounts(path)).toEqual({
      main: { addr: 'a@b.org', password: 'p', displayName: 'alice' },
      peer: { addr: 'c@d.org', password: 'q', displayName: 'bob' },
    });
  });

  it('compare-exchanges one account without replacing unrelated entries', () => {
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-'));
    const path = join(dir, 'accounts.local.json');
    const before = { addr: 'a@b.org', password: 'p', displayName: 'alice' };
    const after = { addr: 'new@b.org', password: 'new', displayName: 'alice' };
    writeAccount(path, 'main', before);
    writeAccount(path, 'peer', { addr: 'c@d.org', password: 'q', displayName: 'bob' });

    compareExchangeAccount(path, 'main', before, after);

    expect(readAccounts(path)).toEqual({
      main: after,
      peer: { addr: 'c@d.org', password: 'q', displayName: 'bob' },
    });
  });

  it('fails closed when the selected account changed concurrently', () => {
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-'));
    const path = join(dir, 'accounts.local.json');
    writeAccount(path, 'main', { addr: 'current@b.org', password: 'p', displayName: 'alice' });

    expect(() => compareExchangeAccount(
      path,
      'main',
      { addr: 'stale@b.org', password: 'old', displayName: 'alice' },
      { addr: 'new@b.org', password: 'new', displayName: 'alice' },
    )).toThrow(AccountConflictError);
    expect(readAccounts(path).main?.addr).toBe('current@b.org');
  });
});
