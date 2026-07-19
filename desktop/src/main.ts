import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  session,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
} from 'electron';
import { desktopPaths } from './paths.js';
import { createDesktopBootstrapProof } from './bootstrap-proof.js';
import { createQuitHandler } from './lifecycle.js';
import { createEnrollmentBroker } from './enrollment.js';
import {
  DesktopOAuthRegistrationError,
  registerDesktopOAuthClient,
  type DesktopOAuthClient,
} from './oauth-registration.js';
import { parseWorkerToMain } from './protocol.js';
import { restoreDesktopAccount, saveDesktopBackup, signupDesktopAccount } from './onboarding.js';
import {
  browserWindowOptions,
  externalHttpUrl,
  isAllowedInternalNavigation,
  isExpectedBackupSender,
  isExpectedEnrollmentSender,
  isExpectedStatusSender,
} from './security.js';
import { createUtilitySupervisor } from './supervisor.js';
import { validateDesktopSmokePaths } from './smoke.js';
import { readDesktopSettings, writeDesktopSettings, type DesktopSettings } from './settings.js';

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
    let desktopSettings = readDesktopSettings(paths.settingsFile);
    const updateDesktopSettings = (update: Partial<Pick<DesktopSettings, 'port' | 'backupRequired'>>): void => {
      const next = Object.freeze({ ...desktopSettings, ...update });
      writeDesktopSettings(paths.settingsFile, next);
      desktopSettings = next;
    };
    const desktopBootstrapKey = randomBytes(32).toString('base64url');
    let configured = false;
    let onboardingKind: 'create' | 'restore' | null = null;
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
    let registrationTransaction: Readonly<{ revision: number; key: string }> | null = null;
    const operationControllers = new Set<AbortController>();
    const runOperation = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      operationControllers.add(controller);
      try {
        return await operation(controller.signal);
      } finally {
        operationControllers.delete(controller);
      }
    };
    const abortRegistration = (): void => {
      registrationInFlight?.controller.abort();
      registrationInFlight = null;
      registrationSnapshotRevision = null;
      registrationTransaction = null;
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
      onUnconfigured: () => { configured = false; },
      onAccount: () => {
        configured = true;
      },
      onRuntimeFailure: (error) => {
        abortRegistration();
        for (const controller of operationControllers) controller.abort();
        operationControllers.clear();
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
      for (const controller of operationControllers) controller.abort();
      operationControllers.clear();
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
        listener: { hostname: '127.0.0.1', port: desktopSettings.port },
        baseUrl: `http://127.0.0.1:${desktopSettings.port}`,
        dataDir: paths.dataDir,
        accountsFile: paths.accountsFile,
        authFile: paths.authFile,
        staticDir: paths.staticDir,
        restoreJournal: paths.restoreJournal,
        daemonLock: paths.daemonLock,
        nativeHelperPath: paths.nativeHelper,
        allowedOrigins: [],
        signupRelays: [],
        desktopBootstrapKey,
        shutdownTimeoutMs: 10_000,
      },
    });
    const status = await supervisor.ready;
    const boundPort = Number(new URL(status.origin).port);
    if (!Number.isSafeInteger(boundPort) || boundPort < 1 || boundPort > 65535) throw new Error('invalid desktop listener port');
    if (desktopSettings.port === 0) updateDesktopSettings({ port: boundPort });
    else if (desktopSettings.port !== boundPort) throw new Error('desktop listener did not bind the persisted port');
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
    const registerOAuthClient = (requestedRevision?: number): Promise<DesktopOAuthClient | null> => {
      if (requestedRevision !== undefined && requestedRevision > enrollment.revision()) {
        return Promise.reject(new Error('invalid desktop enrollment revision'));
      }
      if (pendingOAuthClient
        && (requestedRevision === undefined || pendingOAuthClient.revision > requestedRevision)) {
        return Promise.resolve(pendingOAuthClient.client);
      }
      if (registrationInFlight) {
        return registrationInFlight.afterRevision === requestedRevision
          ? registrationInFlight.promise
          : Promise.resolve(null);
      }
      const controller = new AbortController();
      let promise!: Promise<DesktopOAuthClient | null>;
      promise = (async () => {
        try {
          const snapshot = await enrollment.get(requestedRevision);
          if (!snapshot) return null;
          if (controller.signal.aborted || enrollment.revision() !== snapshot.revision) return null;
           registrationSnapshotRevision = snapshot.revision;
           if (registrationTransaction?.revision !== snapshot.revision) {
             registrationTransaction = Object.freeze({ revision: snapshot.revision, key: randomBytes(32).toString('base64url') });
           }
           try {
             const client = await registerDesktopOAuthClient({
               origin: status.origin,
               enrollmentCode: snapshot.code,
               bootstrapProof: createDesktopBootstrapProof({ key: desktopBootstrapKey, operation: 'oauth-register' }),
               idempotencyKey: registrationTransaction.key,
               signal: controller.signal,
            });
            if (controller.signal.aborted || enrollment.revision() !== snapshot.revision) return null;
            pendingOAuthClient = Object.freeze({ revision: snapshot.revision, client });
            enrollment.consume(snapshot.revision);
            return client;
          } catch (error) {
             if (error instanceof DesktopOAuthRegistrationError && error.status === 403) {
               enrollment.consume(snapshot.revision);
               registrationTransaction = null;
            }
            throw error;
          }
        } finally {
          const activeRegistration = registrationInFlight as Readonly<{ controller: AbortController }> | null;
          if (activeRegistration?.controller === controller) {
            registrationInFlight = null;
            registrationSnapshotRevision = null;
          }
        }
      })();
      registrationInFlight = Object.freeze({ afterRevision: requestedRevision, controller, promise });
      return promise;
    };
    ipcMain.handle('headwater:desktop-status', (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 0 || !window || !isExpectedStatusSender(event, contents, status.origin)) {
        throw new Error('unauthorized desktop status request');
      }
      return Object.freeze({
        state: 'ready',
        origin: status.origin,
        configured,
        backupRequired: desktopSettings.backupRequired,
      });
    });
    ipcMain.handle('headwater:write-clipboard', (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const text = args[0];
      if (args.length !== 1 || typeof text !== 'string' || text.length > 1_048_576
        || !window || !isExpectedStatusSender(event, contents, status.origin)) {
        throw new Error('unauthorized desktop clipboard request');
      }
      clipboard.writeText(text);
      return true;
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
      return registerOAuthClient(requestedRevision);
    });
    ipcMain.handle('headwater:acknowledge-oauth-client', (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const clientId = args[0];
      if (args.length !== 1 || typeof clientId !== 'string' || !clientId || clientId.length > 512
        || !window || !isExpectedEnrollmentSender(event, contents, status.origin)
        || pendingOAuthClient?.client.clientId !== clientId) {
        throw new Error('unauthorized desktop OAuth acknowledgement');
      }
      pendingOAuthClient = null;
      registrationTransaction = null;
      return true;
    });
    let selectedRestorePath: string | null = null;
    ipcMain.handle('headwater:select-backup', async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (args.length !== 0 || !window || !isExpectedEnrollmentSender(event, contents, status.origin)) {
        throw new Error('unauthorized desktop restore request');
      }
      const selected = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: 'Headwater backup', extensions: ['dnbk'] }],
      });
      selectedRestorePath = selected.canceled || selected.filePaths.length !== 1 ? null : selected.filePaths[0] ?? null;
      return selectedRestorePath ? Object.freeze({ filename: basename(selectedRestorePath) }) : null;
    });
    ipcMain.handle('headwater:create-account', async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const input = args[0];
      if (args.length !== 1 || typeof input !== 'object' || input === null || Array.isArray(input)
        || Object.keys(input).join(',') !== 'displayName'
        || typeof (input as Record<string, unknown>)['displayName'] !== 'string'
        || !window || !isExpectedEnrollmentSender(event, contents, status.origin)
        || configured || onboardingKind !== null) {
        throw new Error('unauthorized desktop account creation request');
      }
      updateDesktopSettings({ backupRequired: true });
      const baseline = enrollment.revision();
      onboardingKind = 'create';
      try {
        const account = await runOperation((signal) => signupDesktopAccount({
          origin: status.origin,
          bootstrapKey: desktopBootstrapKey,
          displayName: (input as { displayName: string }).displayName,
          signal,
        }));
        const client = await registerOAuthClient(baseline).catch(() => null);
        return Object.freeze({ origin: status.origin, acct: account.acct, client });
      } finally {
        onboardingKind = null;
      }
    });
    ipcMain.handle('headwater:restore-account', async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const passphrase = args[0];
      if (args.length !== 1 || typeof passphrase !== 'string' || !passphrase || passphrase.length > 1024
        || !selectedRestorePath || !window || !isExpectedEnrollmentSender(event, contents, status.origin)
        || configured || onboardingKind !== null) {
        throw new Error('unauthorized desktop restore request');
      }
      const baseline = enrollment.revision();
      onboardingKind = 'restore';
      try {
        const account = await runOperation((signal) => restoreDesktopAccount({
          origin: status.origin,
          bootstrapKey: desktopBootstrapKey,
          backupPath: selectedRestorePath as string,
          passphrase,
          signal,
        }));
        selectedRestorePath = null;
        updateDesktopSettings({ backupRequired: false });
        const client = await registerOAuthClient(baseline).catch(() => null);
        return Object.freeze({ origin: status.origin, acct: account.acct, client });
      } finally {
        onboardingKind = null;
      }
    });
    ipcMain.handle('headwater:save-backup', async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const input = args[0];
      if (args.length !== 1 || typeof input !== 'object' || input === null || Array.isArray(input)
        || Object.keys(input).sort().join(',') !== 'accessToken,passphrase'
        || typeof (input as Record<string, unknown>)['accessToken'] !== 'string'
        || typeof (input as Record<string, unknown>)['passphrase'] !== 'string'
        || !window || !isExpectedBackupSender(event, contents, status.origin)) {
        throw new Error('unauthorized desktop backup request');
      }
      const selected = await dialog.showSaveDialog(window, {
        defaultPath: join(app.getPath('documents'), 'headwater-backup.dnbk'),
        filters: [{ name: 'Headwater backup', extensions: ['dnbk'] }],
      });
      if (selected.canceled || !selected.filePath) return null;
      const saved = await runOperation((signal) => saveDesktopBackup({
        origin: status.origin,
        destination: selected.filePath as string,
        accessToken: (input as { accessToken: string }).accessToken,
        passphrase: (input as { passphrase: string }).passphrase,
        signal,
      }));
      updateDesktopSettings({ backupRequired: false });
      return saved;
    });
    await window.loadURL(status.origin);
    window.show();
    if (smokeMarker) {
      const response = await fetch(status.origin);
      if (!response.ok) throw new Error(`desktop smoke status failed (${response.status})`);
      const clipboardSmokeEnabled = clipboard.availableFormats().length === 0;
      const smokeClipboard = `Headwater desktop smoke ${process.pid}`;
      try {
        const enrollmentBridgeResult: unknown = await contents.executeJavaScript(`
          (async () => {
            try {
              if (${JSON.stringify(clipboardSmokeEnabled)}) {
                await globalThis.headwaterDesktop.writeClipboardText(${JSON.stringify(smokeClipboard)});
              }
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
        if (clipboardSmokeEnabled && clipboard.readText() !== smokeClipboard) {
          throw new Error('desktop smoke clipboard bridge failed');
        }
      } finally {
        if (clipboardSmokeEnabled && clipboard.readText() === smokeClipboard) clipboard.clear();
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
