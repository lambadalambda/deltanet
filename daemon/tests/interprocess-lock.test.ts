import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireInterprocessLock,
  acquireProcessLifetimeInterprocessLock,
  InterprocessLockBusyError,
  InterprocessLockError,
} from '../src/interprocess-lock.js';

let root: string;
let queuePath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deltanet-interprocess-lock-'));
  queuePath = join(root, 'writer.lock');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const ticketNames = (): string[] =>
  readdirSync(queuePath).filter((name) => /^ticket-\d+$/.test(name)).sort();

const doneNames = (): string[] =>
  readdirSync(queuePath).filter((name) => /^done-\d+$/.test(name)).sort();

type LockChild = ChildProcessByStdio<null, Readable, Readable>;

const waitForLocked = (child: LockChild): Promise<void> =>
  new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`lock child exited before acquiring: code=${code} signal=${signal}: ${stderr}`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.once('data', (chunk: string) => {
      if (chunk.includes('locked')) resolve();
      else reject(new Error(`unexpected lock child output: ${chunk}`));
    });
  });

const waitForExit = (child: LockChild): Promise<void> =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('error', reject);
    child.once('exit', () => resolve());
  });

describe('interprocess filesystem lock', () => {
  it('fails busy behind a live predecessor and abandons its own ticket', () => {
    const release = acquireInterprocessLock(queuePath);

    expect(() => acquireInterprocessLock(queuePath)).toThrow(InterprocessLockBusyError);
    expect(ticketNames()).toHaveLength(2);
    expect(doneNames()).toEqual([ticketNames()[1]!.replace('ticket-', 'done-')]);

    release();
  });

  it('reclaims a dead predecessor after SIGKILL', async () => {
    const modulePath = fileURLToPath(new URL('../src/interprocess-lock.ts', import.meta.url));
    const script = [
      `import { acquireInterprocessLock } from ${JSON.stringify(modulePath)};`,
      `acquireInterprocessLock(${JSON.stringify(queuePath)});`,
      `process.stdout.write('locked\\n');`,
      `setInterval(() => {}, 1_000);`,
    ].join('\n');
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForLocked(child);
      expect(() => acquireInterprocessLock(queuePath)).toThrow(InterprocessLockBusyError);
      child.kill('SIGKILL');
      await waitForExit(child);

      const release = acquireInterprocessLock(queuePath);
      release();
      expect(doneNames()).toHaveLength(ticketNames().length);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 10_000);

  it('reclaims a predecessor from an earlier process incarnation with the same PID', () => {
    mkdirSync(queuePath, { mode: 0o700 });
    const owner = `owner-${process.pid}-${randomUUID()}.json`;
    writeFileSync(join(queuePath, owner), `${JSON.stringify({
      version: 2,
      pid: process.pid,
      owner,
      incarnation: randomUUID(),
    })}\n`, { mode: 0o600 });
    linkSync(
      join(queuePath, owner),
      join(queuePath, 'ticket-00000000000000000001'),
    );

    const release = acquireInterprocessLock(queuePath);
    release();
    expect(doneNames()).toHaveLength(ticketNames().length);
  });

  it('fails closed on a malformed predecessor and abandons its own ticket', () => {
    mkdirSync(queuePath, { mode: 0o700 });
    chmodSync(queuePath, 0o700);
    const ownerPath = join(queuePath, 'owner-malformed');
    writeFileSync(ownerPath, '{not-json', { mode: 0o600 });
    chmodSync(ownerPath, 0o600);
    linkSync(ownerPath, join(queuePath, 'ticket-00000000000000000001'));

    expect(() => acquireInterprocessLock(queuePath)).toThrow(InterprocessLockError);
    expect(() => acquireInterprocessLock(queuePath)).toThrow(/malformed predecessor/);
    expect(ticketNames()).toHaveLength(3);
    expect(doneNames()).toEqual([
      'done-00000000000000000002',
      'done-00000000000000000003',
    ]);
  });

  it('returns an idempotent release and uses private filesystem modes', () => {
    const release = acquireInterprocessLock(queuePath);
    const [ticket] = ticketNames();

    expect(statSync(queuePath).mode & 0o777).toBe(0o700);
    expect(statSync(join(queuePath, ticket!)).mode & 0o777).toBe(0o600);
    release();
    release();

    expect(doneNames()).toEqual([ticket!.replace('ticket-', 'done-')]);
    expect(statSync(join(queuePath, doneNames()[0]!)).mode & 0o777).toBe(0o600);
  });

  it('shares process-lifetime acquisition through the process-local registry', () => {
    const first = acquireProcessLifetimeInterprocessLock(queuePath);
    const second = acquireProcessLifetimeInterprocessLock(queuePath);

    expect(second).toBe(first);
    expect(ticketNames()).toHaveLength(1);
    expect(() => acquireInterprocessLock(queuePath)).toThrow(InterprocessLockBusyError);
  });

  it('explicitly releases a process-lifetime lock so it can be reacquired', () => {
    const first = acquireProcessLifetimeInterprocessLock(queuePath);

    first.release();
    first.release();
    const second = acquireProcessLifetimeInterprocessLock(queuePath);

    expect(second).not.toBe(first);
    expect(ticketNames()).toHaveLength(2);
    expect(() => acquireInterprocessLock(queuePath)).toThrow(InterprocessLockBusyError);
    second.release();
  });
});
