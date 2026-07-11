import { describe, expect, it } from 'vitest';
import { createResourceBudget } from '../src/resource-budget.js';

describe('process resource budget', () => {
  it('rejects aggregate concurrent reservations and releases idempotently', () => {
    const budget = createResourceBudget(10);
    const first = budget.tryAcquire(6)!;
    expect(budget.tryAcquire(5)).toBeNull();
    const second = budget.tryAcquire(4)!;
    expect(budget.snapshot().usedBytes).toBe(10);
    first();
    first();
    expect(budget.snapshot().usedBytes).toBe(4);
    second();
    expect(budget.snapshot().usedBytes).toBe(0);
  });
});
