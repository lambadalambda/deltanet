import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMediaStore,
  MediaCapacityError,
  MediaDescriptionTooLargeError,
  MediaTooLargeError,
} from '../src/media.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deltanet-media-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const image = (bytes: number, name = 'photo.png') =>
  new File([new Uint8Array(bytes)], name, { type: 'image/png' });

describe('bounded staged media', () => {
  it('accepts the exact file limit and rejects one byte over without residue', async () => {
    const store = createMediaStore({ uploadDir: dir, maxFileBytes: 4 });
    const saved = await store.save(image(4), 'alt');

    expect(existsSync(saved.record.path)).toBe(true);
    await expect(store.save(image(5), null)).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(store.stats()).toEqual({ records: 1, messageDescriptions: 0 });
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('removes a cancelled staged upload and its registry entry', async () => {
    const store = createMediaStore({ uploadDir: dir });
    const saved = await store.save(image(2), null);

    await store.discard(saved.id);

    expect(store.acquire(saved.id)).toBeUndefined();
    expect(existsSync(saved.record.path)).toBe(false);
    expect(store.stats().records).toBe(0);
  });

  it('keeps a discarded file until every concurrent lease finishes', async () => {
    const store = createMediaStore({ uploadDir: dir });
    const saved = await store.save(image(2), null);
    const first = store.acquire(saved.id)!;
    const second = store.acquire(saved.id)!;

    await store.discard(saved.id);
    expect(store.acquire(saved.id)).toBeUndefined();
    expect(existsSync(saved.record.path)).toBe(true);
    await first.finish();
    expect(existsSync(saved.record.path)).toBe(true);
    await second.finish();
    expect(existsSync(saved.record.path)).toBe(false);
  });

  it('expires abandoned uploads according to the injected clock', async () => {
    let now = 100;
    const store = createMediaStore({ uploadDir: dir, ttlMs: 50, now: () => now });
    const saved = await store.save(image(2), null);

    now = 149;
    await store.sweep();
    expect(existsSync(saved.record.path)).toBe(true);
    now = 150;
    await store.sweep();
    expect(existsSync(saved.record.path)).toBe(false);
    expect(store.stats().records).toBe(0);
  });

  it('removes expired orphan files left by an earlier process', async () => {
    const orphan = join(dir, 'orphan.png');
    writeFileSync(orphan, 'partial');
    utimesSync(orphan, new Date(0), new Date(0));
    const store = createMediaStore({ uploadDir: dir, ttlMs: 50, now: () => 100_000 });

    await store.sweep();

    expect(existsSync(orphan)).toBe(false);
  });

  it('sweeps expired process-crash orphans automatically at startup', async () => {
    const orphan = join(dir, 'orphan.png');
    writeFileSync(orphan, 'partial');
    utimesSync(orphan, new Date(0), new Date(0));

    createMediaStore({ uploadDir: dir, ttlMs: 50, now: () => 100_000 });

    await vi.waitFor(() => expect(existsSync(orphan)).toBe(false));
  });

  it('automatically expires an abandoned live-process upload', async () => {
    const store = createMediaStore({ uploadDir: dir, ttlMs: 5 });
    const saved = await store.save(image(2), null);

    await vi.waitFor(() => expect(existsSync(saved.record.path)).toBe(false));

    expect(store.acquire(saved.id)).toBeUndefined();
    expect(store.stats().records).toBe(0);
  });

  it('bounds staged records and admits another upload after cleanup', async () => {
    const store = createMediaStore({ uploadDir: dir, maxRecords: 1 });
    const saved = await store.save(image(2), null);

    await expect(store.save(image(2, 'second.png'), null)).rejects.toBeInstanceOf(MediaCapacityError);
    await store.discard(saved.id);
    await expect(store.save(image(2, 'second.png'), null)).resolves.toBeDefined();
  });

  it('reserves capacity before concurrent file writes begin', async () => {
    const store = createMediaStore({ uploadDir: dir, maxRecords: 1 });

    const results = await Promise.allSettled([
      store.save(image(2, 'first.png'), null),
      store.save(image(2, 'second.png'), null),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(MediaCapacityError);
    expect(store.stats().records).toBe(1);
  });

  it('bounds the transient message-description cache', async () => {
    const store = createMediaStore({ uploadDir: dir, maxMessageDescriptions: 2 });
    store.tagMessage(1, 'one');
    store.tagMessage(2, 'two');
    store.tagMessage(3, 'three');

    expect(store.descriptionForMessage(1)).toBeNull();
    expect(store.descriptionForMessage(2)).toBe('two');
    expect(store.descriptionForMessage(3)).toBe('three');
    expect(store.stats().messageDescriptions).toBe(2);
  });

  it('bounds and updates staged alt text before it enters the durable envelope', async () => {
    const store = createMediaStore({ uploadDir: dir, maxDescriptionBytes: 4 });
    const saved = await store.save(image(2), 'four');

    expect(store.updateDescription(saved.id, 'next')?.description).toBe('next');
    expect(() => store.updateDescription(saved.id, 'large')).toThrow(MediaDescriptionTooLargeError);
    await expect(store.save(image(2, 'other.png'), 'large')).rejects.toBeInstanceOf(MediaDescriptionTooLargeError);
    expect(store.stats().records).toBe(1);
  });
});
