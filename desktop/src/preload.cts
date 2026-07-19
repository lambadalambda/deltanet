const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

type DesktopStatus = Readonly<{
  state: 'ready';
  origin: string;
  configured: boolean;
  backupRequired: boolean;
}>;
type DesktopOAuthClient = Readonly<{ origin: string; clientId: string; clientSecret: string }>;

const exactRecord = (value: unknown, keys: readonly string[], message: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(message);
  return record;
};

const localOrigin = (value: unknown, message: string): string => {
  if (typeof value !== 'string') throw new Error(message);
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== value) throw new Error(message);
  return value;
};

const parseStatus = (value: unknown): DesktopStatus => {
  const status = exactRecord(value, ['backupRequired', 'configured', 'origin', 'state'], 'invalid desktop status');
  if (status['state'] !== 'ready' || typeof status['configured'] !== 'boolean' || typeof status['backupRequired'] !== 'boolean') {
    throw new Error('invalid desktop status');
  }
  return Object.freeze({
    state: 'ready',
    origin: localOrigin(status['origin'], 'invalid desktop status'),
    configured: status['configured'],
    backupRequired: status['backupRequired'],
  });
};

const filename = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 255 || /[/\\]/.test(value)) throw new Error('invalid desktop backup filename');
  return value;
};

const parseSelectedBackup = (value: unknown): Readonly<{ filename: string }> | null => {
  if (value === null) return null;
  const selected = exactRecord(value, ['filename'], 'invalid desktop backup selection');
  return Object.freeze({ filename: filename(selected['filename']) });
};

const parseOnboardingResult = (value: unknown) => {
  const result = exactRecord(value, ['acct', 'client', 'origin'], 'invalid desktop onboarding result');
  if (typeof result['acct'] !== 'string' || !result['acct'] || result['acct'].length > 512) {
    throw new Error('invalid desktop onboarding result');
  }
  return Object.freeze({
    origin: localOrigin(result['origin'], 'invalid desktop onboarding result'),
    acct: result['acct'],
    client: parseDesktopOAuthClient(result['client']),
  });
};

const parseDesktopOAuthClient = (value: unknown): DesktopOAuthClient | null => {
  if (value === null) return null;
  const client = exactRecord(value, ['origin', 'clientId', 'clientSecret'], 'invalid desktop OAuth client');
  if (typeof client['clientId'] !== 'string' || !client['clientId'] || client['clientId'].length > 512
    || typeof client['clientSecret'] !== 'string' || !client['clientSecret'] || client['clientSecret'].length > 512) {
    throw new Error('invalid desktop OAuth client');
  }
  return Object.freeze({
    origin: localOrigin(client['origin'], 'invalid desktop OAuth client'),
    clientId: client['clientId'],
    clientSecret: client['clientSecret'],
  });
};

contextBridge.exposeInMainWorld('headwaterDesktop', Object.freeze({
  writeClipboardText: async (text: string) => {
    if (typeof text !== 'string' || text.length > 1_048_576) throw new Error('invalid desktop clipboard text');
    if (navigator.userActivation?.isActive !== true) throw new Error('desktop clipboard write requires user activation');
    const written: unknown = await ipcRenderer.invoke('headwater:write-clipboard', text);
    if (written !== true) throw new Error('invalid desktop clipboard response');
  },
  getStatus: async () => parseStatus(await ipcRenderer.invoke('headwater:desktop-status')),
  getEnrollmentRevision: async () => {
    const revision: unknown = await ipcRenderer.invoke('headwater:enrollment-revision');
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new Error('invalid enrollment revision');
    return revision as number;
  },
  registerOAuthClient: async (afterRevision?: number) => {
    if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) {
      throw new Error('invalid enrollment revision');
    }
    return parseDesktopOAuthClient(await ipcRenderer.invoke(
      'headwater:register-oauth-client',
      ...(afterRevision === undefined ? [] : [afterRevision]),
    ));
  },
  acknowledgeOAuthClient: async (clientId: string) => {
    if (typeof clientId !== 'string' || !clientId || clientId.length > 512) throw new Error('invalid desktop OAuth client');
    const acknowledged: unknown = await ipcRenderer.invoke('headwater:acknowledge-oauth-client', clientId);
    if (acknowledged !== true) throw new Error('invalid desktop OAuth acknowledgement');
  },
  selectBackup: async () => parseSelectedBackup(await ipcRenderer.invoke('headwater:select-backup')),
  createAccount: async (input: Readonly<{ displayName: string }>) => {
    const displayName = input?.displayName;
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 200
      || Object.keys(input).join(',') !== 'displayName') throw new Error('invalid desktop account creation input');
    return parseOnboardingResult(await ipcRenderer.invoke('headwater:create-account', { displayName }));
  },
  restoreAccount: async (passphrase: string) => {
    if (typeof passphrase !== 'string' || !passphrase || passphrase.length > 1024) throw new Error('invalid desktop restore input');
    return parseOnboardingResult(await ipcRenderer.invoke('headwater:restore-account', passphrase));
  },
  saveBackup: async (input: Readonly<{ accessToken: string; passphrase: string }>) => {
    if (typeof input?.accessToken !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input.accessToken) || input.accessToken.length > 512
      || typeof input.passphrase !== 'string' || !input.passphrase || input.passphrase.length > 1024
      || Object.keys(input).sort().join(',') !== 'accessToken,passphrase') throw new Error('invalid desktop backup input');
    return parseSelectedBackup(await ipcRenderer.invoke('headwater:save-backup', input));
  },
}));
