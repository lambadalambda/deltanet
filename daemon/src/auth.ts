import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const AUTH_VERSION = 1;
const RANDOM_BYTES = 32;
const DEFAULT_AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_ENROLLMENT_CODE_TTL_MS = 10 * 60_000;
const DEFAULT_STREAM_TICKET_TTL_MS = 30_000;
const DEFAULT_MAX_CLIENTS = 32;
const DEFAULT_MAX_AUTHORIZATION_CODES = 32;
const MAX_BLOB_CAPABILITY_TTL_MS = 60_000;

type ClientRecord = {
  clientId: string;
  name: string;
  redirectUri: string;
  scope: string;
  secretHash: string;
  createdAt: number;
};

type AuthorizationCodeRecord = {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  expiresAt: number;
};

type SessionRecord = {
  tokenHash: string;
  clientId: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
};

type EnrollmentCodeRecord = {
  codeHash: string;
  expiresAt: number;
};

type StreamTicketRecord = {
  ticketHash: string;
  sessionId: string;
  expiresAt: number;
};

type AuthData = {
  version: typeof AUTH_VERSION;
  signingSecret: string;
  accountIdentity: string | null;
  epoch: string;
  clients: ClientRecord[];
  authorizationCodes: AuthorizationCodeRecord[];
  sessions: SessionRecord[];
  enrollmentCode: EnrollmentCodeRecord | null;
  streamTickets: StreamTicketRecord[];
};

export type RegisteredClient = {
  clientId: string;
  clientSecret: string;
  name: string;
  redirectUri: string;
  scope: string;
};

export type AuthSession = {
  sessionId: string;
  clientId: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
};

export type IssuedSession = AuthSession & {
  accessToken: string;
  tokenType: 'Bearer';
};

export type AuthStore = {
  filePath: string;
  bindAccount(accountIdentity: string | null): boolean;
  createEnrollmentCode(): { code: string; expiresAt: number };
  registerClient(
    input: { name: string; redirectUri: string; scope: string },
    proof: { enrollmentCode?: string; accessToken?: string },
  ): RegisteredClient;
  client(clientId: string): Omit<ClientRecord, 'secretHash'> | null;
  validateClientSecret(clientId: string, clientSecret: string): boolean;
  issueAuthorizationCode(input: { clientId: string; redirectUri: string; scope: string }): string;
  exchangeAuthorizationCode(input: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
  }): IssuedSession;
  validateAccessToken(accessToken: string): AuthSession | null;
  revokeAccessToken(accessToken: string): boolean;
  revokeClientForAccessToken(accessToken: string): boolean;
  issueStreamTicket(accessToken: string): { ticket: string; expiresAt: number };
  consumeStreamTicket(ticket: string): AuthSession | null;
  onSessionInvalidated(listener: (sessionId: string) => void): () => void;
  signBlobPath(msgId: number, ttlMs?: number): { expires: number; signature: string };
  verifyBlobSignature(msgId: number, expires: number, signature: string): boolean;
};

export class AuthError extends Error {
  constructor(
    public readonly code:
      | 'invalid_client'
      | 'invalid_grant'
      | 'invalid_request'
      | 'invalid_enrollment'
      | 'client_limit',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

type AuthStoreOptions = {
  now?: () => number;
  authorizationCodeTtlMs?: number;
  sessionTtlMs?: number;
  enrollmentCodeTtlMs?: number;
  streamTicketTtlMs?: number;
  maxClients?: number;
  maxAuthorizationCodes?: number;
};

const randomValue = (): string => randomBytes(RANDOM_BYTES).toString('base64url');

const secretHash = (kind: 'client' | 'code' | 'token' | 'enrollment' | 'ticket', value: string): string =>
  createHash('sha256').update(`deltanet:${kind}:`).update(value).digest('base64url');

const equalHash = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
};

const atomicWrite = (path: string, data: AuthData): void => {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    const directoryFd = openSync(parent, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(temporary, { force: true });
  }
};

const readAuthData = (path: string): AuthData => {
  chmodSync(path, 0o600);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AuthData>;
  const validClient = (value: unknown): value is ClientRecord => {
    const record = value as Partial<ClientRecord> | null;
    return Boolean(
      record &&
      typeof record.clientId === 'string' &&
      typeof record.name === 'string' &&
      typeof record.redirectUri === 'string' &&
      typeof record.scope === 'string' &&
      typeof record.secretHash === 'string' &&
      typeof record.createdAt === 'number',
    );
  };
  const validCode = (value: unknown): value is AuthorizationCodeRecord => {
    const record = value as Partial<AuthorizationCodeRecord> | null;
    return Boolean(
      record &&
      typeof record.codeHash === 'string' &&
      typeof record.clientId === 'string' &&
      typeof record.redirectUri === 'string' &&
      typeof record.scope === 'string' &&
      typeof record.expiresAt === 'number',
    );
  };
  const validSession = (value: unknown): value is SessionRecord => {
    const record = value as Partial<SessionRecord> | null;
    return Boolean(
      record &&
      typeof record.tokenHash === 'string' &&
      typeof record.clientId === 'string' &&
      typeof record.scope === 'string' &&
      typeof record.createdAt === 'number' &&
      typeof record.expiresAt === 'number' &&
      (record.revokedAt === undefined || typeof record.revokedAt === 'number'),
    );
  };
  const validEnrollmentCode = (value: unknown): value is EnrollmentCodeRecord => {
    const record = value as Partial<EnrollmentCodeRecord> | null;
    return Boolean(
      record &&
      typeof record.codeHash === 'string' &&
      typeof record.expiresAt === 'number',
    );
  };
  const validStreamTicket = (value: unknown): value is StreamTicketRecord => {
    const record = value as Partial<StreamTicketRecord> | null;
    return Boolean(
      record &&
      typeof record.ticketHash === 'string' &&
      typeof record.sessionId === 'string' &&
      typeof record.expiresAt === 'number',
    );
  };
  if (
    parsed.version !== AUTH_VERSION ||
    typeof parsed.signingSecret !== 'string' ||
    Buffer.from(parsed.signingSecret, 'base64url').byteLength < RANDOM_BYTES ||
    !Array.isArray(parsed.clients) ||
    !parsed.clients.every(validClient) ||
    !Array.isArray(parsed.authorizationCodes) ||
    !parsed.authorizationCodes.every(validCode) ||
    !Array.isArray(parsed.sessions) ||
    !parsed.sessions.every(validSession) ||
    (parsed.accountIdentity !== undefined && parsed.accountIdentity !== null && typeof parsed.accountIdentity !== 'string') ||
    (parsed.epoch !== undefined && typeof parsed.epoch !== 'string') ||
    (parsed.enrollmentCode !== undefined && parsed.enrollmentCode !== null && !validEnrollmentCode(parsed.enrollmentCode)) ||
    (parsed.streamTickets !== undefined && (!Array.isArray(parsed.streamTickets) || !parsed.streamTickets.every(validStreamTicket)))
  ) {
    throw new Error(`unsupported or corrupt auth store: ${path}`);
  }
  return {
    ...(parsed as Omit<AuthData, 'accountIdentity' | 'epoch' | 'enrollmentCode' | 'streamTickets'>),
    accountIdentity: parsed.accountIdentity ?? null,
    epoch: parsed.epoch ?? randomValue(),
    enrollmentCode: parsed.enrollmentCode ?? null,
    streamTickets: parsed.streamTickets ?? [],
  };
};

export const createAuthStore = (filePath: string, options: AuthStoreOptions = {}): AuthStore => {
  const now = options.now ?? Date.now;
  const authorizationCodeTtlMs = options.authorizationCodeTtlMs ?? DEFAULT_AUTHORIZATION_CODE_TTL_MS;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const enrollmentCodeTtlMs = options.enrollmentCodeTtlMs ?? DEFAULT_ENROLLMENT_CODE_TTL_MS;
  const streamTicketTtlMs = options.streamTicketTtlMs ?? DEFAULT_STREAM_TICKET_TTL_MS;
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
  const maxAuthorizationCodes = Math.max(1, options.maxAuthorizationCodes ?? DEFAULT_MAX_AUTHORIZATION_CODES);
  const invalidationListeners = new Set<(sessionId: string) => void>();
  let data: AuthData = existsSync(filePath)
    ? readAuthData(filePath)
    : {
        version: AUTH_VERSION,
        signingSecret: randomValue(),
        accountIdentity: null,
        epoch: randomValue(),
        clients: [],
        authorizationCodes: [],
        sessions: [],
        enrollmentCode: null,
        streamTickets: [],
      };

  const timestamp = now();
  const clientIds = new Set(data.clients.map((client) => client.clientId));
  const seenCodeClients = new Set<string>();
  const normalizedCodes: AuthorizationCodeRecord[] = [];
  for (let index = data.authorizationCodes.length - 1; index >= 0; index -= 1) {
    const code = data.authorizationCodes[index]!;
    if (
      code.expiresAt <= timestamp ||
      !clientIds.has(code.clientId) ||
      seenCodeClients.has(code.clientId)
    ) continue;
    seenCodeClients.add(code.clientId);
    normalizedCodes.push(code);
    if (normalizedCodes.length === maxAuthorizationCodes) break;
  }
  data = { ...data, authorizationCodes: normalizedCodes.reverse() };

  atomicWrite(filePath, data);

  const persist = (next: AuthData): void => {
    atomicWrite(filePath, next);
    data = next;
  };

  const clientRecord = (clientId: string): ClientRecord | null =>
    data.clients.find((client) => client.clientId === clientId) ?? null;

  const publicClient = (record: ClientRecord): Omit<ClientRecord, 'secretHash'> => {
    const { secretHash: _secretHash, ...client } = record;
    return client;
  };

  const notifyInvalidated = (sessionIds: string[]): void => {
    for (const sessionId of sessionIds) {
      for (const listener of invalidationListeners) listener(sessionId);
    }
  };

  const bindAccount = (accountIdentity: string | null): boolean => {
    if (data.accountIdentity === accountIdentity) return false;
    const sessionIds = data.sessions
      .filter((session) => session.revokedAt === undefined && session.expiresAt > now())
      .map((session) => session.tokenHash);
    persist({
      version: AUTH_VERSION,
      signingSecret: randomValue(),
      accountIdentity,
      epoch: randomValue(),
      clients: [],
      authorizationCodes: [],
      sessions: [],
      enrollmentCode: null,
      streamTickets: [],
    });
    notifyInvalidated(sessionIds);
    return true;
  };

  const createEnrollmentCode = (): { code: string; expiresAt: number } => {
    const code = randomValue();
    const expiresAt = now() + enrollmentCodeTtlMs;
    persist({
      ...data,
      enrollmentCode: { codeHash: secretHash('enrollment', code), expiresAt },
    });
    return { code, expiresAt };
  };

  const registerClient: AuthStore['registerClient'] = ({ name, redirectUri, scope }, proof) => {
    const timestamp = now();
    const enrollmentHash = proof.enrollmentCode
      ? secretHash('enrollment', proof.enrollmentCode)
      : null;
    const enrollmentValid = Boolean(
      enrollmentHash &&
      data.enrollmentCode &&
      data.enrollmentCode.expiresAt > timestamp &&
      equalHash(data.enrollmentCode.codeHash, enrollmentHash),
    );
    const sessionValid = Boolean(proof.accessToken && validateAccessToken(proof.accessToken));
    if (!enrollmentValid && !sessionValid) {
      throw new AuthError('invalid_enrollment', 'valid enrollment proof is required');
    }
    if (data.clients.length >= maxClients) {
      throw new AuthError('client_limit', 'OAuth client limit reached');
    }
    const clientId = randomValue();
    const clientSecret = randomValue();
    const record: ClientRecord = {
      clientId,
      name,
      redirectUri,
      scope,
      secretHash: secretHash('client', clientSecret),
      createdAt: now(),
    };
    persist({
      ...data,
      clients: [...data.clients, record],
      ...(enrollmentValid ? { enrollmentCode: null } : {}),
    });
    return { clientId, clientSecret, name, redirectUri, scope };
  };

  const validateClientSecret = (clientId: string, clientSecret: string): boolean => {
    const record = clientRecord(clientId);
    return record !== null && equalHash(record.secretHash, secretHash('client', clientSecret));
  };

  const issueAuthorizationCode: AuthStore['issueAuthorizationCode'] = ({ clientId, redirectUri, scope }) => {
    const client = clientRecord(clientId);
    const requestedScopes = scope.split(/\s+/).filter(Boolean);
    const registeredScopes = new Set(client?.scope.split(/\s+/).filter(Boolean) ?? []);
    if (
      !client ||
      client.redirectUri !== redirectUri ||
      requestedScopes.length === 0 ||
      requestedScopes.some((requested) => !registeredScopes.has(requested))
    ) {
      throw new AuthError('invalid_request', 'invalid authorization request');
    }
    const code = randomValue();
    const cutoff = now();
    const record: AuthorizationCodeRecord = {
      codeHash: secretHash('code', code),
      clientId,
      redirectUri,
      scope: requestedScopes.join(' '),
      expiresAt: cutoff + authorizationCodeTtlMs,
    };
    persist({
      ...data,
      authorizationCodes: [
        ...data.authorizationCodes.filter(
          (candidate) => candidate.expiresAt > cutoff && candidate.clientId !== clientId,
        ),
        record,
      ].slice(-maxAuthorizationCodes),
    });
    return code;
  };

  const exchangeAuthorizationCode: AuthStore['exchangeAuthorizationCode'] = ({
    clientId,
    clientSecret,
    redirectUri,
    code,
  }) => {
    if (!validateClientSecret(clientId, clientSecret)) {
      throw new AuthError('invalid_client', 'invalid OAuth client credentials');
    }
    const codeHash = secretHash('code', code);
    const record = data.authorizationCodes.find((candidate) => equalHash(candidate.codeHash, codeHash));
    const timestamp = now();
    if (
      !record ||
      record.clientId !== clientId ||
      record.redirectUri !== redirectUri ||
      record.expiresAt <= timestamp
    ) {
      throw new AuthError('invalid_grant', 'invalid or expired authorization code');
    }

    const accessToken = randomValue();
    const session: SessionRecord = {
      tokenHash: secretHash('token', accessToken),
      clientId,
      scope: record.scope,
      createdAt: timestamp,
      expiresAt: timestamp + sessionTtlMs,
    };
    persist({
      ...data,
      authorizationCodes: data.authorizationCodes.filter((candidate) => candidate !== record),
      sessions: [
        ...data.sessions.filter((candidate) => candidate.expiresAt > timestamp),
        session,
      ],
    });
    return {
      accessToken,
      tokenType: 'Bearer',
      sessionId: session.tokenHash,
      clientId,
      scope: session.scope,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  };

  const sessionView = (session: SessionRecord): AuthSession => ({
    sessionId: session.tokenHash,
    clientId: session.clientId,
    scope: session.scope,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  });

  const validateAccessToken = (accessToken: string): AuthSession | null => {
    if (!accessToken) return null;
    const tokenHash = secretHash('token', accessToken);
    const session = data.sessions.find((candidate) => equalHash(candidate.tokenHash, tokenHash));
    if (!session || session.revokedAt !== undefined || session.expiresAt <= now()) return null;
    return sessionView(session);
  };

  const revokeAccessToken = (accessToken: string): boolean => {
    if (!accessToken) return false;
    const tokenHash = secretHash('token', accessToken);
    const index = data.sessions.findIndex((candidate) => equalHash(candidate.tokenHash, tokenHash));
    if (index === -1 || data.sessions[index]!.revokedAt !== undefined) return false;
    const sessions = data.sessions.map((session, sessionIndex) =>
      sessionIndex === index ? { ...session, revokedAt: now() } : session,
    );
    persist({ ...data, sessions });
    notifyInvalidated([data.sessions[index]!.tokenHash]);
    return true;
  };

  const revokeClientForAccessToken = (accessToken: string): boolean => {
    const session = validateAccessToken(accessToken);
    if (!session) return false;
    const sessionIds = data.sessions
      .filter((candidate) => candidate.clientId === session.clientId)
      .map((candidate) => candidate.tokenHash);
    const sessionIdSet = new Set(sessionIds);
    persist({
      ...data,
      clients: data.clients.filter((client) => client.clientId !== session.clientId),
      authorizationCodes: data.authorizationCodes.filter((code) => code.clientId !== session.clientId),
      sessions: data.sessions.filter((candidate) => candidate.clientId !== session.clientId),
      streamTickets: data.streamTickets.filter((ticket) => !sessionIdSet.has(ticket.sessionId)),
    });
    notifyInvalidated(sessionIds);
    return true;
  };

  const issueStreamTicket = (accessToken: string): { ticket: string; expiresAt: number } => {
    const session = validateAccessToken(accessToken);
    if (!session) throw new AuthError('invalid_grant', 'valid session required for stream ticket');
    const ticket = randomValue();
    const timestamp = now();
    const expiresAt = Math.min(timestamp + streamTicketTtlMs, session.expiresAt);
    persist({
      ...data,
      streamTickets: [
        ...data.streamTickets.filter((candidate) => candidate.expiresAt > timestamp),
        {
          ticketHash: secretHash('ticket', ticket),
          sessionId: session.sessionId,
          expiresAt,
        },
      ],
    });
    return { ticket, expiresAt };
  };

  const consumeStreamTicket = (ticket: string): AuthSession | null => {
    if (!ticket) return null;
    const ticketHash = secretHash('ticket', ticket);
    const record = data.streamTickets.find((candidate) => equalHash(candidate.ticketHash, ticketHash));
    if (!record) return null;
    persist({
      ...data,
      streamTickets: data.streamTickets.filter((candidate) => candidate !== record),
    });
    const session = data.sessions.find((candidate) => candidate.tokenHash === record.sessionId);
    if (
      record.expiresAt <= now() ||
      !session ||
      session.revokedAt !== undefined ||
      session.expiresAt <= now()
    ) return null;
    return sessionView(session);
  };

  const blobSignature = (msgId: number, expires: number): string =>
    createHmac('sha256', Buffer.from(data.signingSecret, 'base64url'))
      .update(`${data.epoch}.${msgId}.${expires}`)
      .digest('base64url');

  const signBlobPath = (msgId: number, ttlMs = MAX_BLOB_CAPABILITY_TTL_MS) => {
    const expires = now() + Math.min(Math.max(0, ttlMs), MAX_BLOB_CAPABILITY_TTL_MS);
    return { expires, signature: blobSignature(msgId, expires) };
  };

  const verifyBlobSignature = (msgId: number, expires: number, signature: string): boolean => {
    if (!Number.isSafeInteger(expires) || expires <= now() || !signature) return false;
    return equalHash(blobSignature(msgId, expires), signature);
  };

  return {
    filePath,
    bindAccount,
    createEnrollmentCode,
    registerClient,
    client: (clientId) => {
      const record = clientRecord(clientId);
      return record ? publicClient(record) : null;
    },
    validateClientSecret,
    issueAuthorizationCode,
    exchangeAuthorizationCode,
    validateAccessToken,
    revokeAccessToken,
    revokeClientForAccessToken,
    issueStreamTicket,
    consumeStreamTicket,
    onSessionInvalidated: (listener) => {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    },
    signBlobPath,
    verifyBlobSignature,
  };
};
