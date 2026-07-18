import { describe, expect, it, vi } from 'vitest';
import { createPreparedRestore } from '../src/restore-lifecycle.js';
import type { Transport } from '../src/transport/types.js';

describe('createPreparedRestore', () => {
  it('closes and rolls back every failure before global publication', async () => {
    const close = vi.fn();
    const rollback = vi.fn();
    const publish = vi.fn();
    const prepared = createPreparedRestore({
      transport: {} as Transport,
      prepareCommit: async () => { throw new Error('post-import setup failed'); },
      publish,
      rollback,
      close,
    });

    await expect(prepared.commit(() => undefined)).rejects.toThrow('post-import setup failed');
    expect(publish).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await prepared.abort();
    expect(close).toHaveBeenCalledOnce();
  });

  it('publishes only after commit preparation and does not close on success', async () => {
    const order: string[] = [];
    const prepared = createPreparedRestore({
      transport: {} as Transport,
      prepareCommit: async (persist) => {
        order.push('prepare');
        persist({ addr: 'a@example.org', password: 'p', displayName: 'a' });
      },
      publish: () => { order.push('publish'); },
      rollback: () => { order.push('rollback'); },
      close: () => { order.push('close'); },
    });
    await prepared.commit(() => { order.push('journal'); });
    await prepared.abort();
    expect(order).toEqual(['prepare', 'journal', 'publish']);
  });
});
