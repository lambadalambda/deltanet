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
import { createEnrollmentBroker } from './enrollment.js';
import {
  DesktopOAuthRegistrationError,
  registerDesktopOAuthClient,
  type DesktopOAuthClient,
} from './oauth-registration.js';
import { parseWorkerToMain } from './protocol.js';
import {
  browserWindowOptions,
  externalHttpUrl,
  isAllowedInternalNavigation,
  isExpectedEnrollmentSender,
  isExpectedStatusSender,
} from './security.js';
import { createUtilitySupervisor } from './supervisor.js';
import { validateDesktopSmokePaths } from './smoke.js';

const requestedSmokeMarker = app.commandLine.getSwitchValue('headwater-desktop-smoke-marker')
  || process.env['HEADWATER_DESKTOP_SMOKE_MARKER']
  || '';
const smokePaths = validateDesktopSmokePaths({
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
const enrollment = createEnrollmentBroker();
const smokeMarker = smokePaths?.marker ?? '';
let smokeFailed = false;
const reportSmoke = (state: 'starting' | 'ready' | 'closed' | 'failed', detail?: string): void => {
  if (state === 'closed' && smokeFailed) return;
  if (state === 'failed') smokeFailed = true;
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
    const resourceRoot = app.isPackaged ? process.resourcesPath : `${appDir}/resources`;
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
    let pendingOAuthClient: Readonly<{ revision: number; client: DesktopOAuthClient }> | null = null;
    let registrationInFlight: Readonly<{
      afterRevision: number | undefined;
      controller: AbortController;
      promise: Promise<DesktopOAuthClient | null>;
    }> | null = null;
    let registrationSnapshotRevision: number | null = null;
    const abortRegistration = (): void => {
      registrationInFlight?.controller.abort();
      registrationInFlight = null;
      registrationSnapshotRevision = null;
    };
    const supervisor = createUtilitySupervisor({
      post: (message) => child.postMessage(message),
      kill: () => { child.kill(); },
      shutdownTimeoutMs: 15_000,
      readinessTimeoutMs: 30_000,
      onEnrollmentCode: (value) => {
        if (registrationSnapshotRevision !== null) abortRegistration();
        pendingOAuthClient = null;
        enrollment.publish(value);
      },
      onRuntimeFailure: (error) => {
        abortRegistration();
        enrollment.close();
        window?.destroy();
        window = null;
        process.exitCode = 1;
        reportSmoke('failed', error.message);
        if (!smokeMarker) dialog.showErrorBox('Headwater stopped', error.message);
        app.quit();
      },
    });
    shutdownUtility = async () => {
      abortRegistration();
      pendingOAuthClient = null;
      enrollment.close();
      await supervisor.shutdown();
    };
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
    ipcMain.handle('headwater:enrollment-revision', (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 0 || !window || !isExpectedEnrollmentSender(event, contents, status.origin)) {
        throw new Error('unauthorized desktop enrollment request');
      }
      return enrollment.revision();
    });
    ipcMain.handle('headwater:register-oauth-client', (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const afterRevision = args[0];
      if (args.length > 1
        || (args.length === 1 && (!Number.isSafeInteger(afterRevision) || (afterRevision as number) < 0))
        || !window
        || !isExpectedEnrollmentSender(event, contents, status.origin)) {
        throw new Error('unauthorized desktop enrollment request');
      }
      const requestedRevision = args.length === 0 ? undefined : afterRevision as number;
      if (requestedRevision !== undefined && requestedRevision > enrollment.revision()) {
        throw new Error('invalid desktop enrollment revision');
      }
      if (pendingOAuthClient
        && (requestedRevision === undefined || pendingOAuthClient.revision > requestedRevision)) {
        return pendingOAuthClient.client;
      }
      if (registrationInFlight) {
        return registrationInFlight.afterRevision === requestedRevision
          ? registrationInFlight.promise
          : null;
      }
      const controller = new AbortController();
      let promise!: Promise<DesktopOAuthClient | null>;
      promise = (async () => {
        try {
          const snapshot = await enrollment.get(requestedRevision);
          if (!snapshot) return null;
          if (controller.signal.aborted || enrollment.revision() !== snapshot.revision) return null;
          registrationSnapshotRevision = snapshot.revision;
          try {
            const client = await registerDesktopOAuthClient({
              origin: status.origin,
              enrollmentCode: snapshot.code,
              signal: controller.signal,
            });
            if (controller.signal.aborted || enrollment.revision() !== snapshot.revision) return null;
            pendingOAuthClient = Object.freeze({ revision: snapshot.revision, client });
            enrollment.consume(snapshot.revision);
            return client;
          } catch (error) {
            if (error instanceof DesktopOAuthRegistrationError && error.status === 403) {
              enrollment.consume(snapshot.revision);
            }
            throw error;
          }
        } finally {
          const activeRegistration = registrationInFlight as Readonly<{
            controller: AbortController;
          }> | null;
          if (activeRegistration?.controller === controller) {
            registrationInFlight = null;
            registrationSnapshotRevision = null;
          }
        }
      })();
      registrationInFlight = Object.freeze({ afterRevision: requestedRevision, controller, promise });
      return promise;
    });
    ipcMain.handle('headwater:acknowledge-oauth-client', (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const clientId = args[0];
      if (args.length !== 1 || typeof clientId !== 'string' || !clientId || clientId.length > 512
        || !window || !isExpectedEnrollmentSender(event, contents, status.origin)
        || pendingOAuthClient?.client.clientId !== clientId) {
        throw new Error('unauthorized desktop OAuth acknowledgement');
      }
      pendingOAuthClient = null;
      return true;
    });
    await window.loadURL(status.origin);
    window.show();
    if (smokeMarker) {
      const response = await fetch(status.origin);
      if (!response.ok) throw new Error(`desktop smoke status failed (${response.status})`);
      const enrollmentBridgeResult: unknown = await contents.executeJavaScript(`
        (async () => {
          try {
            const revision = await globalThis.headwaterDesktop.getEnrollmentRevision();
            const client = await globalThis.headwaterDesktop.registerOAuthClient();
            if (client !== null) await globalThis.headwaterDesktop.acknowledgeOAuthClient(client.clientId);
            const second = await globalThis.headwaterDesktop.registerOAuthClient();
            return { ready: Number.isSafeInteger(revision)
              && revision > 0
              && client !== null
              && client.origin === ${JSON.stringify(status.origin)}
              && typeof client.clientId === 'string'
              && client.clientId.length > 0
              && typeof client.clientSecret === 'string'
              && client.clientSecret.length > 0
              && second === null };
          } catch (error) {
            return { ready: false, detail: error instanceof Error ? error.message : String(error) };
          }
        })()
      `, true);
      const smokeResult = enrollmentBridgeResult as { ready?: unknown; detail?: unknown } | null;
      if (smokeResult?.ready !== true) {
        const detail = typeof smokeResult?.detail === 'string' ? `: ${smokeResult.detail.slice(0, 512)}` : '';
        throw new Error(`desktop smoke enrollment bridge failed${detail}`);
      }
      reportSmoke('ready');
      app.quit();
    }
  } catch (error) {
    enrollment.close();
    process.exitCode = 1;
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    reportSmoke('failed', message);
    if (!smokeMarker) dialog.showErrorBox('Headwater could not start', message);
    app.quit();
  }
};

if (ownsInstance) void run();
