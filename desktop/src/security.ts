import type { BrowserWindowConstructorOptions } from 'electron';

export const browserWindowOptions = (
  preload: string,
  isPackaged: boolean,
): BrowserWindowConstructorOptions => ({
  show: false,
  webPreferences: {
    preload,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    experimentalFeatures: false,
    devTools: !isPackaged,
    spellcheck: false,
  },
});

export const isAllowedInternalNavigation = (raw: string, expectedOrigin: string): boolean => {
  try {
    const url = new URL(raw);
    return url.origin === expectedOrigin && url.username === '' && url.password === '';
  } catch {
    return false;
  }
};

export const externalHttpUrl = (raw: string, internalOrigin: string): string | null => {
  if (raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password || url.origin === internalOrigin) return null;
    return url.href;
  } catch {
    return null;
  }
};

type SenderFrame = { url: string };
type SenderContents = { mainFrame: SenderFrame };

export const isExpectedStatusSender = (
  event: { sender: unknown; senderFrame: SenderFrame | null },
  expectedContents: SenderContents,
  expectedOrigin: string,
): boolean => {
  if (event.sender !== expectedContents || event.senderFrame !== expectedContents.mainFrame) return false;
  try {
    return new URL(event.senderFrame.url).origin === expectedOrigin;
  } catch {
    return false;
  }
};
