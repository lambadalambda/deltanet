import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAccounts, writeAccount } from '../src/config.js';
import {
  beginSidecarRestore,
  recoverInterruptedSidecarRestore,
  restoreJournalPathFor,
} from '../src/restore-journal.js';
import { createStore } from '../src/store.js';

let root: string;
let dataDir: string;
let storePath: string;
let keyPath: string;
let accountsPath: string;
let journalPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deltanet-restore-journal-'));
  dataDir = join(root, 'account-data');
  storePath = join(dataDir, 'deltanet-store.json');
  keyPath = join(dataDir, 'deltanet-signing-key.json');
  accountsPath = join(root, 'accounts.local.json');
  journalPath = restoreJournalPathFor(dataDir);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const keyCache = new Map<string, string>();
const key = (name: string): string => {
  const cached = keyCache.get(name);
  if (cached) return cached;
  const pair = generateKeyPairSync('ed25519');
  const contents = `${JSON.stringify({
    privatePem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pubkey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  })}\n`;
  keyCache.set(name, contents);
  return contents;
};

const setup = () => {
  const target = createStore(storePath);
  target.pinKey('target@example.org', 'TARGET');
  writeFileSync(keyPath, key('target'), { mode: 0o600 });
  writeAccount(accountsPath, 'main', {
    addr: 'target@example.org',
    password: 'target-password',
    displayName: 'target',
  });
  const donorPath = join(root, 'donor-store.json');
  const donor = createStore(donorPath);
  donor.pinKey('donor@example.org', 'DONOR');
  return { target, donorStore: donor.readSnapshot()!.contents };
};

describe('sidecar restore journal', () => {
  it('does not retain credential-bearing malformed JSON in its error or cause graph', () => {
    writeFileSync(journalPath, '{"previous":{"account":{"password":"journal-secret"}', { mode: 0o600 });
    let thrown: unknown;
    try {
      recoverInterruptedSidecarRestore(journalPath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(inspect(thrown, { depth: 10 })).not.toContain('journal-secret');
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((thrown as Error).stack).not.toContain('journal-secret');
  });

  it('prepares a fresh restore without creating the core data directory', () => {
    const freshStore = createStore(storePath);
    const journal = beginSidecarRestore({
      journalPath,
      store: freshStore,
      signingKeyPath: keyPath,
    });

    expect(existsSync(dataDir)).toBe(false);
    journal.finish();
  });

  it('rolls back a fresh prepared restore without polluting the core data directory', () => {
    const freshStore = createStore(storePath, { lockPath: `${dataDir}.daemon.lock` });
    const journal = beginSidecarRestore({
      journalPath,
      store: freshStore,
      signingKeyPath: keyPath,
    });

    journal.rollback();

    expect(existsSync(dataDir)).toBe(false);
  });

  it('replays a fresh prepared restore without polluting the core data directory', () => {
    const freshStore = createStore(storePath, { lockPath: `${dataDir}.daemon.lock` });
    beginSidecarRestore({
      journalPath,
      store: freshStore,
      signingKeyPath: keyPath,
    });

    recoverInterruptedSidecarRestore(journalPath);

    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('lives outside the core data directory and is mode 0600', () => {
    const { target, donorStore } = setup();
    beginSidecarRestore({
      journalPath,
      store: target,
      signingKeyPath: keyPath,
      accountsPath,
      accountName: 'main',
      donorStore,
      donorSigningKey: key('donor'),
    });

    expect(journalPath.startsWith(`${dataDir}/`)).toBe(false);
    expect(statSync(journalPath).mode & 0o777).toBe(0o600);
  });

  it('startup rolls back pre-restore store, signing key, and accounts after a crash during donor install', () => {
    const { target, donorStore } = setup();
    const journal = beginSidecarRestore({
      journalPath,
      store: target,
      signingKeyPath: keyPath,
      accountsPath,
      accountName: 'main',
      donorStore,
      donorSigningKey: key('donor'),
    });
    journal.install();
    writeAccount(accountsPath, 'peer', {
      addr: 'peer@example.org',
      password: 'peer-password',
      displayName: 'peer',
    });
    expect(target.pinnedKey('donor@example.org')).toBe('DONOR');
    expect(readFileSync(keyPath, 'utf8')).toBe(key('donor'));

    recoverInterruptedSidecarRestore(journalPath);

    const recovered = createStore(storePath);
    expect(recovered.pinnedKey('target@example.org')).toBe('TARGET');
    expect(recovered.pinnedKey('donor@example.org')).toBeNull();
    expect(readFileSync(keyPath, 'utf8')).toBe(key('target'));
    expect(readAccounts(accountsPath).main?.addr).toBe('target@example.org');
    expect(readAccounts(accountsPath).peer?.addr).toBe('peer@example.org');
    expect(existsSync(journalPath)).toBe(false);
  });

  it('startup completes donor roots when credentials were durably committed before a crash', () => {
    const { target, donorStore } = setup();
    const journal = beginSidecarRestore({
      journalPath,
      store: target,
      signingKeyPath: keyPath,
      accountsPath,
      accountName: 'main',
      donorStore,
      donorSigningKey: key('donor'),
    });
    journal.install();
    journal.persistCredentials({
      addr: 'donor@example.org',
      password: 'donor-password',
      displayName: 'donor',
    });
    writeAccount(accountsPath, 'peer', {
      addr: 'peer@example.org',
      password: 'peer-password',
      displayName: 'peer',
    });

    // Damage both donor sidecars after the commit marker; startup must replay
    // the committed donor roots rather than rolling them back.
    writeFileSync(storePath, '{broken');
    writeFileSync(keyPath, 'broken');
    recoverInterruptedSidecarRestore(journalPath);

    const recovered = createStore(storePath);
    expect(recovered.pinnedKey('donor@example.org')).toBe('DONOR');
    expect(readFileSync(keyPath, 'utf8')).toBe(key('donor'));
    expect(readAccounts(accountsPath).main?.addr).toBe('donor@example.org');
    expect(readAccounts(accountsPath).peer?.addr).toBe('peer@example.org');
    expect(existsSync(journalPath)).toBe(false);
  });

  it('preserves Store mutations committed after the restore credential marker', () => {
    const { target, donorStore } = setup();
    const journal = beginSidecarRestore({
      journalPath,
      store: target,
      signingKeyPath: keyPath,
      accountsPath,
      accountName: 'main',
      donorStore,
      donorSigningKey: key('donor'),
    });
    journal.install();
    journal.persistCredentials({
      addr: 'donor@example.org',
      password: 'donor-password',
      displayName: 'donor',
    });
    target.pinKey('after-commit@example.org', 'NEW_ROOT');

    recoverInterruptedSidecarRestore(journalPath);

    const recovered = createStore(storePath);
    expect(recovered.pinnedKey('donor@example.org')).toBe('DONOR');
    expect(recovered.pinnedKey('after-commit@example.org')).toBe('NEW_ROOT');
  });

  it('keeps the journal replayable when rollback fails after restoring the store', () => {
    const { target, donorStore } = setup();
    const journal = beginSidecarRestore(
      {
        journalPath,
        store: target,
        signingKeyPath: keyPath,
        accountsPath,
        accountName: 'main',
        donorStore,
        donorSigningKey: key('donor'),
      },
      {
        beforeOperation: (operation) => {
          if (operation === 'rollback-signing-key') throw new Error('injected rollback failure');
        },
      },
    );
    journal.install();
    expect(() => journal.rollback()).toThrow('injected rollback failure');
    expect(existsSync(journalPath)).toBe(true);

    recoverInterruptedSidecarRestore(journalPath);
    expect(createStore(storePath).pinnedKey('target@example.org')).toBe('TARGET');
    expect(readFileSync(keyPath, 'utf8')).toBe(key('target'));
    expect(existsSync(journalPath)).toBe(false);
  });

  it('replays previous roots when donor install fails between store and signing key', () => {
    const { target, donorStore } = setup();
    const journal = beginSidecarRestore(
      {
        journalPath,
        store: target,
        signingKeyPath: keyPath,
        accountsPath,
        accountName: 'main',
        donorStore,
        donorSigningKey: key('donor'),
      },
      {
        beforeOperation: (operation) => {
          if (operation === 'install-signing-key') throw new Error('crash after donor store');
        },
      },
    );
    expect(() => journal.install()).toThrow('crash after donor store');
    expect(target.pinnedKey('donor@example.org')).toBe('DONOR');
    expect(readFileSync(keyPath, 'utf8')).toBe(key('target'));

    recoverInterruptedSidecarRestore(journalPath);
    expect(createStore(storePath).pinnedKey('target@example.org')).toBe('TARGET');
    expect(readFileSync(keyPath, 'utf8')).toBe(key('target'));
  });

  it('normal success removes the journal only after credentials are marked committed', () => {
    const { target, donorStore } = setup();
    const journal = beginSidecarRestore({
      journalPath,
      store: target,
      signingKeyPath: keyPath,
      accountsPath,
      accountName: 'main',
      donorStore,
      donorSigningKey: key('donor'),
    });
    journal.install();
    expect(() => journal.finish()).toThrow(/credentials.*not committed/i);
    journal.persistCredentials({
      addr: 'donor@example.org',
      password: 'p',
      displayName: 'donor',
    });
    journal.finish();
    expect(existsSync(journalPath)).toBe(false);
  });
});
