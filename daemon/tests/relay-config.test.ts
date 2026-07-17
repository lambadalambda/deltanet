import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HTTPS_PORT,
  DEFAULT_IMAPS_PORT,
  DEFAULT_SMTPS_PORT,
  resolveTestRelayConfig,
} from '../src/testenv/relay-config.js';
import { buildEnteredLoginParam } from '../src/transport/deltachat.js';

describe('resolveTestRelayConfig', () => {
  it('prefers HEADWATER relay variables over DELTANET fallbacks', () => {
    const cfg = resolveTestRelayConfig({
      HEADWATER_TEST_RELAY_URL: 'https://headwater.local:8443',
      DELTANET_TEST_RELAY_URL: 'https://legacy.local:8443',
      HEADWATER_TEST_RELAY_HOST: 'headwater.local',
      DELTANET_TEST_RELAY_HOST: 'legacy.local',
    });
    expect(cfg.relayUrl).toBe('https://headwater.local:8443');
    expect(cfg.transportParams?.imapHost).toBe('headwater.local');
  });

  it('uses the testrun.org autoconfig path when HEADWATER_TEST_RELAY=testrun', () => {
    const cfg = resolveTestRelayConfig({ HEADWATER_TEST_RELAY: 'testrun' });
    expect(cfg).toEqual({
      relayUrl: 'https://nine.testrun.org',
      transportParams: null,
      isTestrun: true,
    });
  });

  it('retains DELTANET_TEST_RELAY as a legacy fallback', () => {
    expect(resolveTestRelayConfig({ DELTANET_TEST_RELAY: 'testrun' }).isTestrun).toBe(true);
  });

  it('defaults to a local relay with explicit params and cert acceptance', () => {
    const cfg = resolveTestRelayConfig({});
    expect(cfg.isTestrun).toBe(false);
    expect(cfg.relayUrl).toBe(`https://127.0.0.1:${DEFAULT_HTTPS_PORT}`);
    expect(cfg.transportParams).toEqual({
      imapHost: '127.0.0.1',
      imapPort: DEFAULT_IMAPS_PORT,
      smtpHost: '127.0.0.1',
      smtpPort: DEFAULT_SMTPS_PORT,
      acceptInvalidCerts: true,
    });
  });

  it('derives the transport host from DELTANET_TEST_RELAY_URL', () => {
    const cfg = resolveTestRelayConfig({
      DELTANET_TEST_RELAY_URL: 'https://relay.local:12345',
    });
    expect(cfg.relayUrl).toBe('https://relay.local:12345');
    expect(cfg.transportParams?.imapHost).toBe('relay.local');
    expect(cfg.transportParams?.smtpHost).toBe('relay.local');
  });

  it('honors explicit port + host overrides', () => {
    const cfg = resolveTestRelayConfig({
      DELTANET_TEST_RELAY_HOST: '10.0.0.5',
      DELTANET_TEST_RELAY_IMAPS_PORT: '11993',
      DELTANET_TEST_RELAY_SMTPS_PORT: '11465',
      DELTANET_TEST_RELAY_HTTPS_PORT: '18443',
    });
    expect(cfg.relayUrl).toBe('https://127.0.0.1:18443');
    expect(cfg.transportParams).toMatchObject({
      imapHost: '10.0.0.5',
      imapPort: 11993,
      smtpHost: '10.0.0.5',
      smtpPort: 11465,
    });
  });

  it('falls back to defaults for non-numeric/blank ports', () => {
    const cfg = resolveTestRelayConfig({ DELTANET_TEST_RELAY_IMAPS_PORT: 'nope' });
    expect(cfg.transportParams?.imapPort).toBe(DEFAULT_IMAPS_PORT);
  });
});

describe('buildEnteredLoginParam', () => {
  const creds = { addr: 'a@relay.local', password: 'pw123', displayName: 'A' };

  it('maps credentials + explicit servers to ssl transports', () => {
    const param = buildEnteredLoginParam(creds, {
      imapHost: 'relay.local',
      imapPort: 993,
      smtpHost: 'relay.local',
      smtpPort: 465,
      acceptInvalidCerts: true,
    });
    expect(param).toMatchObject({
      addr: 'a@relay.local',
      password: 'pw123',
      imapServer: 'relay.local',
      imapPort: 993,
      imapSecurity: 'ssl',
      smtpServer: 'relay.local',
      smtpPort: 465,
      smtpSecurity: 'ssl',
      certificateChecks: 'acceptInvalidCertificates',
    });
  });

  it('uses automatic cert checks when acceptInvalidCerts is false', () => {
    const param = buildEnteredLoginParam(creds, {
      imapHost: 'relay.local',
      imapPort: 993,
      smtpHost: 'relay.local',
      smtpPort: 465,
      acceptInvalidCerts: false,
    });
    expect(param.certificateChecks).toBe('automatic');
  });
});
