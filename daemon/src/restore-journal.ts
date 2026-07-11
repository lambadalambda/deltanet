import {
  atomicWriteText,
  durableRemove,
  readOptionalText,
  replaceOptionalText,
} from './durable-file.js';
import { validateSigningKeySnapshot } from './attest.js';
import {
  compareExchangeAccount,
  readAccounts,
  type AccountValue,
} from './config.js';
import { createStore, type Store } from './store.js';
import type { ChatmailCredentials } from './transport/deltachat.js';

const JOURNAL_VERSION = 1;

type SidecarRoots = {
  store: string | null;
  signingKey: string | null;
  account: AccountValue;
};

type RestoreJournal = {
  version: typeof JOURNAL_VERSION;
  phase: 'prepared' | 'installed' | 'credentials-prepared' | 'committed';
  paths: {
    store: string;
    storeLock: string;
    signingKey: string;
    accounts: string | null;
    accountName: string | null;
  };
  previous: SidecarRoots;
  donor: SidecarRoots;
};

export type RestoreJournalOperation =
  | 'install-store'
  | 'install-signing-key'
  | 'rollback-store'
  | 'rollback-signing-key'
  | 'rollback-accounts';

type BeginInput = {
  journalPath: string;
  store: Store;
  signingKeyPath: string;
  accountsPath?: string;
  accountName?: string;
  donorStore?: string;
  donorSigningKey?: string;
};

type JournalOptions = {
  beforeOperation?: (operation: RestoreJournalOperation) => void;
};

const serialized = (journal: RestoreJournal): string => `${JSON.stringify(journal, null, 2)}\n`;

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isRoots = (value: unknown): value is SidecarRoots => {
  const roots = value as Partial<SidecarRoots> | null;
  return Boolean(
    roots &&
    isNullableString(roots.store) &&
    isNullableString(roots.signingKey) &&
    (roots.account === null || (
      typeof roots.account === 'object' &&
      typeof roots.account.addr === 'string' &&
      typeof roots.account.password === 'string' &&
      typeof roots.account.displayName === 'string'
    )),
  );
};

const readJournal = (path: string): RestoreJournal => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readOptionalText(path) ?? 'null');
  } catch {
    throw new Error(`malformed restore journal: ${path}`);
  }
  const value = parsed as Partial<RestoreJournal> | null;
  if (
    !value ||
    value.version !== JOURNAL_VERSION ||
    !['prepared', 'installed', 'credentials-prepared', 'committed'].includes(String(value.phase)) ||
    !value.paths ||
    typeof value.paths.store !== 'string' ||
    typeof value.paths.storeLock !== 'string' ||
    typeof value.paths.signingKey !== 'string' ||
    (value.paths.accounts !== null && typeof value.paths.accounts !== 'string') ||
    (value.paths.accountName !== null && typeof value.paths.accountName !== 'string') ||
    ((value.paths.accounts === null) !== (value.paths.accountName === null)) ||
    !isRoots(value.previous) ||
    !isRoots(value.donor) ||
    ((value.phase === 'credentials-prepared' || value.phase === 'committed') &&
      value.paths.accounts !== null && value.donor.account === null)
  ) {
    throw new Error(`malformed restore journal: ${path}`);
  }
  return value as RestoreJournal;
};

const installRoots = (
  journal: RestoreJournal,
  roots: SidecarRoots,
  preserveNewerStore = false,
): void => {
  if (roots.signingKey !== null) validateSigningKeySnapshot(roots.signingKey);
  // Store replacement acquires the same process lock as ordinary writes and
  // installs a fresh generation instead of racing raw file replacement.
  const store = createStore(journal.paths.store, { lockPath: journal.paths.storeLock });
  let installStore = true;
  if (preserveNewerStore) {
    const current = store.readSnapshot();
    if (current && roots.store === null) {
      installStore = false;
    } else if (current && roots.store !== null) {
      const donorGeneration = Number((JSON.parse(roots.store) as { generation?: unknown }).generation);
      if (current.generation > donorGeneration) {
        installStore = false;
      } else if (current.generation === donorGeneration) {
        if (current.contents !== roots.store) {
          throw new Error(`ambiguous committed restore store generation: ${current.generation}`);
        }
        installStore = false;
      }
    }
  }
  if (installStore) store.replaceSnapshot(roots.store);
  replaceOptionalText(journal.paths.signingKey, roots.signingKey);
};

const reconcileAccount = (
  journal: RestoreJournal,
  expected: AccountValue,
  replacement: AccountValue,
): void => {
  if (!journal.paths.accounts || !journal.paths.accountName) return;
  compareExchangeAccount(journal.paths.accounts, journal.paths.accountName, expected, replacement);
};

/** The journal is a sibling of the core directory because core import requires that directory to be empty. */
export const restoreJournalPathFor = (dataDir: string): string =>
  `${dataDir}.sidecar-restore-journal.json`;

export const beginSidecarRestore = (
  input: BeginInput,
  options: JournalOptions = {},
) => {
  if ((input.accountsPath === undefined) !== (input.accountName === undefined)) {
    throw new Error('restore journal accountsPath and accountName must be provided together');
  }
  if (readOptionalText(input.journalPath) !== null) {
    throw new Error(`an interrupted restore journal already exists: ${input.journalPath}`);
  }
  if (input.donorSigningKey !== undefined) validateSigningKeySnapshot(input.donorSigningKey);
  const previous: SidecarRoots = {
    store: input.store.readSnapshot()?.contents ?? null,
    signingKey: readOptionalText(input.signingKeyPath),
    account: input.accountsPath && input.accountName
      ? readAccounts(input.accountsPath)[input.accountName] ?? null
      : null,
  };
  let journal: RestoreJournal = {
    version: JOURNAL_VERSION,
    phase: 'prepared',
    paths: {
      store: input.store.filePath,
      storeLock: input.store.lockPath,
      signingKey: input.signingKeyPath,
      accounts: input.accountsPath ?? null,
      accountName: input.accountName ?? null,
    },
    previous,
    donor: {
      store: input.donorStore ?? previous.store,
      signingKey: input.donorSigningKey ?? previous.signingKey,
      account: null,
    },
  };
  atomicWriteText(input.journalPath, serialized(journal));

  return {
    install: (): void => {
      options.beforeOperation?.('install-store');
      input.store.replaceSnapshot(journal.donor.store);
      options.beforeOperation?.('install-signing-key');
      replaceOptionalText(input.signingKeyPath, journal.donor.signingKey);
      journal = {
        ...journal,
        phase: 'installed',
        donor: {
          ...journal.donor,
          store: input.store.readSnapshot()?.contents ?? null,
          signingKey: readOptionalText(input.signingKeyPath),
        },
      };
      atomicWriteText(input.journalPath, serialized(journal));
    },
    persistCredentials: (credentials: ChatmailCredentials): void => {
      if (journal.phase !== 'installed') throw new Error('restore sidecars are not installed');
      journal = {
        ...journal,
        phase: 'credentials-prepared',
        donor: {
          ...journal.donor,
          store: input.store.readSnapshot()?.contents ?? null,
          signingKey: readOptionalText(input.signingKeyPath),
          account: credentials,
        },
      };
      atomicWriteText(input.journalPath, serialized(journal));
      reconcileAccount(journal, journal.previous.account, credentials);
      journal = { ...journal, phase: 'committed' };
      atomicWriteText(input.journalPath, serialized(journal));
    },
    rollback: (): void => {
      if (journal.phase === 'committed') {
        throw new Error('credentials are committed; restore journal cannot roll back');
      }
      options.beforeOperation?.('rollback-store');
      input.store.replaceSnapshot(journal.previous.store);
      options.beforeOperation?.('rollback-signing-key');
      replaceOptionalText(input.signingKeyPath, journal.previous.signingKey);
      if (journal.phase === 'credentials-prepared') {
        options.beforeOperation?.('rollback-accounts');
        reconcileAccount(journal, journal.donor.account, journal.previous.account);
      }
      durableRemove(input.journalPath);
    },
    finish: (): void => {
      if (input.accountsPath && journal.phase !== 'committed') {
        throw new Error('restore credentials are not committed');
      }
      durableRemove(input.journalPath);
    },
    get phase(): RestoreJournal['phase'] {
      return journal.phase;
    },
  };
};

export const recoverInterruptedSidecarRestore = (journalPath: string): void => {
  if (readOptionalText(journalPath) === null) return;
  const journal = readJournal(journalPath);
  const roots = journal.phase === 'committed' ? journal.donor : journal.previous;
  installRoots(journal, roots, journal.phase === 'committed');
  if (journal.phase === 'committed') {
    reconcileAccount(journal, journal.previous.account, journal.donor.account);
  } else if (journal.phase === 'credentials-prepared') {
    reconcileAccount(journal, journal.donor.account, journal.previous.account);
  }
  durableRemove(journalPath);
  console.error(
    journal.phase === 'committed'
      ? `Completed interrupted sidecar restore from ${journalPath}`
      : `Rolled back interrupted sidecar restore from ${journalPath}`,
  );
};
