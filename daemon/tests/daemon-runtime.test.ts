import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonConfig, type DaemonEvent } from '../src/daemon.js';
import type { DeltaChatTransport, NativeCoreExit } from '../src/transport/deltachat.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeConfig = (port = 0): DaemonConfig => {
  const root = mkdtempSync(join(tmpdir(), 'headwater-runtime-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  return {
    account: 'main',
    listener: { hostname: '127.0.0.1', port },
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    accountsFile: join(root, 'accounts.json'),
    authFile: join(root, 'auth.json'),
    staticDir: join(root, 'frontend'),
    restoreJournal: `${dataDir}.restore.json`,
    daemonLock: `${dataDir}.daemon.lock`,
    allowedOrigins: [],
    signupRelays: [],
    shutdownTimeoutMs: 2_000,
  };
};

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing listener address'));
      else resolve(address.port);
    });
  });

const closeServer = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

const configuredTransport = (
  onClose: () => void,
  exited: Promise<NativeCoreExit> = new Promise(() => {}),
): DeltaChatTransport => ({
  accountId: 1,
  exited,
  self: async () => ({ displayName: 'Alice', address: 'alice@example.org' }),
  feedInvite: async () => 'https://i.delta.chat/#feed',
  onFollower: () => () => {},
  close: async () => { onClose(); },
  forceClose: async () => { onClose(); },
}) as unknown as DeltaChatTransport;

describe('startDaemon', () => {
  it('reports actual readiness, closes idempotently, and restarts on the same state paths', async () => {
    const events: DaemonEvent[] = [];
    const config = makeConfig();
    const first = await startDaemon(config, { onEvent: (event) => events.push(event) });

    expect(first.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(first.origin).not.toBe(config.baseUrl);
    expect(events.filter((event) => event.type === 'ready')).toEqual([
      { type: 'ready', origin: first.origin, baseUrl: first.origin },
    ]);
    const statusResponse = await fetch(`${first.origin}/api/headwater/status`, {
      headers: { Origin: first.origin },
    });
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toEqual({
      configured: false,
      address: null,
    });

    await Promise.all([first.close(), first.close(), first.close()]);
    await expect(fetch(`${first.origin}/api/headwater/status`)).rejects.toThrow();

    const second = await startDaemon(config);
    await second.close();
  });

  it('rejects occupied ports and releases startup resources', async () => {
    const occupied = createServer();
    const port = await listen(occupied);
    const config = makeConfig(port);

    await expect(startDaemon(config)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await closeServer(occupied);

    const restarted = await startDaemon(config);
    await restarted.close();
  });

  it('waits for configured transport startup and closes it once', async () => {
    const config = makeConfig();
    writeFileSync(config.accountsFile, JSON.stringify({
      main: { addr: 'alice@example.org', password: 'secret', displayName: 'Alice' },
    }));
    let closes = 0;
    const handle = await startDaemon(config, {
      openTransport: async () => configuredTransport(() => { closes += 1; }),
    });

    expect(handle.readiness).toEqual({ origin: handle.origin });
    await Promise.all([handle.close(), handle.close()]);
    expect(closes).toBe(1);
  });

  it('rolls back the lock and emits a fatal event when transport startup fails', async () => {
    const config = makeConfig();
    writeFileSync(config.accountsFile, JSON.stringify({
      main: { addr: 'alice@example.org', password: 'secret', displayName: 'Alice' },
    }));
    const events: DaemonEvent[] = [];

    await expect(startDaemon(config, {
      onEvent: (event) => events.push(event),
      openTransport: async () => { throw new Error('core failed'); },
    })).rejects.toThrow('core failed');
    expect(events.some((event) => event.type === 'ready')).toBe(false);
    expect(events.some((event) => event.type === 'fatal' && event.phase === 'startup')).toBe(true);

    const restarted = await startDaemon(config, {
      openTransport: async () => configuredTransport(() => {}),
    });
    await restarted.close();
  });

  it('turns an unexpected native-core exit into a fatal event and automatic shutdown', async () => {
    const config = makeConfig();
    writeFileSync(config.accountsFile, JSON.stringify({
      main: { addr: 'alice@example.org', password: 'secret', displayName: 'Alice' },
    }));
    const events: DaemonEvent[] = [];
    let resolveExit!: (exit: NativeCoreExit) => void;
    const exited = new Promise<NativeCoreExit>((resolve) => { resolveExit = resolve; });
    const handle = await startDaemon(config, {
      onEvent: (event) => events.push(event),
      openTransport: async () => configuredTransport(() => {}, exited),
    });

    resolveExit({ expected: false, code: 1, signal: null });
    await handle.closed;

    expect(events.some((event) =>
      event.type === 'fatal' && event.phase === 'runtime' && event.component === 'native-core'
    )).toBe(true);
    await expect(fetch(`${handle.origin}/api/headwater/status`)).rejects.toThrow();
  });

  it('releases the process lock even when transport shutdown fails', async () => {
    const config = makeConfig();
    writeFileSync(config.accountsFile, JSON.stringify({
      main: { addr: 'alice@example.org', password: 'secret', displayName: 'Alice' },
    }));
    const failing = configuredTransport(() => {});
    failing.close = async () => { throw new Error('close failed'); };
    const handle = await startDaemon(config, { openTransport: async () => failing });

    await expect(handle.close()).rejects.toThrow('Headwater shutdown failed');

    const restarted = await startDaemon(config, {
      openTransport: async () => configuredTransport(() => {}),
    });
    await restarted.close();
  });

  it('rejects concurrent runtimes for the same state path', async () => {
    const config = makeConfig();
    const first = await startDaemon(config);

    await expect(startDaemon({
      ...config,
      listener: { hostname: '127.0.0.1', port: 0 },
      daemonLock: `${config.dataDir}/../data.daemon.lock`,
    })).rejects.toThrow(/already owns/);

    await first.close();
  });

  it('rejects startup when the native core exits before readiness', async () => {
    const config = makeConfig();
    writeFileSync(config.accountsFile, JSON.stringify({
      main: { addr: 'alice@example.org', password: 'secret', displayName: 'Alice' },
    }));
    const events: DaemonEvent[] = [];
    const stopped = configuredTransport(
      () => {},
      Promise.resolve({ expected: false, code: 1, signal: null }),
    );
    stopped.self = () => new Promise(() => {});

    await expect(startDaemon(config, {
      onEvent: (event) => events.push(event),
      openTransport: async () => stopped,
    })).rejects.toThrow(/exited unexpectedly/);
    expect(events.some((event) => event.type === 'account' || event.type === 'ready')).toBe(false);

    const restarted = await startDaemon(config, {
      openTransport: async () => configuredTransport(() => {}),
    });
    await restarted.close();
  });

  it('bounds a hanging transport close and still releases the lock', async () => {
    const config = { ...makeConfig(), shutdownTimeoutMs: 20 };
    writeFileSync(config.accountsFile, JSON.stringify({
      main: { addr: 'alice@example.org', password: 'secret', displayName: 'Alice' },
    }));
    const hanging = configuredTransport(() => {});
    hanging.close = () => new Promise(() => {});
    hanging.forceClose = async () => {};
    const handle = await startDaemon(config, { openTransport: async () => hanging });

    await expect(handle.close()).rejects.toThrow('Headwater shutdown failed');

    const restarted = await startDaemon(config, {
      openTransport: async () => configuredTransport(() => {}),
    });
    await restarted.close();
  });

  it('isolates event observer failures from lifecycle ownership', async () => {
    const config = makeConfig();
    const handle = await startDaemon(config, {
      onEvent: () => { throw new Error('observer failed'); },
    });

    await handle.close();
    const restarted = await startDaemon(config);
    await restarted.close();
  });

  it('honors an abort signal before acquiring startup resources', async () => {
    const config = makeConfig();
    const controller = new AbortController();
    controller.abort();

    await expect(startDaemon(config, { signal: controller.signal })).rejects.toThrow(/aborted/);

    const restarted = await startDaemon(config);
    await restarted.close();
  });

  it('closes a signup transport that resolves after shutdown begins', async () => {
    const config = makeConfig();
    const events: DaemonEvent[] = [];
    let resolveOpen!: (transport: DeltaChatTransport) => void;
    let signalOpenStarted!: () => void;
    const openStarted = new Promise<void>((resolve) => { signalOpenStarted = resolve; });
    const pendingOpen = new Promise<DeltaChatTransport>((resolve) => { resolveOpen = resolve; });
    let closes = 0;
    const opened = configuredTransport(() => { closes += 1; });
    const handle = await startDaemon(config, {
      onEvent: (event) => events.push(event),
      registerAccount: async () => ({ addr: 'alice@example.org', password: 'secret' }),
      openTransport: async () => {
        signalOpenStarted();
        return pendingOpen;
      },
    });
    const signup = fetch(`${handle.origin}/api/headwater/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Alice' }),
    }).then(async (response) => {
      await response.text();
      return response;
    });
    await openStarted;

    const closing = handle.close();
    resolveOpen(opened);
    await Promise.all([closing, signup.catch(() => null)]);

    expect(closes).toBe(1);
    expect(events.some((event) => event.type === 'account')).toBe(false);
  });
});
