import { describe, expect, it } from 'vitest';
import { registerDesktopOAuthClient } from '../src/oauth-registration.js';

describe('desktop OAuth client registration', () => {
  it('registers only against the supplied local origin and returns no enrollment code', async () => {
    let request: Readonly<{ url: string; body: string }> | null = null;
    const result = await registerDesktopOAuthClient({
      origin: 'http://127.0.0.1:43123',
      enrollmentCode: 'a'.repeat(43),
      fetch: async (input, init) => {
        request = { url: String(input), body: String(init?.body) };
        return new Response(JSON.stringify({
          client_id: 'desktop-client',
          client_secret: 'desktop-secret',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    expect(request).toEqual({
      url: 'http://127.0.0.1:43123/api/v1/apps',
      body: expect.stringContaining(`enrollment_code=${'a'.repeat(43)}`),
    });
    expect(result).toEqual({ origin: 'http://127.0.0.1:43123', clientId: 'desktop-client', clientSecret: 'desktop-secret' });
    expect(result).not.toHaveProperty('enrollmentCode');
  });

  it('reports registration failures without retaining daemon response bodies', async () => {
    await expect(registerDesktopOAuthClient({
      origin: 'http://127.0.0.1:43123',
      enrollmentCode: 'a'.repeat(43),
      fetch: async () => new Response(JSON.stringify({ error: 'secret daemon detail' }), { status: 403 }),
    })).rejects.toMatchObject({ message: 'desktop OAuth registration failed (403)', status: 403 });
  });

  it('aborts a stalled registration after a bounded deadline', async () => {
    await expect(registerDesktopOAuthClient({
      origin: 'http://127.0.0.1:43123',
      enrollmentCode: 'a'.repeat(43),
      timeoutMs: 5,
      fetch: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    })).rejects.toMatchObject({ message: 'desktop OAuth registration failed (408)', status: 408 });
  });

  it('rejects a streamed response as soon as it exceeds the response limit', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(9_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(registerDesktopOAuthClient({
      origin: 'http://127.0.0.1:43123',
      enrollmentCode: 'a'.repeat(43),
      fetch: async () => new Response(body, { status: 200 }),
    })).rejects.toThrow('invalid desktop OAuth registration response');
    expect(cancelled).toBe(true);
  });
});
