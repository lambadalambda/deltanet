import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const OWNER_VERSION = 2;
const PROCESS_INCARNATION = randomUUID();
const TICKET_WIDTH = 20;
const DONE_CONTENTS = 'done\n';
const TICKET_PATTERN = /^ticket-(\d{20,})$/;
const DONE_PATTERN = /^done-(\d{20,})$/;
const OWNER_PATTERN = /^owner-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;

type OwnerRecord = {
  version: number;
  pid: number;
  owner: string;
  incarnation: string;
};

type Ticket = {
  number: bigint;
  name: string;
};

class LinkedTicketError extends Error {
  readonly ticket: Ticket;

  constructor(ticket: Ticket, cause: unknown) {
    super(`could not sync linked ticket ${ticket.name}`, { cause });
    this.ticket = ticket;
  }
}

export type InterprocessLockRelease = () => void;

export type ProcessLifetimeInterprocessLock = Readonly<{
  queuePath: string;
  release: InterprocessLockRelease;
}>;

export class InterprocessLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InterprocessLockError';
  }
}

export class InterprocessLockBusyError extends InterprocessLockError {
  readonly pid: number;
  readonly ticket: string;

  constructor(queuePath: string, ticket: string, pid: number) {
    super(`interprocess lock is busy: live process ${pid} owns ${ticket} in ${queuePath}`);
    this.name = 'InterprocessLockBusyError';
    this.pid = pid;
    this.ticket = ticket;
  }
}

const processLifetimeLocks = new Map<string, {
  handle: ProcessLifetimeInterprocessLock;
  release: InterprocessLockRelease;
}>();

process.once('exit', () => {
  for (const { release } of processLifetimeLocks.values()) {
    try {
      release();
    } catch {
      // Exit cannot recover; a later process will reclaim this incarnation.
    }
  }
});

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null)?.code;

const pathExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
};

const directorySyncUnsupported = (error: unknown): boolean => {
  const code = errorCode(error);
  return code !== undefined && ['EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code);
};

const syncDirectory = (path: string): void => {
  let fd: number | null = null;
  let failure: unknown;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (error) {
    if (!directorySyncUnsupported(error)) failure = error;
  }
  if (fd !== null) {
    try {
      closeSync(fd);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
};

const ensureQueue = (queuePath: string): void => {
  const missing: string[] = [];
  let cursor = queuePath;
  while (!pathExists(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  if (missing.length > 0) {
    mkdirSync(queuePath, { recursive: true, mode: 0o700 });
    for (const created of missing.reverse()) syncDirectory(dirname(created));
  }

  const stats = lstatSync(queuePath);
  if (!stats.isDirectory()) {
    throw new InterprocessLockError(`interprocess lock queue is not a directory: ${queuePath}`);
  }
  chmodSync(queuePath, 0o700);
  syncDirectory(queuePath);
};

const writeExclusiveDurable = (path: string, contents: string): void => {
  let fd: number | null = null;
  let failure: unknown;
  try {
    fd = openSync(path, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    failure = error;
  }
  if (fd !== null) {
    try {
      closeSync(fd);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  syncDirectory(dirname(path));
};

const syncFile = (path: string): void => {
  let fd: number | null = null;
  let failure: unknown;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (error) {
    failure = error;
  }
  if (fd !== null) {
    try {
      closeSync(fd);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
};

const malformed = (queuePath: string, ticket: string, reason: string): InterprocessLockError =>
  new InterprocessLockError(
    `interprocess lock has malformed predecessor ${ticket} in ${queuePath}: ${reason}`,
  );

const ticketNumber = (name: string, pattern: RegExp): bigint | null => {
  const match = pattern.exec(name);
  if (!match?.[1]) return null;
  const number = BigInt(match[1]);
  return number > 0n ? number : null;
};

const ticketName = (number: bigint): string =>
  `ticket-${number.toString().padStart(TICKET_WIDTH, '0')}`;

const doneName = (number: bigint): string =>
  `done-${number.toString().padStart(TICKET_WIDTH, '0')}`;

const readTickets = (queuePath: string): Ticket[] => {
  const names = readdirSync(queuePath);
  const tickets: Ticket[] = [];
  const ticketNumbers = new Set<string>();
  const doneNumbers: bigint[] = [];

  for (const name of names) {
    if (name.startsWith('ticket-')) {
      const number = ticketNumber(name, TICKET_PATTERN);
      if (number === null || name !== ticketName(number)) {
        throw new InterprocessLockError(`interprocess lock queue has malformed ticket name: ${name}`);
      }
      tickets.push({ number, name });
      ticketNumbers.add(number.toString());
    } else if (name.startsWith('done-')) {
      const number = ticketNumber(name, DONE_PATTERN);
      if (number === null || name !== doneName(number)) {
        throw new InterprocessLockError(`interprocess lock queue has malformed done name: ${name}`);
      }
      doneNumbers.push(number);
    }
  }

  for (const number of doneNumbers) {
    if (!ticketNumbers.has(number.toString())) {
      throw new InterprocessLockError(
        `interprocess lock queue has done marker without ticket: ${doneName(number)}`,
      );
    }
  }

  return tickets.sort((left, right) => left.number < right.number ? -1 : left.number > right.number ? 1 : 0);
};

const createOwner = (queuePath: string): string => {
  const owner = `owner-${process.pid}-${randomUUID()}.json`;
  const record: OwnerRecord = {
    version: OWNER_VERSION,
    pid: process.pid,
    owner,
    incarnation: PROCESS_INCARNATION,
  };
  writeExclusiveDurable(join(queuePath, owner), `${JSON.stringify(record)}\n`);
  return owner;
};

const createTicket = (queuePath: string, owner: string): Ticket => {
  while (true) {
    const tickets = readTickets(queuePath);
    const number = (tickets.at(-1)?.number ?? 0n) + 1n;
    const name = ticketName(number);
    try {
      linkSync(join(queuePath, owner), join(queuePath, name));
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue;
      throw error;
    }
    const ticket = { number, name };
    try {
      syncDirectory(queuePath);
    } catch (error) {
      throw new LinkedTicketError(ticket, error);
    }
    return ticket;
  }
};

const validatePrivateFile = (path: string, ticket: string, queuePath: string): void => {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw malformed(queuePath, ticket, 'entry is not a regular file');
  }
  if ((stats.mode & 0o777) !== 0o600) {
    throw malformed(queuePath, ticket, 'entry is not mode 0600');
  }
};

const readOwner = (queuePath: string, ticket: Ticket): OwnerRecord => {
  const path = join(queuePath, ticket.name);
  try {
    validatePrivateFile(path, ticket.name, queuePath);
    if (lstatSync(path).nlink < 2) {
      throw malformed(queuePath, ticket.name, 'ticket is not an owner-record hard link');
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw malformed(queuePath, ticket.name, 'owner record is not an object');
    }
    const record = parsed as Partial<OwnerRecord>;
    const ownerMatch = typeof record.owner === 'string' ? OWNER_PATTERN.exec(record.owner) : null;
    if (
      record.version !== OWNER_VERSION ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid ?? 0) <= 0 ||
      ownerMatch?.[1] !== String(record.pid) ||
      typeof record.incarnation !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.incarnation)
    ) {
      throw malformed(queuePath, ticket.name, 'owner record fields are invalid');
    }
    return record as OwnerRecord;
  } catch (error) {
    if (error instanceof InterprocessLockError) throw error;
    if (error instanceof SyntaxError) throw malformed(queuePath, ticket.name, 'owner record is invalid JSON');
    throw new InterprocessLockError(`cannot read interprocess lock predecessor: ${path}`, { cause: error });
  }
};

const doneMarkerExists = (queuePath: string, ticket: Ticket): boolean => {
  const name = doneName(ticket.number);
  const path = join(queuePath, name);
  if (!pathExists(path)) return false;
  try {
    validatePrivateFile(path, ticket.name, queuePath);
    if (readFileSync(path, 'utf8') !== DONE_CONTENTS) {
      throw malformed(queuePath, ticket.name, `done marker ${name} has invalid contents`);
    }
    return true;
  } catch (error) {
    if (error instanceof InterprocessLockError) throw error;
    throw new InterprocessLockError(`cannot read interprocess lock done marker: ${path}`, { cause: error });
  }
};

const markDone = (queuePath: string, ticket: Ticket): void => {
  const path = join(queuePath, doneName(ticket.number));
  if (doneMarkerExists(queuePath, ticket)) {
    try {
      syncFile(path);
      syncDirectory(queuePath);
      return;
    } catch (error) {
      throw new InterprocessLockError(`cannot durably sync interprocess lock done marker: ${path}`, {
        cause: error,
      });
    }
  }
  try {
    writeExclusiveDurable(path, DONE_CONTENTS);
  } catch (error) {
    if (errorCode(error) === 'EEXIST' && doneMarkerExists(queuePath, ticket)) {
      try {
        syncFile(path);
        syncDirectory(queuePath);
        return;
      } catch (syncError) {
        throw new InterprocessLockError(`cannot durably sync interprocess lock done marker: ${path}`, {
          cause: syncError,
        });
      }
    }
    throw new InterprocessLockError(`cannot durably mark interprocess lock ticket done: ${path}`, {
      cause: error,
    });
  }
};

const processIsLive = (owner: OwnerRecord): boolean => {
  // Containers commonly restart as PID 1. A different per-process UUID proves
  // that a same-PID predecessor cannot be this process incarnation.
  if (owner.pid === process.pid && owner.incarnation !== PROCESS_INCARNATION) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
};

const inspectPredecessors = (queuePath: string, ownTicket: Ticket): void => {
  const tickets = readTickets(queuePath);
  const own = tickets.find((ticket) => ticket.number === ownTicket.number);
  if (!own || doneMarkerExists(queuePath, own)) {
    throw new InterprocessLockError(`interprocess lock ownership changed for ${ownTicket.name}`);
  }
  readOwner(queuePath, own);

  for (const ticket of tickets) {
    if (ticket.number >= ownTicket.number || doneMarkerExists(queuePath, ticket)) continue;
    const owner = readOwner(queuePath, ticket);
    if (processIsLive(owner)) {
      throw new InterprocessLockBusyError(queuePath, ticket.name, owner.pid);
    }
    markDone(queuePath, ticket);
  }
};

const lockError = (queuePath: string, error: unknown): InterprocessLockError =>
  error instanceof InterprocessLockError
    ? error
    : new InterprocessLockError(`cannot acquire interprocess lock: ${queuePath}`, { cause: error });

/**
 * Acquires a non-waiting filesystem lock and returns an idempotent synchronous
 * release. A busy or corrupt predecessor fails closed; callers may retry later.
 */
export const acquireInterprocessLock = (path: string): InterprocessLockRelease => {
  const queuePath = resolve(path);
  let ownTicket: Ticket | null = null;
  try {
    ensureQueue(queuePath);
    const owner = createOwner(queuePath);
    ownTicket = createTicket(queuePath, owner);
    inspectPredecessors(queuePath, ownTicket);
  } catch (error) {
    if (error instanceof LinkedTicketError) ownTicket = error.ticket;
    const failure = lockError(queuePath, error);
    if (ownTicket) {
      try {
        markDone(queuePath, ownTicket);
      } catch (abandonError) {
        throw new InterprocessLockError(
          `interprocess lock acquisition failed and its ticket could not be marked done: ${ownTicket.name}`,
          { cause: new AggregateError([failure, abandonError]) },
        );
      }
    }
    throw failure;
  }

  let released = false;
  return () => {
    if (released) return;
    markDone(queuePath, ownTicket!);
    released = true;
  };
};

/**
 * Acquires once for the rest of this process. Repeated calls for the same
 * resolved path share one registry entry and do not enqueue behind themselves.
 */
export const acquireProcessLifetimeInterprocessLock = (
  path: string,
): ProcessLifetimeInterprocessLock => {
  const queuePath = resolve(path);
  const existing = processLifetimeLocks.get(queuePath);
  if (existing) return existing.handle;

  const release = acquireInterprocessLock(queuePath);
  let released = false;
  let acquired: ProcessLifetimeInterprocessLock;
  acquired = Object.freeze({
    queuePath,
    release: () => {
      if (released) return;
      release();
      released = true;
      if (processLifetimeLocks.get(queuePath)?.handle === acquired) {
        processLifetimeLocks.delete(queuePath);
      }
    },
  });
  processLifetimeLocks.set(queuePath, { handle: acquired, release });
  return acquired;
};
