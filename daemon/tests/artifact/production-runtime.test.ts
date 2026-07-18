import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const availablePort = async (): Promise<number> => {
  const server = createServer();
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing listener address'));
      else resolvePort(address.port);
    });
  });
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
};

const waitForOutput = (child: ChildProcessWithoutNullStreams, pattern: RegExp): Promise<string> =>
  new Promise((resolveOutput, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}: ${output}`)), 10_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (!pattern.test(output)) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolveOutput(output);
    };
    child.stdout.on('data', onData);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`daemon exited before readiness (${code ?? signal}): ${output}`));
    });
  });

const waitForExit = (child: ChildProcessWithoutNullStreams): Promise<number | null> =>
  new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error('daemon did not exit after signal')), 10_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });

it.each(['SIGINT', 'SIGTERM'] as const)(
  'runs the compiled daemon under plain Node and shuts down cleanly on %s',
  async (signal) => {
  const dist = resolve('dist');
  expect(readdirSync(dist, { recursive: true }).some((path) => String(path).endsWith('.ts'))).toBe(false);

  const root = mkdtempSync(join(tmpdir(), 'headwater-artifact-'));
  roots.push(root);
  const staticDir = join(root, 'frontend');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Headwater artifact</title>');
  const port = await availablePort();
  const child = spawn(process.execPath, [join(dist, 'main.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HEADWATER_DATA: join(root, 'data'),
      HEADWATER_ACCOUNTS: join(root, 'accounts.json'),
      HEADWATER_AUTH: join(root, 'auth.json'),
      HEADWATER_STATIC: staticDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);

  await waitForOutput(child, /Headwater: Mastodon API on .*\(listening on http:\/\/127\.0\.0\.1:/);
  expect(await (await fetch(`http://127.0.0.1:${port}/api/headwater/status`)).json()).toEqual({
    configured: false,
    address: null,
  });
  expect(await (await fetch(`http://127.0.0.1:${port}/app/home`)).text()).toContain('Headwater artifact');

  child.kill(signal);
  expect(await waitForExit(child)).toBe(0);

  const rebound = createServer();
  await new Promise<void>((resolveListen, reject) => {
    rebound.once('error', reject);
    rebound.listen(port, '127.0.0.1', resolveListen);
  });
  await new Promise<void>((resolveClose, reject) => {
    rebound.close((error) => error ? reject(error) : resolveClose());
  });
  },
);
