import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthStore } from '../src/auth.js';

const dirs: string[] = [];

const authPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'deltanet-auth-test-'));
  dirs.push(dir);
  return join(dir, 'auth.json');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('persisted local auth store', () => {
  const register = (auth: ReturnType<typeof createAuthStore>) => {
    const enrollment = auth.createEnrollmentCode();
    return {
      client: auth.registerClient({
        name: 'Headwater',
        redirectUri: 'http://localhost:4030/auth/callback',
        scope: 'read write follow push',
      }, { enrollmentCode: enrollment.code }),
      enrollment,
    };
  };

  it('writes Headwater-domain hashes and accepts legacy DeltaNet-domain hashes', () => {
    const path = authPath();
    const auth = createAuthStore(path);
    const { client } = register(auth);
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as any;
    expect(persisted.clients[0].secretHash).toBe(
      createHash('sha256').update('headwater:client:').update(client.clientSecret).digest('base64url'),
    );

    persisted.clients[0].secretHash = createHash('sha256')
      .update('deltanet:client:')
      .update(client.clientSecret)
      .digest('base64url');
    writeFileSync(path, `${JSON.stringify(persisted)}\n`);

    expect(createAuthStore(path).validateClientSecret(client.clientId, client.clientSecret)).toBe(true);
  });

  it('keeps legacy DeltaNet-domain access tokens valid across the rebrand', () => {
    const path = authPath();
    const auth = createAuthStore(path);
    const { client } = register(auth);
    const code = auth.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      scope: client.scope,
    });
    const session = auth.exchangeAuthorizationCode({ ...client, code });
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as any;
    persisted.sessions[0].tokenHash = createHash('sha256')
      .update('deltanet:token:')
      .update(session.accessToken)
      .digest('base64url');
    writeFileSync(path, `${JSON.stringify(persisted)}\n`);

    expect(createAuthStore(path).validateAccessToken(session.accessToken)).toMatchObject({
      clientId: client.clientId,
    });
  });

  it('persists only hashes of 256-bit client secrets, codes, and access tokens in a mode-0600 file', () => {
    const path = authPath();
    const auth = createAuthStore(path);
    const { client, enrollment } = register(auth);
    const code = auth.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      scope: client.scope,
    });
    const session = auth.exchangeAuthorizationCode({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: client.redirectUri,
      code,
    });

    for (const value of [enrollment.code, client.clientId, client.clientSecret, code, session.accessToken]) {
      expect(Buffer.from(value, 'base64url').byteLength).toBeGreaterThanOrEqual(32);
    }
    expect(new Set([client.clientId, client.clientSecret, code, session.accessToken]).size).toBe(4);

    const persisted = readFileSync(path, 'utf8');
    expect(persisted).not.toContain(enrollment.code);
    expect(persisted).not.toContain(client.clientSecret);
    expect(persisted).not.toContain(code);
    expect(persisted).not.toContain(session.accessToken);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(path, '..')).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('makes authorization codes short-lived, exact-bound, and one-use', () => {
    let now = 1_000;
    const auth = createAuthStore(authPath(), { now: () => now, authorizationCodeTtlMs: 100 });
    const { client } = register(auth);
    const issue = () => auth.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      scope: client.scope,
    });

    const wrongRedirect = issue();
    expect(() => auth.exchangeAuthorizationCode({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: 'http://localhost:4030/other',
      code: wrongRedirect,
    })).toThrow(/authorization code/i);

    const expired = issue();
    now += 101;
    expect(() => auth.exchangeAuthorizationCode({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: client.redirectUri,
      code: expired,
    })).toThrow(/authorization code/i);

    const oneUse = issue();
    const exchange = () => auth.exchangeAuthorizationCode({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: client.redirectUri,
      code: oneUse,
    });
    expect(exchange().accessToken).toBeTypeOf('string');
    expect(exchange).toThrow(/authorization code/i);
  });

  it('keeps one outstanding authorization code per client and bounds the global code set', () => {
    const path = authPath();
    const auth = createAuthStore(path, { maxClients: 4, maxAuthorizationCodes: 2 });
    const clients = Array.from({ length: 3 }, () => register(auth).client);

    const replaced = auth.issueAuthorizationCode({
      clientId: clients[0]!.clientId,
      redirectUri: clients[0]!.redirectUri,
      scope: clients[0]!.scope,
    });
    const replacement = auth.issueAuthorizationCode({
      clientId: clients[0]!.clientId,
      redirectUri: clients[0]!.redirectUri,
      scope: clients[0]!.scope,
    });
    expect(() => auth.exchangeAuthorizationCode({ ...clients[0]!, code: replaced })).toThrow(/authorization code/i);

    const second = auth.issueAuthorizationCode({
      clientId: clients[1]!.clientId,
      redirectUri: clients[1]!.redirectUri,
      scope: clients[1]!.scope,
    });
    const third = auth.issueAuthorizationCode({
      clientId: clients[2]!.clientId,
      redirectUri: clients[2]!.redirectUri,
      scope: clients[2]!.scope,
    });

    const persisted = JSON.parse(readFileSync(path, 'utf8')) as { authorizationCodes: unknown[] };
    expect(persisted.authorizationCodes).toHaveLength(2);
    expect(() => auth.exchangeAuthorizationCode({ ...clients[0]!, code: replacement })).toThrow(/authorization code/i);
    expect(auth.exchangeAuthorizationCode({ ...clients[1]!, code: second }).accessToken).toBeTypeOf('string');
    expect(auth.exchangeAuthorizationCode({ ...clients[2]!, code: third }).accessToken).toBeTypeOf('string');
  });

  it('normalizes outstanding authorization codes to the bound on restart', () => {
    const path = authPath();
    const first = createAuthStore(path, { maxClients: 4, maxAuthorizationCodes: 4 });
    const clients = Array.from({ length: 3 }, () => register(first).client);
    const codes = clients.map((client) => first.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      scope: client.scope,
    }));

    const restarted = createAuthStore(path, { maxClients: 4, maxAuthorizationCodes: 2 });
    expect((JSON.parse(readFileSync(path, 'utf8')) as { authorizationCodes: unknown[] }).authorizationCodes).toHaveLength(2);
    expect(() => restarted.exchangeAuthorizationCode({ ...clients[0]!, code: codes[0]! })).toThrow(/authorization code/i);
    expect(restarted.exchangeAuthorizationCode({ ...clients[1]!, code: codes[1]! }).accessToken).toBeTypeOf('string');
    expect(restarted.exchangeAuthorizationCode({ ...clients[2]!, code: codes[2]! }).accessToken).toBeTypeOf('string');
  });

  it('persists expiring sessions and revocation across normal restarts', () => {
    let now = 10_000;
    const path = authPath();
    const options = { now: () => now, sessionTtlMs: 1_000 };
    const first = createAuthStore(path, options);
    const { client } = register(first);
    const code = first.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      scope: client.scope,
    });
    const { accessToken } = first.exchangeAuthorizationCode({ ...client, code });

    const restarted = createAuthStore(path, options);
    expect(restarted.validateAccessToken(accessToken)).toMatchObject({ clientId: client.clientId });
    expect(restarted.revokeAccessToken(accessToken)).toBe(true);
    expect(createAuthStore(path, options).validateAccessToken(accessToken)).toBeNull();

    const nextCode = restarted.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      scope: client.scope,
    });
    const next = restarted.exchangeAuthorizationCode({ ...client, code: nextCode });
    now += 1_001;
    expect(restarted.validateAccessToken(next.accessToken)).toBeNull();
  });

  it('signs short-lived blob capabilities with a persisted secret', () => {
    let now = 20_000;
    const path = authPath();
    const auth = createAuthStore(path, { now: () => now });
    const signed = auth.signBlobPath(42, 500);

    expect(auth.verifyBlobSignature(42, signed.expires, signed.signature)).toBe(true);
    expect(auth.verifyBlobSignature(43, signed.expires, signed.signature)).toBe(false);
    expect(createAuthStore(path, { now: () => now }).verifyBlobSignature(42, signed.expires, signed.signature)).toBe(true);
    expect(auth.signBlobPath(42, 120_000).expires).toBe(now + 60_000);
    now += 501;
    expect(auth.verifyBlobSignature(42, signed.expires, signed.signature)).toBe(false);
  });

  it('requires one-use unexpired enrollment proof, supports an existing session, and bounds client count', () => {
    let now = 30_000;
    const auth = createAuthStore(authPath(), {
      now: () => now,
      enrollmentCodeTtlMs: 100,
      maxClients: 2,
    });
    const input = {
      name: 'Headwater',
      redirectUri: 'http://localhost:4030/auth/callback',
      scope: 'read write follow push',
    };
    expect(() => auth.registerClient(input, {})).toThrow(/enrollment/i);

    const expired = auth.createEnrollmentCode();
    now += 101;
    expect(() => auth.registerClient(input, { enrollmentCode: expired.code })).toThrow(/enrollment/i);

    const enrollment = auth.createEnrollmentCode();
    const client = auth.registerClient(input, { enrollmentCode: enrollment.code });
    expect(() => auth.registerClient(input, { enrollmentCode: enrollment.code })).toThrow(/enrollment/i);

    const code = auth.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      scope: client.scope,
    });
    const session = auth.exchangeAuthorizationCode({ ...client, code });
    const second = auth.registerClient(input, { accessToken: session.accessToken });
    expect(second.clientId).not.toBe(client.clientId);

    const thirdEnrollment = auth.createEnrollmentCode();
    expect(() => auth.registerClient(input, { enrollmentCode: thirdEnrollment.code })).toThrow(/client limit/i);
  });

  it('validates current terminal enrollment proof without consuming it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deltanet-auth-proof-'));
    const auth = createAuthStore(join(dir, 'auth.json'));
    const enrollment = auth.createEnrollmentCode();
    expect(auth.validateEnrollmentCode(enrollment.code)).toBe(true);
    expect(auth.validateEnrollmentCode('incorrect')).toBe(false);
    expect(auth.validateEnrollmentCode(enrollment.code)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('issues hash-only one-use stream tickets bound to a live session', () => {
    let now = 40_000;
    const path = authPath();
    const auth = createAuthStore(path, { now: () => now, streamTicketTtlMs: 100 });
    const { client } = register(auth);
    const code = auth.issueAuthorizationCode({ clientId: client.clientId, redirectUri: client.redirectUri, scope: client.scope });
    const session = auth.exchangeAuthorizationCode({ ...client, code });
    const issued = auth.issueStreamTicket(session.accessToken);

    expect(readFileSync(path, 'utf8')).not.toContain(issued.ticket);
    expect(auth.consumeStreamTicket(issued.ticket)).toMatchObject({ clientId: client.clientId });
    expect(auth.consumeStreamTicket(issued.ticket)).toBeNull();

    const expired = auth.issueStreamTicket(session.accessToken);
    now += 101;
    expect(auth.consumeStreamTicket(expired.ticket)).toBeNull();

    const revoked = auth.issueStreamTicket(session.accessToken);
    auth.revokeAccessToken(session.accessToken);
    expect(auth.consumeStreamTicket(revoked.ticket)).toBeNull();
  });

  it('unpairs the access token client and invalidates all of its authority', () => {
    const auth = createAuthStore(authPath());
    const { client } = register(auth);
    const issueSession = () => {
      const code = auth.issueAuthorizationCode({
        clientId: client.clientId,
        redirectUri: client.redirectUri,
        scope: client.scope,
      });
      return auth.exchangeAuthorizationCode({ ...client, code });
    };
    const first = issueSession();
    const second = issueSession();
    const firstTicket = auth.issueStreamTicket(first.accessToken);
    const secondTicket = auth.issueStreamTicket(second.accessToken);
    const retainedCode = auth.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      scope: client.scope,
    });
    const invalidated: string[] = [];
    auth.onSessionInvalidated((sessionId) => invalidated.push(sessionId));

    expect(auth.revokeClientForAccessToken(first.accessToken)).toBe(true);
    expect(auth.client(client.clientId)).toBeNull();
    expect(auth.validateClientSecret(client.clientId, client.clientSecret)).toBe(false);
    expect(auth.validateAccessToken(first.accessToken)).toBeNull();
    expect(auth.validateAccessToken(second.accessToken)).toBeNull();
    expect(auth.consumeStreamTicket(firstTicket.ticket)).toBeNull();
    expect(auth.consumeStreamTicket(secondTicket.ticket)).toBeNull();
    expect(invalidated).toEqual(expect.arrayContaining([first.sessionId, second.sessionId]));
    expect(() => auth.exchangeAuthorizationCode({ ...client, code: retainedCode })).toThrow(/client credentials/i);
    expect(() => auth.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      scope: client.scope,
    })).toThrow(/authorization request/i);
  });

  it('rotates every credential and capability when the bound account identity changes', () => {
    const path = authPath();
    const auth = createAuthStore(path);
    expect(auth.bindAccount('alice@example.org')).toBe(true);
    const { client } = register(auth);
    const code = auth.issueAuthorizationCode({ clientId: client.clientId, redirectUri: client.redirectUri, scope: client.scope });
    const session = auth.exchangeAuthorizationCode({ ...client, code });
    const ticket = auth.issueStreamTicket(session.accessToken);
    const blob = auth.signBlobPath(42);

    expect(auth.bindAccount('alice@example.org')).toBe(false);
    expect(auth.validateAccessToken(session.accessToken)).not.toBeNull();
    expect(auth.bindAccount('bob@example.org')).toBe(true);
    expect(auth.client(client.clientId)).toBeNull();
    expect(auth.validateAccessToken(session.accessToken)).toBeNull();
    expect(auth.consumeStreamTicket(ticket.ticket)).toBeNull();
    expect(auth.verifyBlobSignature(42, blob.expires, blob.signature)).toBe(false);
    expect(createAuthStore(path).validateAccessToken(session.accessToken)).toBeNull();
  });
});
