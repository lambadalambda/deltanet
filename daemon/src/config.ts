import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { ChatmailCredentials } from './transport/deltachat.js';
import { atomicWriteText, type FileOwner } from './durable-file.js';
import { acquireInterprocessLock } from './interprocess-lock.js';

export type AccountsFile = Record<string, ChatmailCredentials>;
export type AccountValue = ChatmailCredentials | null;

export class AccountConflictError extends Error {
  constructor(name: string) {
    super(`account credentials changed concurrently: ${name}`);
    this.name = 'AccountConflictError';
  }
}

export class CredentialsFileError extends Error {
  readonly code: string;

  constructor(path: string, operation: string, code: string) {
    super(`cannot ${operation} account credentials file (${code}): ${path}`);
    this.name = 'CredentialsFileError';
    this.code = code;
  }
}

const sameAccount = (left: AccountValue, right: AccountValue): boolean =>
  left === right || Boolean(
    left && right &&
    left.addr === right.addr &&
    left.password === right.password &&
    left.displayName === right.displayName,
  );

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException | null)?.code ?? 'unknown';

const ensureCredentialsParent = (path: string): void => {
  const parent = dirname(path);
  const missing: string[] = [];
  let cursor = parent;
  try {
    while (true) {
      try {
        lstatSync(cursor);
        break;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        missing.push(cursor);
        const next = dirname(cursor);
        if (next === cursor) break;
        cursor = next;
      }
    }
    if (missing.length > 0) {
      for (const created of missing.reverse()) {
        try {
          mkdirSync(created, { mode: 0o700 });
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
        }
        if (process.platform !== 'win32') chmodSync(created, 0o700);
      }
    }
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CredentialsFileError(path, 'use parent', 'unsafe-parent-type');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
      throw new CredentialsFileError(path, 'use parent', 'parent-is-group-or-world-writable');
    }
  } catch (error) {
    if (error instanceof CredentialsFileError) throw error;
    throw new CredentialsFileError(path, 'prepare parent', errorCode(error));
  }
};

type CredentialsSnapshot = { contents: string; owner?: FileOwner };

const readCredentialsSnapshot = (path: string): CredentialsSnapshot | null => {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new CredentialsFileError(path, 'inspect', errorCode(error));
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new CredentialsFileError(path, 'open', 'unsafe-file-type');
  }

  let fd: number | null = null;
  let failure: CredentialsFileError | null = null;
  let snapshot: CredentialsSnapshot | null = null;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    let stat = fstatSync(fd);
    if (!stat.isFile()) throw new CredentialsFileError(path, 'open', 'unsafe-file-type');
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
      try {
        fchmodSync(fd, 0o600);
      } catch (error) {
        throw new CredentialsFileError(path, 'correct permissions', `fchmod-${errorCode(error)}`);
      }
      stat = fstatSync(fd);
      if ((stat.mode & 0o777) !== 0o600) {
        throw new CredentialsFileError(path, 'correct permissions', 'mode-verification-failed');
      }
    }
    snapshot = {
      contents: readFileSync(fd, 'utf8'),
      ...(process.platform === 'win32' ? {} : { owner: { uid: stat.uid, gid: stat.gid } }),
    };
  } catch (error) {
    failure = error instanceof CredentialsFileError
      ? error
      : new CredentialsFileError(path, 'read', errorCode(error));
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch (error) {
        failure ??= new CredentialsFileError(path, 'close', errorCode(error));
      }
    }
  }
  if (failure) throw failure;
  return snapshot;
};

const parseAccounts = (path: string, contents: string): AccountsFile => {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid root');
    return parsed as AccountsFile;
  } catch {
    throw new CredentialsFileError(path, 'parse', 'invalid-json');
  }
};

const writeAccounts = (path: string, accounts: AccountsFile, owner?: FileOwner): void => {
  try {
    atomicWriteText(path, `${JSON.stringify(accounts, null, 2)}\n`, 0o600, owner);
  } catch {
    throw new CredentialsFileError(path, 'write', 'atomic-write-failed');
  }
};

const withAccountsLock = <T>(path: string, operation: () => T): T => {
  ensureCredentialsParent(path);
  const release = acquireInterprocessLock(`${path}.lock`);
  try {
    return operation();
  } finally {
    release();
  }
};

/** Reads the accounts file; an absent file just means "no accounts yet". */
export const readAccounts = (path = 'accounts.local.json'): AccountsFile => {
  ensureCredentialsParent(path);
  const snapshot = readCredentialsSnapshot(path);
  return snapshot ? parseAccounts(path, snapshot.contents) : {};
};

/** Persists (or overwrites) one named account's credentials. */
export const writeAccount = (
  path: string,
  name: string,
  creds: ChatmailCredentials,
): void => {
  withAccountsLock(path, () => {
    const snapshot = readCredentialsSnapshot(path);
    const accounts = snapshot ? parseAccounts(path, snapshot.contents) : {};
    accounts[name] = creds;
    writeAccounts(path, accounts, snapshot?.owner);
  });
};

/** Atomically updates one account entry while preserving unrelated writers. */
export const compareExchangeAccount = (
  path: string,
  name: string,
  expected: AccountValue,
  replacement: AccountValue,
): void => {
  withAccountsLock(path, () => {
    const snapshot = readCredentialsSnapshot(path);
    const accounts = snapshot ? parseAccounts(path, snapshot.contents) : {};
    const current = accounts[name] ?? null;
    if (sameAccount(current, replacement)) return;
    if (!sameAccount(current, expected)) throw new AccountConflictError(name);
    if (replacement === null) delete accounts[name];
    else accounts[name] = replacement;
    writeAccounts(path, accounts, snapshot?.owner);
  });
};
