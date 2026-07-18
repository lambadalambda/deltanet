import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
} from 'electron';
import { desktopPaths } from './paths.js';
import { createQuitHandler } from './lifecycle.js';
import { parseWorkerToMain } from './protocol.js';
import {
  browserWindowOptions,
  externalHttpUrl,
  isAllowedInternalNavigation,
  isExpectedStatusSender,
} from './security.js';
import { createUtilitySupervisor } from './supervisor.js';
import { validateDesktopSmokePaths } from './smoke.js';

const requestedSmokeMarker = app.commandLine.getSwitchValue('headwater-desktop-smoke-marker')
  || process.env['HEADWATER_DESKTOP_SMOKE_MARKER']
  || '';
const smokePaths = validateDesktopSmokePaths({
  isPackaged: app.isPackaged,
  root: process.env['HEADWATER_DESKTOP_SMOKE_ROOT'] || '',
  marker: requestedSmokeMarker,
});
if (smokePaths) app.setPath('userData', smokePaths.root);
app.enableSandbox();
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();

let window: BrowserWindow | null = null;
let shutdownUtility: (() => Promise<void>) | null = null;
let smokeOrigin: string | null = null;
const smokeMarker = smokePaths?.marker ?? '';
const reportSmoke = (state: 'starting' | 'ready' | 'closed' | 'failed', detail?: string): void => {
  if (smokeMarker) {
    writeFileSync(smokeMarker, `${JSON.stringify({ state, origin: smokeOrigin, ...(detail ? { detail } : {}) })}\n`, { mode: 0o600 });
  }
};
reportSmoke('starting');

app.on('before-quit', createQuitHandler({
  destroyWindow: () => { window?.destroy(); },
  shutdown: () => shutdownUtility?.() ?? Promise.resolve(),
  complete: (error) => {
    if (error) {
      process.exitCode = 1;
      reportSmoke('failed', error.message);
    } else {
      reportSmoke('closed');
    }
    app.exit(error ? 1 : typeof process.exitCode === 'number' ? process.exitCode : 0);
  },
}));

const run = async (): Promise<void> => {
  try {
    await app.whenReady();
    const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const resourceRoot = app.isPackaged && !smokeMarker ? process.resourcesPath : `${appDir}/resources`;
    const paths = desktopPaths({ appDir, resourcesPath: resourceRoot, userData: app.getPath('userData') });
    const rendererSession = session.fromPath(`${app.getPath('userData')}/renderer-session`, { cache: true });
    rendererSession.setPermissionCheckHandler(() => false);
    rendererSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    rendererSession.on('will-download', (event) => event.preventDefault());

    const child = utilityProcess.fork(paths.worker, [], {
      cwd: app.getPath('userData'),
      env: { PATH: process.env['PATH'] },
      stdio: 'ignore',
      serviceName: 'Headwater Daemon',
      allowLoadingUnsignedLibraries: false,
    });
    const supervisor = createUtilitySupervisor({
      post: (message) => child.postMessage(message),
      kill: () => { child.kill(); },
      shutdownTimeoutMs: 15_000,
      readinessTimeoutMs: 30_000,
      onRuntimeFailure: (error) => {
        window?.destroy();
        window = null;
        process.exitCode = 1;
        reportSmoke('failed', error.message);
        if (!smokeMarker) dialog.showErrorBox('Headwater stopped', error.message);
        app.quit();
      },
    });
    shutdownUtility = supervisor.shutdown;
    child.on('message', (message) => {
      try {
        supervisor.accept(parseWorkerToMain(message));
      } catch (error) {
        supervisor.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on('exit', (code) => supervisor.exited(new Error(`Headwater utility exited (${code})`)));
    child.on('error', (_type, location) => supervisor.fail(new Error(`Headwater utility failed at ${location}`)));
    child.postMessage({
      version: 1,
      type: 'start',
      config: {
        account: 'main',
        listener: { hostname: '127.0.0.1', port: 0 },
        baseUrl: 'http://127.0.0.1:0',
        dataDir: paths.dataDir,
        accountsFile: paths.accountsFile,
        authFile: paths.authFile,
        staticDir: paths.staticDir,
        restoreJournal: paths.restoreJournal,
        daemonLock: paths.daemonLock,
        nativeHelperPath: paths.nativeHelper,
        allowedOrigins: [],
        signupRelays: [],
        shutdownTimeoutMs: 10_000,
      },
    });
    const status = await supervisor.ready;
    smokeOrigin = status.origin;
    window = new BrowserWindow({
      ...browserWindowOptions(paths.preload, app.isPackaged),
      webPreferences: { ...browserWindowOptions(paths.preload, app.isPackaged).webPreferences, session: rendererSession },
    });
    const contents = window.webContents;
    contents.on('will-frame-navigate', (event) => {
      if (!isAllowedInternalNavigation(event.url, status.origin)) event.preventDefault();
    });
    contents.on('will-redirect', (event) => {
      if (!isAllowedInternalNavigation(event.url, status.origin)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      const external = externalHttpUrl(url, status.origin);
      if (external) void shell.openExternal(external);
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    ipcMain.handle('headwater:desktop-status', (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 0 || !window || !isExpectedStatusSender(event, contents, status.origin)) {
        throw new Error('unauthorized desktop status request');
      }
      return Object.freeze({ state: 'ready', origin: status.origin });
    });
    await window.loadURL(status.origin);
    window.show();
    if (smokeMarker) {
      const response = await fetch(status.origin);
      if (!response.ok) throw new Error(`desktop smoke status failed (${response.status})`);
      reportSmoke('ready');
      app.quit();
    }
  } catch (error) {
    process.exitCode = 1;
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    reportSmoke('failed', message);
    if (!smokeMarker) dialog.showErrorBox('Headwater could not start', message);
    app.quit();
  }
};

if (ownsInstance) void run();
