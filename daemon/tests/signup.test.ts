import { describe, expect, it, vi } from 'vitest';
import { registerAccount } from '../src/signup.js';

describe('registerAccount', () => {
  it('POSTs to {relay}/new and returns the new credentials', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ email: 'new@nine.testrun.org', password: 'secret' }), {
        status: 200,
      }),
    );
    const creds = await registerAccount('https://nine.testrun.org', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://nine.testrun.org/new',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(creds).toEqual({ addr: 'new@nine.testrun.org', password: 'secret' });
  });

  it('throws when registration fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(registerAccount('https://nine.testrun.org', fetchImpl)).rejects.toThrow();
  });
});
