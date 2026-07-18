import { describe, expect, it } from 'vitest';
import {
  parseMainToWorker,
  parseWorkerToMain,
  toSafeError,
} from '../src/protocol.js';

const config = {
  account: 'main',
  listener: { hostname: '127.0.0.1', port: 0 },
  baseUrl: 'http://127.0.0.1:0',
  dataDir: '/tmp/headwater/data',
  accountsFile: '/tmp/headwater/accounts.json',
  authFile: '/tmp/headwater/auth.json',
  staticDir: '/tmp/headwater/frontend',
  restoreJournal: '/tmp/headwater/restore.json',
  daemonLock: '/tmp/headwater/daemon.lock',
  nativeHelperPath: '/tmp/headwater/deltachat-rpc-server',
  allowedOrigins: [],
  signupRelays: [],
  shutdownTimeoutMs: 10_000,
};

describe('desktop private protocol', () => {
  it('accepts exact start and shutdown commands', () => {
    expect(parseMainToWorker({ version: 1, type: 'start', config })).toEqual({ version: 1, type: 'start', config });
    expect(parseMainToWorker({ version: 1, type: 'shutdown' })).toEqual({ version: 1, type: 'shutdown' });
  });

  it.each([
    null,
    { version: 2, type: 'shutdown' },
    { version: 1, type: 'shutdown', secret: 'extra' },
    { version: 1, type: 'start', config: { ...config, dataDir: 'relative' } },
    { version: 1, type: 'start', config: { ...config, listener: { hostname: '0.0.0.0', port: 0 } } },
  ])('rejects malformed or over-broad commands', (value) => {
    expect(() => parseMainToWorker(value)).toThrow(/desktop protocol/i);
  });

  it('accepts ready and closed worker messages', () => {
    expect(parseWorkerToMain({
      version: 1,
      type: 'daemon-event',
      event: { type: 'ready', origin: 'http://127.0.0.1:43123', baseUrl: 'http://127.0.0.1:43123' },
    })).toMatchObject({ type: 'daemon-event', event: { type: 'ready' } });
    expect(parseWorkerToMain({ version: 1, type: 'closed', reason: 'requested' })).toEqual({
      version: 1,
      type: 'closed',
      reason: 'requested',
    });
  });

  it('normalizes errors without serializing arbitrary properties', () => {
    const error = Object.assign(new Error('failed'), { code: 'EFAIL', secret: 'nope' });
    expect(toSafeError(error)).toEqual({ name: 'Error', message: 'failed', code: 'EFAIL' });
  });

  it('truncates arbitrarily large error fields without throwing', () => {
    const error = toSafeError(Object.assign(new Error('x'.repeat(10_000)), { code: 'y'.repeat(1_000) }));
    expect(error.message).toHaveLength(2048);
    expect(error.code).toHaveLength(128);
  });

  it('serializes hostile thrown values and getters with safe fallbacks', () => {
    expect(toSafeError(Object.create(null))).toEqual({ name: 'Error', message: 'Unknown error' });
    const hostile = new Error('ignored');
    Object.defineProperties(hostile, {
      name: { get: () => { throw new Error('name getter'); } },
      message: { get: () => { throw new Error('message getter'); } },
      code: { get: () => { throw new Error('code getter'); } },
    });
    expect(toSafeError(hostile)).toEqual({ name: 'Error', message: 'Unknown error' });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(toSafeError(proxy)).toEqual({ name: 'Error', message: 'Unknown error' });
  });
});
