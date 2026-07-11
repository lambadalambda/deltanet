import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ atomicWriteText: vi.fn() }));

vi.mock('../src/durable-file.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/durable-file.js')>(),
  atomicWriteText: mocks.atomicWriteText,
}));

import { CredentialsFileError, writeAccount } from '../src/config.js';

describe('credential atomic-write delegation', () => {
  let dir = '';

  afterEach(() => {
    mocks.atomicWriteText.mockReset();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('forwards restrictive mode and existing ownership, masks failures, and retains the old file', () => {
    dir = mkdtempSync(join(tmpdir(), 'deltanet-config-atomic-'));
    const path = join(dir, 'accounts.local.json');
    const oldContents = '{"main":{"addr":"old@example.test","password":"old-secret","displayName":"old"}}\n';
    writeFileSync(path, oldContents, { mode: 0o600 });
    const stat = statSync(path);
    mocks.atomicWriteText.mockImplementation(() => {
      throw new Error('new-secret appeared in an underlying failure');
    });

    let thrown: unknown;
    try {
      writeAccount(path, 'main', {
        addr: 'new@example.test', password: 'new-secret', displayName: 'new',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CredentialsFileError);
    expect(String(thrown)).not.toContain('new-secret');
    expect(readFileSync(path, 'utf8')).toBe(oldContents);
    expect(mocks.atomicWriteText).toHaveBeenCalledOnce();
    expect(mocks.atomicWriteText.mock.calls[0]?.[2]).toBe(0o600);
    if (process.platform === 'win32') expect(mocks.atomicWriteText.mock.calls[0]?.[3]).toBeUndefined();
    else expect(mocks.atomicWriteText.mock.calls[0]?.[3]).toEqual({ uid: stat.uid, gid: stat.gid });
  });
});
