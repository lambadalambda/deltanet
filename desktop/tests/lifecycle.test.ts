import { describe, expect, it, vi } from 'vitest';
import { createQuitHandler } from '../src/lifecycle.js';

describe('desktop quit coordination', () => {
  it('prevents every quit request and performs shutdown once', async () => {
    let finish!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const complete = vi.fn();
    const handler = createQuitHandler({ destroyWindow: vi.fn(), shutdown, complete });
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };

    handler(first);
    handler(second);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();
    expect(complete).toHaveBeenCalledWith(null);
  });

  it('reports shutdown failure before completion', async () => {
    const failure = new Error('cleanup failed');
    const complete = vi.fn();
    const handler = createQuitHandler({
      destroyWindow: () => {},
      shutdown: () => Promise.reject(failure),
      complete,
    });
    handler({ preventDefault: () => {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(complete).toHaveBeenCalledWith(failure);
  });
});
