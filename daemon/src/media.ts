import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
export const MEDIA_TTL_MS = 60 * 60 * 1000;
export const MAX_STAGED_MEDIA = 8;
export const MAX_MESSAGE_DESCRIPTIONS = 1024;
export const MAX_MEDIA_DESCRIPTION_BYTES = 4096;

export type MediaRecord = {
  path: string;
  description: string | null;
};

type MediaEntry = {
  record: MediaRecord;
  createdAt: number;
  leases: number;
  discarded: boolean;
  ready: boolean;
  expiry?: ReturnType<typeof setTimeout>;
};

export type MediaLease = {
  record: MediaRecord;
  finish(): Promise<void>;
};

export type MediaStore = {
  save(file: File, description: string | null): Promise<{ id: string; record: MediaRecord }>;
  acquire(id: string): MediaLease | undefined;
  updateDescription(id: string, description: string | null): MediaRecord | undefined;
  discard(id: string): Promise<void>;
  sweep(): Promise<void>;
  tagMessage(msgId: number, description: string | null): void;
  descriptionForMessage(msgId: number): string | null;
  stats(): { records: number; messageDescriptions: number };
};

export type MediaStoreOptions = {
  uploadDir?: string;
  maxFileBytes?: number;
  maxRecords?: number;
  maxMessageDescriptions?: number;
  maxDescriptionBytes?: number;
  ttlMs?: number;
  now?: () => number;
};

export class MediaTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`media file exceeds ${maxBytes} bytes`);
    this.name = 'MediaTooLargeError';
  }
}

export class MediaCapacityError extends Error {
  constructor(readonly maxRecords: number) {
    super(`staged media limit of ${maxRecords} reached`);
    this.name = 'MediaCapacityError';
  }
}

export class MediaDescriptionTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`media description exceeds ${maxBytes} bytes`);
    this.name = 'MediaDescriptionTooLargeError';
  }
}

const SUPPORTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export const isSupportedImageMime = (mime: string): boolean => SUPPORTED_IMAGE_MIME.has(mime);

export const createMediaStore = (options: MediaStoreOptions = {}): MediaStore => {
  const uploadDir = options.uploadDir ?? join(tmpdir(), 'headwater-uploads');
  const maxFileBytes = options.maxFileBytes ?? MAX_MEDIA_BYTES;
  const maxRecords = options.maxRecords ?? MAX_STAGED_MEDIA;
  const maxMessageDescriptions = options.maxMessageDescriptions ?? MAX_MESSAGE_DESCRIPTIONS;
  const maxDescriptionBytes = options.maxDescriptionBytes ?? MAX_MEDIA_DESCRIPTION_BYTES;
  const ttlMs = options.ttlMs ?? MEDIA_TTL_MS;
  const now = options.now ?? Date.now;
  const records = new Map<string, MediaEntry>();
  const descriptionsByMsgId = new Map<number, string>();

  const cleanup = async (id: string, entry: MediaEntry): Promise<void> => {
    if (!entry.discarded || entry.leases > 0) return;
    if (records.get(id) === entry) records.delete(id);
    if (entry.expiry) clearTimeout(entry.expiry);
    await rm(entry.record.path, { force: true });
  };

  const discard = async (id: string): Promise<void> => {
    const entry = records.get(id);
    if (!entry) return;
    entry.discarded = true;
    await cleanup(id, entry);
  };

  const sweep = async (): Promise<void> => {
    const cutoff = now() - ttlMs;
    await Promise.all([...records].map(async ([id, entry]) => {
      if (entry.createdAt > cutoff) return;
      entry.discarded = true;
      await cleanup(id, entry);
    }));
    const knownPaths = new Set([...records.values()].map((entry) => entry.record.path));
    const names = await readdir(uploadDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    await Promise.all(names.map(async (name) => {
      const path = join(uploadDir, name);
      if (knownPaths.has(path)) return;
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && info.mtimeMs <= cutoff) await rm(path, { force: true });
    }));
  };

  void sweep().catch((error) => console.error('staged media startup cleanup failed:', error));

  return {
    save: async (file, description) => {
      if (file.size > maxFileBytes) throw new MediaTooLargeError(maxFileBytes);
      if (description && Buffer.byteLength(description, 'utf8') > maxDescriptionBytes) {
        throw new MediaDescriptionTooLargeError(maxDescriptionBytes);
      }
      await sweep();
      if (records.size >= maxRecords) throw new MediaCapacityError(maxRecords);
      const id = randomUUID();
      const path = join(uploadDir, `${id}${EXTENSION_BY_MIME[file.type] ?? ''}`);
      const record: MediaRecord = { path, description };
      const entry: MediaEntry = {
        record,
        createdAt: now(),
        leases: 0,
        discarded: false,
        ready: false,
      };
      records.set(id, entry);
      try {
        await mkdir(uploadDir, { recursive: true, mode: 0o700 });
        await chmod(uploadDir, 0o700);
        await pipeline(
          Readable.fromWeb(file.stream() as globalThis.ReadableStream<Uint8Array>),
          createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        );
        entry.ready = true;
        entry.expiry = setTimeout(() => { void discard(id); }, ttlMs);
        entry.expiry.unref?.();
        return { id, record };
      } catch (error) {
        records.delete(id);
        await rm(path, { force: true });
        throw error;
      }
    },
    acquire: (id) => {
      const entry = records.get(id);
      if (!entry || !entry.ready || entry.discarded || entry.createdAt + ttlMs <= now()) {
        if (entry && !entry.discarded) void discard(id);
        return undefined;
      }
      entry.leases += 1;
      let finished = false;
      return {
        record: entry.record,
        finish: async () => {
          if (finished) return;
          finished = true;
          entry.leases -= 1;
          entry.discarded = true;
          await cleanup(id, entry);
        },
      };
    },
    updateDescription: (id, description) => {
      if (description && Buffer.byteLength(description, 'utf8') > maxDescriptionBytes) {
        throw new MediaDescriptionTooLargeError(maxDescriptionBytes);
      }
      const entry = records.get(id);
      if (!entry || !entry.ready || entry.discarded) return undefined;
      entry.record.description = description;
      return entry.record;
    },
    discard,
    sweep,
    tagMessage: (msgId, description) => {
      if (!description) return;
      descriptionsByMsgId.delete(msgId);
      descriptionsByMsgId.set(msgId, description);
      while (descriptionsByMsgId.size > maxMessageDescriptions) {
        const oldest = descriptionsByMsgId.keys().next().value;
        if (oldest === undefined) break;
        descriptionsByMsgId.delete(oldest);
      }
    },
    descriptionForMessage: (msgId) => descriptionsByMsgId.get(msgId) ?? null,
    stats: () => ({ records: records.size, messageDescriptions: descriptionsByMsgId.size }),
  };
};
