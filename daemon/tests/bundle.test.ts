import { describe, expect, it } from 'vitest';
import { servableEnvelope, chunkBundles, MAX_BUNDLE_BYTES } from '../src/bundle.js';
import { buildPostObject, parseEnvelope, type Envelope } from '../src/envelope.js';

const sign = (env: Envelope): Envelope => ({ ...env, ts: 1, pubkey: 'PK', sig: 'SIG' });
const uuidN = (n: number) => `${String(n).padStart(8, '0')}-2222-4333-8444-555555555555`;

describe('servableEnvelope: verbatim signed content only', () => {
  it('serves a signed post verbatim', () => {
    const env = sign(buildPostObject('x', uuidN(1)));
    expect(servableEnvelope(env)).toBe(env);
  });
  it('omits unsigned / control / null', () => {
    expect(servableEnvelope(buildPostObject('x', uuidN(1)))).toBeNull();
    expect(servableEnvelope(null)).toBeNull();
    expect(servableEnvelope({ dn: 2, type: 'react', emoji: '❤', sig: 'S', pubkey: 'P', ts: 1 } as Envelope)).toBeNull();
  });
});

describe('chunkBundles: size-capped splitting', () => {
  it('packs several small envelopes into one bundle', () => {
    const envs = [1, 2, 3].map((n) => sign(buildPostObject('short', uuidN(n))));
    const bundles = chunkBundles(envs);
    expect(bundles).toHaveLength(1);
    expect(parseEnvelope(bundles[0]!)?.envs).toHaveLength(3);
  });

  it('returns no bundle for an empty input (omission is valid)', () => {
    expect(chunkBundles([])).toEqual([]);
  });

  it('splits into multiple bundles when the cap is exceeded', () => {
    // A tiny cap forces one envelope per bundle.
    const envs = [1, 2, 3].map((n) => sign(buildPostObject('some text here', uuidN(n))));
    const bundles = chunkBundles(envs, 120);
    expect(bundles.length).toBeGreaterThan(1);
    // Every original envelope is present across the bundles, none dropped.
    const total = bundles.reduce((acc, b) => acc + (parseEnvelope(b)?.envs?.length ?? 0), 0);
    expect(total).toBe(3);
  });

  it('ships an oversized single envelope alone rather than dropping it', () => {
    const big = sign(buildPostObject('x'.repeat(200), uuidN(1)));
    const small = sign(buildPostObject('y', uuidN(2)));
    const bundles = chunkBundles([big, small], 100);
    const total = bundles.reduce((acc, b) => acc + (parseEnvelope(b)?.envs?.length ?? 0), 0);
    expect(total).toBe(2);
  });

  it('MAX_BUNDLE_BYTES is ~100KB', () => {
    expect(MAX_BUNDLE_BYTES).toBe(100_000);
  });
});
