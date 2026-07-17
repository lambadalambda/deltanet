import { describe, expect, it } from 'vitest';
import { resolveListenerConfig } from '../src/listener.js';

describe('listener security configuration', () => {
  it('binds to IPv4 loopback by default', () => {
    expect(resolveListenerConfig({})).toMatchObject({ hostname: '127.0.0.1', port: 4030 });
  });

  it.each(['0.0.0.0', '192.168.1.20', '::'])('rejects non-loopback hostname %s without an explicit opt-in', (hostname) => {
    expect(() => resolveListenerConfig({ DELTANET_HOSTNAME: hostname })).toThrow(/HEADWATER_ALLOW_NON_LOOPBACK=1/);
  });

  it.each(['127.0.0.999', '127.1.2.3.4', '127.evil.example'])('does not treat invalid 127-lookalike %s as loopback', (hostname) => {
    expect(() => resolveListenerConfig({ DELTANET_HOSTNAME: hostname })).toThrow(/HEADWATER_ALLOW_NON_LOOPBACK=1/);
  });

  it('allows a non-loopback listener only with the explicit opt-in', () => {
    expect(resolveListenerConfig({
      DELTANET_HOSTNAME: '0.0.0.0',
      DELTANET_ALLOW_NON_LOOPBACK: '1',
      PORT: '4040',
    })).toMatchObject({ hostname: '0.0.0.0', port: 4040 });
  });

  it('prefers HEADWATER listener settings and accepts DELTANET fallbacks', () => {
    expect(resolveListenerConfig({
      HEADWATER_HOSTNAME: '127.0.0.2',
      DELTANET_HOSTNAME: '127.0.0.3',
    }).hostname).toBe('127.0.0.2');
    expect(resolveListenerConfig({ DELTANET_HOSTNAME: '127.0.0.3' }).hostname).toBe('127.0.0.3');
  });
});
