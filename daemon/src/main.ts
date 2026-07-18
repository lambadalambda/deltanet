import { resolve } from 'node:path';
import { resolveDaemonConfig } from './config.js';
import { startDaemon, type DaemonEvent, type DaemonHandle } from './daemon.js';
import { resolveListenerConfig } from './listener.js';
import { restoreJournalPathFor } from './restore-journal.js';

const renderEvent = (event: DaemonEvent): void => {
  switch (event.type) {
    case 'enrollment-code':
      console.log(`Headwater: one-time frontend enrollment code (10 minutes): ${event.code}`);
      break;
    case 'configuring':
      console.log(`configuring ${event.address} (data: ${event.dataDir}) ...`);
      break;
    case 'account':
      console.log(`logged in as ${event.displayName} <${event.address}>`);
      console.log(`your feed invite: ${event.feedInvite}`);
      break;
    case 'unconfigured':
      console.log(`no account "${event.account}" configured yet; POST /api/headwater/signup to create one`);
      break;
    case 'static-frontend':
      console.log(`serving static frontend from ${event.path}`);
      break;
    case 'ready':
      console.log(`Headwater: Mastodon API on ${event.baseUrl} (listening on ${event.origin})`);
      break;
    case 'diagnostic':
      console.error(`${event.component} failed (non-fatal):`, event.error);
      break;
    case 'fatal':
      console.error(`Headwater ${event.phase} failure (${event.component}):`, event.error);
      break;
  }
};

const run = async (): Promise<void> => {
  const listener = resolveListenerConfig(process.env);
  const resolved = resolveDaemonConfig(process.env, listener.port);
  const dataDir = resolve(process.cwd(), resolved.dataDir);
  const controller = new AbortController();
  let handle: DaemonHandle | null = null;
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    void handle?.close().catch((error) => {
      console.error('Headwater shutdown failed:', error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
  handle = await startDaemon({
    account: resolved.account,
    listener,
    baseUrl: resolved.baseUrl,
    dataDir,
    accountsFile: resolve(process.cwd(), resolved.accountsFile),
    authFile: resolve(process.cwd(), resolved.authFile),
    staticDir: resolve(process.cwd(), resolved.staticDir),
    restoreJournal: restoreJournalPathFor(dataDir),
    daemonLock: `${dataDir}.daemon.lock`,
    nativeHelperPath: process.env['DELTA_CHAT_RPC_SERVER']
      ? resolve(process.cwd(), process.env['DELTA_CHAT_RPC_SERVER'])
      : undefined,
    allowedOrigins: resolved.allowedOrigins,
    signupRelays: resolved.signupRelays,
  }, { onEvent: renderEvent, signal: controller.signal });
  if (stopping) await handle.close();
  } catch (error) {
    if (!stopping) throw error;
  }
};

await run().catch((error) => {
  console.error('Headwater failed to start:', error);
  process.exitCode = 1;
});
