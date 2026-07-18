import { describe, expect, it } from 'vitest';
import { createEnrollmentBroker } from '../src/enrollment.js';

describe('desktop enrollment broker', () => {
  it('keeps only the latest unexpired code in memory', async () => {
    let now = 1_700_000_000_000;
    const broker = createEnrollmentBroker({ now: () => now });
    broker.publish({ code: 'a'.repeat(43), expiresAt: now + 1_000 });
    expect(broker.revision()).toBe(1);
    expect(await broker.get()).toEqual({ revision: 1, code: 'a'.repeat(43), expiresAt: now + 1_000 });
    broker.publish({ code: 'b'.repeat(43), expiresAt: now + 2_000 });
    expect(await broker.get()).toEqual({ revision: 2, code: 'b'.repeat(43), expiresAt: now + 2_000 });
    now += 2_001;
    expect(await broker.get()).toBeNull();
  });

  it('forgets a code immediately after its revision is consumed', async () => {
    const now = 1_700_000_000_000;
    const broker = createEnrollmentBroker({ now: () => now });
    broker.publish({ code: 'a'.repeat(43), expiresAt: now + 10_000 });
    broker.consume(1);
    expect(broker.revision()).toBe(1);
    await expect(broker.get()).resolves.toBeNull();
  });

  it('waits for a revision newer than the pre-signup snapshot', async () => {
    const now = 1_700_000_000_000;
    const broker = createEnrollmentBroker({ now: () => now });
    broker.publish({ code: 'a'.repeat(43), expiresAt: now + 10_000 });
    const baseline = await broker.get();
    expect(baseline?.revision).toBe(1);
    const replacement = broker.get(baseline?.revision);
    broker.publish({ code: 'b'.repeat(43), expiresAt: now + 10_000 });
    await expect(replacement).resolves.toEqual({ revision: 2, code: 'b'.repeat(43), expiresAt: now + 10_000 });
  });

  it('settles pending readers without exposing a code when closed', async () => {
    const broker = createEnrollmentBroker();
    const waiting = broker.get(0);
    broker.close();
    await expect(waiting).resolves.toBeNull();
    await expect(broker.get()).resolves.toBeNull();
  });

  it('times out one bounded waiter and rejects revisions that were never issued', async () => {
    const callbacks = new Map<number, () => void>();
    const now = 1_700_000_000_000;
    const broker = createEnrollmentBroker({
      now: () => now,
      schedule: (callback, delayMs) => { callbacks.set(delayMs, callback); return delayMs; },
      cancel: () => {},
      waitTimeoutMs: 5_000,
    });
    broker.publish({ code: 'a'.repeat(43), expiresAt: now + 10_000 });
    await expect(broker.get(2)).rejects.toThrow(/invalid enrollment revision/i);
    const waiting = broker.get(1);
    expect(await broker.get(1)).toBeNull();
    callbacks.get(5_000)?.();
    await expect(waiting).resolves.toBeNull();
  });
});
