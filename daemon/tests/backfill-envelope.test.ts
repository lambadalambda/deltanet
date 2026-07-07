import { describe, expect, it } from 'vitest';
import {
  buildEnvelopeRequest,
  buildEnvelopeBundle,
  buildPostObject,
  parseEnvelope,
  MAX_REFS_PER_REQUEST,
  type Envelope,
  type EnvelopeRef,
} from '../src/envelope.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const ADDR = 'alice@relay.example';

describe('envelope-request control envelope', () => {
  it('round-trips a batch of uuid refs', () => {
    const refs: EnvelopeRef[] = [
      { u: UUID, addr: ADDR },
      { u: 'bbbb2222-3333-4444-8555-666666666666', addr: ADDR },
    ];
    const env = parseEnvelope(buildEnvelopeRequest(refs));
    expect(env?.type).toBe('envelope-request');
    expect(env?.refs).toEqual(refs);
  });

  it('is unsigned (no sig/pubkey — parity with react/invite-request)', () => {
    const wire = buildEnvelopeRequest([{ u: UUID, addr: ADDR }]);
    expect(wire).not.toContain('sig');
    expect(wire).not.toContain('pubkey');
  });

  it('caps refs at MAX_REFS_PER_REQUEST', () => {
    expect(MAX_REFS_PER_REQUEST).toBe(50);
  });
});

describe('envelope-bundle control envelope', () => {
  it('round-trips embedded signed envelopes verbatim', () => {
    const inner: Envelope = { ...buildPostObject('hi', UUID), ts: 1, pubkey: 'PK', sig: 'SIG' };
    const env = parseEnvelope(buildEnvelopeBundle([inner]));
    expect(env?.type).toBe('envelope-bundle');
    expect(env?.envs).toEqual([inner]);
    // The embedded envelope keeps its own sig/pubkey — the wrapper is unsigned.
    expect(env?.envs?.[0]?.sig).toBe('SIG');
    expect(env?.sig).toBeUndefined();
  });
});

describe('unknown-type degradation (mixed-era)', () => {
  it('parseEnvelope returns null for an unknown type (old node sees plain DM)', () => {
    // An old deltanet node that predates these types: its parseEnvelope has a
    // different ENVELOPE_TYPES set, so an envelope-request degrades to null there
    // (→ treated as plain human text, invisibly ignored). We can only assert our
    // own parser accepts them; the degradation is that a NON-member type is null.
    expect(parseEnvelope('{"dn":2,"type":"totally-unknown"}')).toBeNull();
  });
});
