import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { electronSmokeArguments, electronSmokeEnvironment } from '../dist/smoke.js';

const root = mkdtempSync(join(tmpdir(), 'headwater-desktop-smoke-'));
const appDir = fileURLToPath(new URL('..', import.meta.url));
const packagedExecutable = process.env['HEADWATER_DESKTOP_SMOKE_EXECUTABLE'];
const executable = packagedExecutable ? resolve(packagedExecutable) : (await import('electron')).default;

const stopProcessGroup = (child) => {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
};

const processGroupAlive = (child) => {
  if (!child.pid || process.platform === 'win32') return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForProcessGroupExit = async (child) => {
  for (let attempt = 0; attempt < 20 && processGroupAlive(child); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processGroupAlive(child);
};

const listenerIsClosed = (origin) => new Promise((resolve) => {
  const url = new URL(origin);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  let settled = false;
  const finish = (closed) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(closed);
  };
  socket.setTimeout(1_000, () => finish(false));
  socket.once('connect', () => finish(false));
  socket.once('error', (error) => finish(error.code === 'ECONNREFUSED'));
});

const launch = async (attempt) => {
  const marker = join(root, `result-${attempt}.json`);
  const child = spawn(executable, electronSmokeArguments({
    appDir: packagedExecutable ? undefined : appDir,
    userData: root,
    marker,
  }), {
    detached: process.platform !== 'win32',
    env: electronSmokeEnvironment(process.env, { userData: root, marker }),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    stopProcessGroup(child);
  }, 50_000);
  const result = await new Promise((resolveResult) => {
    child.once('exit', (code, signal) => resolveResult({ code, signal }));
    child.once('error', (error) => resolveResult({ code: 1, error }));
  });
  clearTimeout(timeout);
  const report = existsSync(marker)
    ? JSON.parse(readFileSync(marker, 'utf8'))
    : { state: 'missing', origin: null };
  const groupExited = await waitForProcessGroupExit(child);
  if (timedOut || result.code !== 0 || report.state !== 'closed' || typeof report.origin !== 'string' || !groupExited) {
    stopProcessGroup(child);
    await waitForProcessGroupExit(child);
    throw new Error(`Electron smoke attempt ${attempt} failed (${timedOut ? 'timeout' : result.code ?? result.signal ?? result.error}): ${JSON.stringify(report)}`);
  }
  if (!await listenerIsClosed(report.origin)) throw new Error(`Electron smoke left ${report.origin} listening`);
};

try {
  await launch(1);
  await launch(2);
} finally {
  rmSync(root, { recursive: true, force: true });
}
