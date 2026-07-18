const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

type DesktopStatus = Readonly<{ state: 'ready'; origin: string }>;
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
  const status = exactRecord(value, ['origin', 'state'], 'invalid desktop status');
  if (status['state'] !== 'ready') throw new Error('invalid desktop status');
  return Object.freeze({ state: 'ready', origin: localOrigin(status['origin'], 'invalid desktop status') });
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
}));
