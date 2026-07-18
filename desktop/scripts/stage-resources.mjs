import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRPCServerPath } from '@deltachat/stdio-rpc-server';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resources = join(root, 'resources');
const resourceName = basename(resources);
const orphanedBackups = readdirSync(root)
  .filter((entry) => entry.startsWith(`${resourceName}.backup-`))
  .map((entry) => join(root, entry));
if (!existsSync(resources) && orphanedBackups[0]) renameSync(orphanedBackups.shift(), resources);
for (const orphan of orphanedBackups) rmSync(orphan, { recursive: true, force: true });
for (const entry of readdirSync(root).filter((name) => name.startsWith(`${resourceName}.tmp-`))) {
  rmSync(join(root, entry), { recursive: true, force: true });
}
const staging = `${resources}.tmp-${process.pid}`;
const backup = `${resources}.backup-${process.pid}`;
rmSync(staging, { recursive: true, force: true });
rmSync(backup, { recursive: true, force: true });
try {
  mkdirSync(join(staging, 'utility'), { recursive: true });
  mkdirSync(join(staging, 'native'), { recursive: true });
  cpSync(resolve(root, '../daemon/dist'), join(staging, 'daemon', 'dist'), { recursive: true });
  copyFileSync(resolve(root, '../daemon/package.json'), join(staging, 'daemon', 'package.json'));
  cpSync(resolve(root, '../frontend/build'), join(staging, 'frontend'), { recursive: true });
  copyFileSync(join(root, 'dist', 'worker.mjs'), join(staging, 'utility', 'worker.mjs'));
  copyFileSync(join(root, 'dist', 'protocol.js'), join(staging, 'utility', 'protocol.js'));
  const native = getRPCServerPath({ disableEnvPath: true });
  copyFileSync(native, join(staging, 'native', 'deltachat-rpc-server'));
  chmodSync(join(staging, 'native', 'deltachat-rpc-server'), 0o755);
  if (existsSync(resources)) renameSync(resources, backup);
  try {
    renameSync(staging, resources);
  } catch (error) {
    if (existsSync(backup)) renameSync(backup, resources);
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  if (!existsSync(resources) && existsSync(backup)) renameSync(backup, resources);
  throw error;
}
