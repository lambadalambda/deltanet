import { describe, expect, it } from 'vitest';
import { createUtilitySupervisor } from '../src/supervisor.js';

describe('utility-process supervisor', () => {
  it('forwards validated enrollment rotations without resolving readiness', () => {
    const codes: Array<{ code: string; expiresAt: number }> = [];
    const supervisor = createUtilitySupervisor({
      post: () => {},
      kill: () => {},
      readinessTimeoutMs: false,
      onEnrollmentCode: (value) => codes.push(value),
    });
    supervisor.accept({ version: 1, type: 'daemon-event', event: {
      type: 'enrollment-code', code: 'a'.repeat(43), expiresAt: 1_800_000_000_000,
    } });
    supervisor.accept({ version: 1, type: 'daemon-event', event: {
      type: 'enrollment-code', code: 'b'.repeat(43), expiresAt: 1_800_000_001_000,
    } });
    expect(codes).toEqual([
      { code: 'a'.repeat(43), expiresAt: 1_800_000_000_000 },
      { code: 'b'.repeat(43), expiresAt: 1_800_000_001_000 },
    ]);
  });

  it('becomes ready exactly once and rejects duplicate readiness', async () => {
    const posted: unknown[] = [];
    const supervisor = createUtilitySupervisor({ post: (message) => posted.push(message), kill: () => {} });
    supervisor.accept({ version: 1, type: 'daemon-event', event: {
      type: 'ready', origin: 'http://127.0.0.1:43123', baseUrl: 'http://127.0.0.1:43123',
    } });
    await expect(supervisor.ready).resolves.toEqual({ origin: 'http://127.0.0.1:43123' });
    expect(() => supervisor.accept({ version: 1, type: 'daemon-event', event: {
      type: 'ready', origin: 'http://127.0.0.1:43123', baseUrl: 'http://127.0.0.1:43123',
    } })).toThrow(/duplicate readiness/i);
  });

  it('fails closed when fatal or closed arrives before readiness', async () => {
    const fatal = createUtilitySupervisor({ post: () => {}, kill: () => {} });
    fatal.accept({ version: 1, type: 'daemon-event', event: {
      type: 'fatal', phase: 'startup', component: 'daemon', error: { name: 'Error', message: 'boom' },
    } });
    await expect(fatal.ready).rejects.toThrow('boom');

    const closed = createUtilitySupervisor({ post: () => {}, kill: () => {} });
    closed.accept({ version: 1, type: 'closed', reason: 'startup-failure' });
    await expect(closed.ready).rejects.toThrow(/closed before readiness/i);
  });

  it('posts one shutdown command and kills once only after timeout', async () => {
    const posted: unknown[] = [];
    let kills = 0;
    let runTimeout!: () => void;
    const supervisor = createUtilitySupervisor({
      post: (message) => posted.push(message),
      kill: () => { kills += 1; },
      schedule: (callback) => { runTimeout = callback; return 1; },
      cancel: () => {},
      readinessTimeoutMs: false,
    });

    const first = supervisor.shutdown();
    const second = supervisor.shutdown();
    expect(posted).toEqual([{ version: 1, type: 'shutdown' }]);
    runTimeout();
    expect(kills).toBe(1);
    supervisor.exited(new Error('utility exited'));
    await expect(first).rejects.toThrow(/shutdown deadline/i);
    await expect(second).rejects.toThrow(/shutdown deadline/i);
  });

  it('completes shutdown when the utility exits without a closed message', async () => {
    const supervisor = createUtilitySupervisor({ post: () => {}, kill: () => {}, readinessTimeoutMs: false });
    const shutdown = supervisor.shutdown();
    supervisor.exited(new Error('utility exited'));
    await expect(shutdown).rejects.toThrow('utility exited');
  });

  it('reports an unexpected close after readiness as a runtime failure', async () => {
    const failures: Error[] = [];
    const supervisor = createUtilitySupervisor({
      post: () => {},
      kill: () => {},
      onRuntimeFailure: (error) => failures.push(error),
    });
    supervisor.accept({ version: 1, type: 'daemon-event', event: {
      type: 'ready', origin: 'http://127.0.0.1:43123', baseUrl: 'http://127.0.0.1:43123',
    } });
    await supervisor.ready;
    supervisor.accept({
      version: 1,
      type: 'closed',
      reason: 'runtime-failure',
      error: { name: 'Error', message: 'native core stopped' },
    });
    expect(failures.map((error) => error.message)).toEqual(['native core stopped']);
  });

  it('rejects shutdown when the worker reports close failure', async () => {
    const supervisor = createUtilitySupervisor({ post: () => {}, kill: () => {}, readinessTimeoutMs: false });
    const shutdown = supervisor.shutdown();
    supervisor.accept({
      version: 1,
      type: 'closed',
      reason: 'runtime-failure',
      error: { name: 'Error', message: 'lock cleanup failed' },
    });
    await expect(shutdown).rejects.toThrow('lock cleanup failed');
  });

  it('fails startup after a bounded readiness deadline', async () => {
    let expire!: () => void;
    const supervisor = createUtilitySupervisor({
      post: () => {},
      kill: () => {},
      schedule: (callback) => { expire = callback; return 1; },
      cancel: () => {},
      readinessTimeoutMs: 30_000,
    });
    expire();
    await expect(supervisor.ready).rejects.toThrow(/readiness deadline/i);
  });
});
