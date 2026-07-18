export type EnrollmentCodeSnapshot = Readonly<{
  revision: number;
  code: string;
  expiresAt: number;
}>;

type EnrollmentBrokerOptions = Readonly<{
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  waitTimeoutMs?: number;
}>;

export const createEnrollmentBroker = (options: EnrollmentBrokerOptions = {}) => {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  });
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const waitTimeoutMs = options.waitTimeoutMs ?? 5_000;
  let revision = 0;
  let current: EnrollmentCodeSnapshot | null = null;
  let expiryTimeout: unknown = null;
  let closed = false;
  let nextWaiterId = 1;
  const waiters = new Map<number, Readonly<{
    afterRevision: number;
    resolve: (value: EnrollmentCodeSnapshot | null) => void;
    timeout: unknown;
  }>>();

  const clearCurrent = (): void => {
    current = null;
    if (expiryTimeout !== null) cancel(expiryTimeout);
    expiryTimeout = null;
  };

  const read = (): EnrollmentCodeSnapshot | null => {
    if (current && current.expiresAt <= now()) clearCurrent();
    return current;
  };

  const settle = (value: EnrollmentCodeSnapshot | null, predicate: (afterRevision: number) => boolean): void => {
    for (const [id, waiter] of waiters) {
      if (!predicate(waiter.afterRevision)) continue;
      waiters.delete(id);
      cancel(waiter.timeout);
      waiter.resolve(value);
    }
  };

  const publish = (value: Readonly<{ code: string; expiresAt: number }>): void => {
    if (closed) return;
    const lifetimeMs = value.expiresAt - now();
    if (lifetimeMs <= 0 || lifetimeMs > 11 * 60_000) return;
    clearCurrent();
    revision += 1;
    current = Object.freeze({ revision, code: value.code, expiresAt: value.expiresAt });
    const publishedRevision = revision;
    expiryTimeout = schedule(() => {
      expiryTimeout = null;
      if (current?.revision === publishedRevision) current = null;
    }, lifetimeMs);
    settle(read(), (afterRevision) => revision > afterRevision);
  };

  const consume = (consumedRevision: number): void => {
    if (current?.revision === consumedRevision) clearCurrent();
  };

  const currentRevision = (): number => revision;

  const get = (afterRevision?: number): Promise<EnrollmentCodeSnapshot | null> => {
    if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) {
      return Promise.reject(new Error('invalid enrollment revision'));
    }
    if (afterRevision !== undefined && afterRevision > revision) {
      return Promise.reject(new Error('invalid enrollment revision'));
    }
    if (closed) return Promise.resolve(null);
    const value = read();
    if (afterRevision === undefined || revision > afterRevision) return Promise.resolve(value);
    if (waiters.size >= 1) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = nextWaiterId;
      nextWaiterId += 1;
      const timeout = schedule(() => {
        waiters.delete(id);
        resolve(null);
      }, waitTimeoutMs);
      waiters.set(id, { afterRevision, resolve, timeout });
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearCurrent();
    settle(null, () => true);
  };

  return { publish, get, consume, revision: currentRevision, close };
};
