import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteText } from '../src/durable-file.js';

describe('atomicWriteText security phases', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('sets the exact requested mode despite umask', () => {
    if (process.platform === 'win32') return;
    dir = mkdtempSync(join(tmpdir(), 'deltanet-durable-'));
    const path = join(dir, 'secret.json');
    const previousUmask = process.umask(0o777);
    try {
      atomicWriteText(path, 'secret', 0o600);
    } finally {
      process.umask(previousUmask);
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('retains the previous complete file and removes the temp on a pre-rename ownership failure', () => {
    if (process.platform === 'win32') return;
    dir = mkdtempSync(join(tmpdir(), 'deltanet-durable-'));
    const path = join(dir, 'secret.json');
    writeFileSync(path, 'old-complete', { mode: 0o600 });

    expect(() => atomicWriteText(path, 'new-secret', 0o600, { uid: -2, gid: -2 })).toThrow();

    expect(readFileSync(path, 'utf8')).toBe('old-complete');
    expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});
