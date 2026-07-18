import { pathToFileURL } from 'node:url';
import {
  parseMainToWorker,
  toDaemonEventWire,
  toSafeError,
  type DaemonConfigWire,
} from './protocol.js';

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};
type DaemonHandle = { close(): Promise<void> };
type DaemonModule = {
  startDaemon(
    config: DaemonConfigWire,
    dependencies: { signal: AbortSignal; onEvent(event: unknown): void },
  ): Promise<DaemonHandle>;
};

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!parentPort) throw new Error('Headwater utility process has no private parent port');

let handle: DaemonHandle | null = null;
let startPromise: Promise<void> | null = null;
let closed = false;
const controller = new AbortController();

const postClosed = (reason: 'requested' | 'startup-failure' | 'runtime-failure', error?: unknown): void => {
  if (closed) return;
  closed = true;
  parentPort.postMessage({
    version: 1,
    type: 'closed',
    reason,
    ...(error === undefined ? {} : { error: toSafeError(error) }),
  });
};

const start = async (config: DaemonConfigWire): Promise<void> => {
  if (startPromise) throw new Error('duplicate Headwater utility start');
  startPromise = (async () => {
    try {
      const daemonUrl = pathToFileURL(config.nativeHelperPath).href;
      const moduleUrl = new URL('../daemon/dist/daemon.js', daemonUrl).href;
      const daemon = await import(moduleUrl) as DaemonModule;
      handle = await daemon.startDaemon(config, {
        signal: controller.signal,
        onEvent: (event) => parentPort.postMessage({
          version: 1,
          type: 'daemon-event',
          event: toDaemonEventWire(event),
        }),
      });
    } catch (error) {
      postClosed('startup-failure', error);
    }
  })();
  await startPromise;
};

const shutdown = async (): Promise<void> => {
  controller.abort();
  await startPromise?.catch(() => {});
  try {
    await handle?.close();
    postClosed('requested');
  } catch (error) {
    postClosed('runtime-failure', error);
  }
};

parentPort.on('message', (event) => {
  try {
    const message = parseMainToWorker(event.data);
    if (message.type === 'start') {
      void start(message.config).catch((error) => postClosed('runtime-failure', error));
    }
    else void shutdown();
  } catch (error) {
    void shutdown().finally(() => postClosed('runtime-failure', error));
  }
});
