import { describe, expect, it } from 'vitest';
import {
  buildInviteRequestEnvelope,
  buildInviteGrantEnvelope,
  buildThreadInviteRequestEnvelope,
  buildThreadInviteGrantEnvelope,
  parseEnvelope,
  threadScopeRootUuid,
  threadScopeToken,
} from '../src/envelope.js';
import {
  parseWireInviteGrant,
  parseWireInviteRequest,
  parseWireThreadInviteGrant,
  parseWireThreadInviteRequest,
} from '../src/wire.js';

const ROOT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LINK = 'OPENPGP4FPR:DEADBEEF';

describe('scoped invite-request / invite-grant round-trip', () => {
  it('a thread invite-request carries the thread scope', () => {
    const env = parseEnvelope(buildThreadInviteRequestEnvelope(ROOT));
    expect(env?.type).toBe('invite-request');
    expect(env?.scope?.thread).toBe(`u:${ROOT}`);
    expect(threadScopeRootUuid(env?.scope)).toBe(ROOT);
    expect(parseWireThreadInviteRequest(buildThreadInviteRequestEnvelope(ROOT))).toBe(ROOT);
  });

  it('a thread invite-grant carries the scope + the link', () => {
    const wire = buildThreadInviteGrantEnvelope(ROOT, LINK);
    const env = parseEnvelope(wire);
    expect(env?.type).toBe('invite-grant');
    expect(env?.link).toBe(LINK);
    expect(threadScopeRootUuid(env?.scope)).toBe(ROOT);
    expect(parseWireThreadInviteGrant(wire)).toEqual({ rootUuid: ROOT, link: LINK });
  });

  it('scope token grammar is u:<uuid>', () => {
    expect(threadScopeToken(ROOT)).toBe(`u:${ROOT}`);
  });
});

describe('unscoped follow-back flow is UNCHANGED (regression)', () => {
  it('a plain invite-request has no thread scope and still reads as a follow-back request', () => {
    const wire = buildInviteRequestEnvelope();
    expect(parseEnvelope(wire)?.scope).toBeUndefined();
    expect(parseWireThreadInviteRequest(wire)).toBeNull(); // NOT a thread request
    expect(parseWireInviteRequest(wire)).toBe(true); // STILL a follow-back request
  });

  it('a plain invite-grant has no thread scope and still reads as a follow-back grant', () => {
    const wire = buildInviteGrantEnvelope(LINK);
    expect(parseWireThreadInviteGrant(wire)).toBeNull(); // NOT a thread grant
    expect(parseWireInviteGrant(wire)).toBe(LINK); // STILL a follow-back grant
  });

  it('a thread-scoped request/grant is ALSO readable as a plain request/grant by an old node', () => {
    // An old node without thread-scope awareness parses the scope as an unknown
    // ignored field and sees a plain invite-request/grant — so it degrades to a
    // FEED follow-back (acceptable per the design). We assert the plain parsers
    // still fire, which is what an old node relies on.
    expect(parseWireInviteRequest(buildThreadInviteRequestEnvelope(ROOT))).toBe(true);
    expect(parseWireInviteGrant(buildThreadInviteGrantEnvelope(ROOT, LINK))).toBe(LINK);
  });
});

describe('tolerant scope parsing', () => {
  it('a malformed / unknown scope degrades to unscoped (null root)', () => {
    expect(threadScopeRootUuid(undefined)).toBeNull();
    expect(threadScopeRootUuid({})).toBeNull();
    expect(threadScopeRootUuid({ thread: '' })).toBeNull();
    expect(threadScopeRootUuid({ thread: 'notauuidtoken' })).toBeNull();
    expect(threadScopeRootUuid({ thread: 'u:' })).toBeNull();
    // A request whose scope is junk falls back to the plain follow-back read.
    const junk = JSON.stringify({ dn: 2, type: 'invite-request', scope: { thread: 'x:y' } });
    expect(parseWireThreadInviteRequest(junk)).toBeNull();
    expect(parseWireInviteRequest(junk)).toBe(true);
  });

  it('parseWireThreadInviteGrant needs both a valid scope AND a link', () => {
    const noLink = JSON.stringify({ dn: 2, type: 'invite-grant', scope: { thread: `u:${ROOT}` } });
    expect(parseWireThreadInviteGrant(noLink)).toBeNull();
  });
});
