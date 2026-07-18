export type DesktopOAuthClient = Readonly<{ origin: string; clientId: string; clientSecret: string }>;

export class DesktopOAuthRegistrationError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`desktop OAuth registration failed (${status})`);
    this.name = 'DesktopOAuthRegistrationError';
    this.status = status;
  }
}

const localOrigin = (raw: string): string => {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== raw) {
    throw new Error('invalid desktop OAuth origin');
  }
  return raw;
};

const readBoundedText = async (response: Response, limit: number): Promise<string> => {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isSafeInteger(length) && length > limit) {
      await response.body?.cancel().catch(() => {});
      throw new Error('invalid desktop OAuth registration response');
    }
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        throw new Error('invalid desktop OAuth registration response');
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
};

export const registerDesktopOAuthClient = async (input: Readonly<{
  origin: string;
  enrollmentCode: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}>): Promise<DesktopOAuthClient> => {
  const origin = localOrigin(input.origin);
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.enrollmentCode)) throw new Error('invalid desktop enrollment code');
  const redirectUri = `${origin}/auth/callback`;
  const body = new URLSearchParams({
    client_name: 'Headwater',
    redirect_uris: redirectUri,
    scopes: 'read write follow push',
    enrollment_code: input.enrollmentCode,
    website: origin,
  });
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? 5_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(`${origin}/api/v1/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new DesktopOAuthRegistrationError(408);
    throw error;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new DesktopOAuthRegistrationError(response.status);
  }
  let text: string;
  try {
    text = await readBoundedText(response, 16_384);
  } catch (error) {
    if (signal.aborted) throw new DesktopOAuthRegistrationError(408);
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('invalid desktop OAuth registration response');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid desktop OAuth registration response');
  }
  const record = value as Record<string, unknown>;
  const clientId = record['client_id'];
  const clientSecret = record['client_secret'];
  if (typeof clientId !== 'string' || !clientId || clientId.length > 512
    || typeof clientSecret !== 'string' || !clientSecret || clientSecret.length > 512) {
    throw new Error('invalid desktop OAuth registration response');
  }
  return Object.freeze({ origin, clientId, clientSecret });
};
