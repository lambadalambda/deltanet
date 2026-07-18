import { parseWorkerToMain, type WorkerToMain } from './protocol.js';

type SupervisorEffects = {
  post(message: unknown): void;
  kill(): void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  shutdownTimeoutMs?: number;
  readinessTimeoutMs?: number | false;
  onRuntimeFailure?: (error: Error) => void;
};

export const createUtilitySupervisor = (effects: SupervisorEffects) => {
  let state: 'starting' | 'ready' | 'failed' | 'closed' = 'starting';
  let resolveReady!: (value: { origin: string }) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<{ origin: string }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const schedule = effects.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = effects.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let resolveShutdown!: () => void;
  let rejectShutdown!: (error: Error) => void;
  const shutdownComplete = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });
  void shutdownComplete.catch(() => {});
  let shutdownStarted = false;
  let shutdownSettled = false;
  let forcedShutdown = false;
  let timeout: unknown = null;
  let readinessTimeout: unknown = null;

  const cancelReadiness = (): void => {
    if (readinessTimeout !== null) cancel(readinessTimeout);
    readinessTimeout = null;
  };

  const fail = (error: Error): void => {
    if (state === 'closed' || state === 'failed') return;
    const wasStarting = state === 'starting';
    state = 'failed';
    cancelReadiness();
    if (wasStarting) rejectReady(error);
    else effects.onRuntimeFailure?.(error);
  };

  const finishClosed = (error?: Error): void => {
    state = 'closed';
    cancelReadiness();
    if (timeout !== null) cancel(timeout);
    timeout = null;
    if (shutdownSettled) return;
    shutdownSettled = true;
    if (error) rejectShutdown(error);
    else resolveShutdown();
  };

  const accept = (value: unknown): void => {
    const message: WorkerToMain = parseWorkerToMain(value);
    if (message.type === 'closed') {
      if (!shutdownStarted) {
        const error = new Error(message.error?.message ?? 'utility closed unexpectedly');
        if (state === 'starting') rejectReady(new Error('utility closed before readiness'));
        else if (state === 'ready') fail(error);
      }
      const closeError = shutdownStarted && message.reason === 'runtime-failure'
        ? new Error(message.error?.message ?? 'utility shutdown failed')
        : undefined;
      finishClosed(closeError);
      return;
    }
    const event = message.event;
    if (event.type === 'ready') {
      if (state !== 'starting') throw new Error('duplicate readiness from utility process');
      state = 'ready';
      cancelReadiness();
      resolveReady({ origin: event.origin });
      return;
    }
    if (event.type === 'fatal') fail(new Error(event.error.message));
  };

  const shutdown = (): Promise<void> => {
    if (shutdownStarted) return shutdownComplete;
    shutdownStarted = true;
    if (state === 'closed') return shutdownComplete;
    try {
      effects.post({ version: 1, type: 'shutdown' });
    } catch (error) {
      finishClosed(error instanceof Error ? error : new Error(String(error)));
      return shutdownComplete;
    }
    timeout = schedule(() => {
      timeout = null;
      forcedShutdown = true;
      effects.kill();
    }, effects.shutdownTimeoutMs ?? 15_000);
    return shutdownComplete;
  };

  const exited = (error: Error): void => {
    if (!shutdownStarted) fail(error);
    finishClosed(shutdownStarted
      ? new Error(forcedShutdown ? 'utility exceeded the shutdown deadline' : error.message)
      : undefined);
  };

  if (effects.readinessTimeoutMs !== false) {
    readinessTimeout = schedule(
      () => fail(new Error('utility exceeded the readiness deadline')),
      effects.readinessTimeoutMs ?? 30_000,
    );
  }

  return { ready, accept, fail, shutdown, exited };
};
