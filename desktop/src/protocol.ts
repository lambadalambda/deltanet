import { isAbsolute } from 'node:path';

export type SafeError = Readonly<{ name: string; message: string; code?: string }>;

export type DaemonConfigWire = Readonly<{
  account: 'main';
  listener: Readonly<{ hostname: '127.0.0.1'; port: 0 }>;
  baseUrl: 'http://127.0.0.1:0';
  dataDir: string;
  accountsFile: string;
  authFile: string;
  staticDir: string;
  restoreJournal: string;
  daemonLock: string;
  nativeHelperPath: string;
  allowedOrigins: string[];
  signupRelays: string[];
  shutdownTimeoutMs: 10_000;
}>;

export type MainToWorker =
  | Readonly<{ version: 1; type: 'start'; config: DaemonConfigWire }>
  | Readonly<{ version: 1; type: 'shutdown' }>;

export type DaemonEventWire =
  | Readonly<{ type: 'enrollment-code'; code: string; expiresAt: number }>
  | Readonly<{ type: 'configuring'; address: string; dataDir: string }>
  | Readonly<{ type: 'account'; displayName: string; address: string; feedInvite: string }>
  | Readonly<{ type: 'unconfigured'; account: string }>
  | Readonly<{ type: 'static-frontend'; path: string }>
  | Readonly<{ type: 'ready'; origin: string; baseUrl: string }>
  | Readonly<{ type: 'diagnostic'; component: string; error: SafeError; recoverable: true }>
  | Readonly<{ type: 'fatal'; phase: 'startup' | 'runtime'; component: string; error: SafeError }>;

export type WorkerToMain =
  | Readonly<{ version: 1; type: 'daemon-event'; event: DaemonEventWire }>
  | Readonly<{
      version: 1;
      type: 'closed';
      reason: 'requested' | 'startup-failure' | 'runtime-failure';
      error?: SafeError;
    }>;

const fail = (): never => { throw new Error('invalid desktop protocol message'); };
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : fail();
const exact = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
};
const string = (value: unknown, max = 4096): string =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : fail();
const stringArray = (value: unknown): string[] =>
  Array.isArray(value) && value.length <= 32 ? value.map((entry) => string(entry, 2048)) : fail();
const absolutePath = (value: unknown): string => {
  const path = string(value);
  return isAbsolute(path) ? path : fail();
};

const safeError = (value: unknown): SafeError => {
  const error = record(value);
  const keys = error['code'] === undefined ? ['name', 'message'] : ['name', 'message', 'code'];
  exact(error, keys);
  return {
    name: string(error['name'], 128),
    message: string(error['message'], 2048),
    ...(error['code'] === undefined ? {} : { code: string(error['code'], 128) }),
  };
};

export const toSafeError = (value: unknown): SafeError => {
  const read = (field: () => unknown, fallback: string, max: number): string => {
    try {
      const result = field();
      return typeof result === 'string' && result ? result.slice(0, max) : fallback;
    } catch {
      return fallback;
    }
  };
  let isError = false;
  try {
    isError = value instanceof Error;
  } catch {
    // Revoked proxies and hostile cross-realm values are treated as unknown errors.
  }
  const error = value as Error;
  const message = isError
    ? read(() => error.message, 'Unknown error', 2048)
    : read(() => String(value), 'Unknown error', 2048);
  const code = read(() => (value as NodeJS.ErrnoException | null)?.code, '', 128);
  return {
    name: isError ? read(() => error.name, 'Error', 128) : 'Error',
    message,
    ...(code ? { code } : {}),
  };
};

const daemonConfig = (value: unknown): DaemonConfigWire => {
  const config = record(value);
  exact(config, [
    'account', 'listener', 'baseUrl', 'dataDir', 'accountsFile', 'authFile', 'staticDir',
    'restoreJournal', 'daemonLock', 'nativeHelperPath', 'allowedOrigins', 'signupRelays',
    'shutdownTimeoutMs',
  ]);
  const listener = record(config['listener']);
  exact(listener, ['hostname', 'port']);
  if (config['account'] !== 'main' || listener['hostname'] !== '127.0.0.1' || listener['port'] !== 0) fail();
  if (config['baseUrl'] !== 'http://127.0.0.1:0' || config['shutdownTimeoutMs'] !== 10_000) fail();
  return {
    account: 'main',
    listener: { hostname: '127.0.0.1', port: 0 },
    baseUrl: 'http://127.0.0.1:0',
    dataDir: absolutePath(config['dataDir']),
    accountsFile: absolutePath(config['accountsFile']),
    authFile: absolutePath(config['authFile']),
    staticDir: absolutePath(config['staticDir']),
    restoreJournal: absolutePath(config['restoreJournal']),
    daemonLock: absolutePath(config['daemonLock']),
    nativeHelperPath: absolutePath(config['nativeHelperPath']),
    allowedOrigins: stringArray(config['allowedOrigins']),
    signupRelays: stringArray(config['signupRelays']),
    shutdownTimeoutMs: 10_000,
  };
};

export const parseMainToWorker = (value: unknown): MainToWorker => {
  const message = record(value);
  if (message['version'] !== 1) fail();
  if (message['type'] === 'shutdown') {
    exact(message, ['version', 'type']);
    return { version: 1, type: 'shutdown' };
  }
  if (message['type'] === 'start') {
    exact(message, ['version', 'type', 'config']);
    return { version: 1, type: 'start', config: daemonConfig(message['config']) };
  }
  return fail();
};

const loopbackOrigin = (value: unknown): string => {
  const raw = string(value, 2048);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== raw) fail();
    return raw;
  } catch {
    return fail();
  }
};

const daemonEvent = (value: unknown): DaemonEventWire => {
  const event = record(value);
  const type = event['type'];
  if (type === 'ready') {
    exact(event, ['type', 'origin', 'baseUrl']);
    const origin = loopbackOrigin(event['origin']);
    if (event['baseUrl'] !== origin) fail();
    return { type, origin, baseUrl: origin };
  }
  if (type === 'fatal') {
    exact(event, ['type', 'phase', 'component', 'error']);
    const phase = event['phase'];
    if (phase !== 'startup' && phase !== 'runtime') fail();
    const fatalPhase: 'startup' | 'runtime' = phase === 'startup' ? 'startup' : 'runtime';
    return { type, phase: fatalPhase, component: string(event['component'], 128), error: safeError(event['error']) };
  }
  if (type === 'diagnostic') {
    exact(event, ['type', 'component', 'error', 'recoverable']);
    if (event['recoverable'] !== true) fail();
    return { type, component: string(event['component'], 128), error: safeError(event['error']), recoverable: true };
  }
  if (type === 'enrollment-code') {
    exact(event, ['type', 'code', 'expiresAt']);
    if (!Number.isFinite(event['expiresAt'])) fail();
    return { type, code: string(event['code'], 256), expiresAt: event['expiresAt'] as number };
  }
  if (type === 'configuring') {
    exact(event, ['type', 'address', 'dataDir']);
    return { type, address: string(event['address'], 512), dataDir: absolutePath(event['dataDir']) };
  }
  if (type === 'account') {
    exact(event, ['type', 'displayName', 'address', 'feedInvite']);
    return { type, displayName: string(event['displayName'], 512), address: string(event['address'], 512), feedInvite: string(event['feedInvite'], 4096) };
  }
  if (type === 'unconfigured') {
    exact(event, ['type', 'account']);
    return { type, account: string(event['account'], 128) };
  }
  if (type === 'static-frontend') {
    exact(event, ['type', 'path']);
    return { type, path: absolutePath(event['path']) };
  }
  return fail();
};

export const toDaemonEventWire = (value: unknown): DaemonEventWire => {
  const event = record(value);
  if (event['type'] === 'fatal' || event['type'] === 'diagnostic') {
    return daemonEvent({ ...event, error: toSafeError(event['error']) });
  }
  return daemonEvent(event);
};

export const parseWorkerToMain = (value: unknown): WorkerToMain => {
  const message = record(value);
  if (message['version'] !== 1) fail();
  if (message['type'] === 'daemon-event') {
    exact(message, ['version', 'type', 'event']);
    return { version: 1, type: 'daemon-event', event: daemonEvent(message['event']) };
  }
  if (message['type'] === 'closed') {
    const hasError = message['error'] !== undefined;
    exact(message, hasError ? ['version', 'type', 'reason', 'error'] : ['version', 'type', 'reason']);
    if (!['requested', 'startup-failure', 'runtime-failure'].includes(String(message['reason']))) fail();
    return {
      version: 1,
      type: 'closed',
      reason: message['reason'] as 'requested' | 'startup-failure' | 'runtime-failure',
      ...(hasError ? { error: safeError(message['error']) } : {}),
    };
  }
  return fail();
};
