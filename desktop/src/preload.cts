const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

type DesktopStatus = Readonly<{ state: 'ready'; origin: string }>;

const parseStatus = (value: unknown): DesktopStatus => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid desktop status');
  const status = value as Record<string, unknown>;
  if (Object.keys(status).sort().join(',') !== 'origin,state' || status.state !== 'ready') {
    throw new Error('invalid desktop status');
  }
  if (typeof status.origin !== 'string') throw new Error('invalid desktop status');
  const url = new URL(status.origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== status.origin) {
    throw new Error('invalid desktop status');
  }
  return Object.freeze({ state: 'ready', origin: status.origin });
};

contextBridge.exposeInMainWorld('headwaterDesktop', Object.freeze({
  getStatus: async (): Promise<DesktopStatus> => parseStatus(await ipcRenderer.invoke('headwater:desktop-status')),
}));
