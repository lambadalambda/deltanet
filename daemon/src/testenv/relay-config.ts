/**
 * Resolves which chatmail relay the integration suite should run against,
 * from environment variables. Two modes:
 *
 * - `testrun` — the historical behavior: register accounts on the real
 *   production relay `nine.testrun.org` over autoconfig, no explicit
 *   transport params. Opt in with `HEADWATER_TEST_RELAY=testrun`.
 * - local (the default) — a throwaway podman-hosted chatmail relay reachable
 *   at `HEADWATER_TEST_RELAY_URL` (an `https://host:port` base). Transports use
 *   explicit IMAP/SMTP host+port with self-signed-certificate acceptance, so
 *   no DNS autoconfig or valid TLS chain is needed.
 *
 * Kept as a pure function of an env-like record so it is unit-testable
 * without touching `process.env` or the network.
 */

/** Explicit IMAP/SMTP server coordinates for a transport that skips autoconfig. */
export type ExplicitTransportParams = {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** Accept self-signed / hostname-mismatched TLS certs (self-signed relay). */
  acceptInvalidCerts: boolean;
};

export type TestRelayConfig = {
  /** How `registerAccount` reaches `POST /new`, e.g. `https://localhost:8443`. */
  relayUrl: string;
  /**
   * Explicit transport params to hand `openTransport`, or `null` to use
   * autoconfig (the testrun path). When set, TLS cert checks are relaxed.
   */
  transportParams: ExplicitTransportParams | null;
  /** True for the real-network testrun.org path (accounts are precious/rude at scale). */
  isTestrun: boolean;
};

const TESTRUN_URL = 'https://nine.testrun.org';

/** Default host the podman harness publishes the relay's ports on. */
export const DEFAULT_LOCAL_HOST = '127.0.0.1';
/** Default published host port for the relay's HTTPS (`/new`, IMAPS-adjacent). */
export const DEFAULT_HTTPS_PORT = 8443;
export const DEFAULT_IMAPS_PORT = 9993;
export const DEFAULT_SMTPS_PORT = 9465;

const toPort = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const relayEnv = (env: Record<string, string | undefined>, name: string): string | undefined =>
  env[`HEADWATER_${name}`] ?? env[`DELTANET_${name}`];

/**
 * Resolve the relay config from an env-like record (defaults to `process.env`
 * shape). Recognized keys:
 *
 * - `HEADWATER_TEST_RELAY` — `testrun` selects the real-network path.
 * - `HEADWATER_TEST_RELAY_URL` — base URL for `POST /new` (local path).
 * - `HEADWATER_TEST_RELAY_HOST` — host the transport connects to (IMAP/SMTP);
 *   defaults to the host of `HEADWATER_TEST_RELAY_URL`, else `127.0.0.1`.
 * - `HEADWATER_TEST_RELAY_IMAPS_PORT` / `_SMTPS_PORT` / `_HTTPS_PORT` — ports.
 * Legacy `DELTANET_*` forms remain fallbacks for deployed test automation.
 */
export const resolveTestRelayConfig = (
  env: Record<string, string | undefined>,
): TestRelayConfig => {
  if (relayEnv(env, 'TEST_RELAY') === 'testrun') {
    return { relayUrl: TESTRUN_URL, transportParams: null, isTestrun: true };
  }

  const httpsPort = toPort(relayEnv(env, 'TEST_RELAY_HTTPS_PORT'), DEFAULT_HTTPS_PORT);
  const configuredRelayUrl = relayEnv(env, 'TEST_RELAY_URL');
  const relayUrl =
    configuredRelayUrl && configuredRelayUrl.trim() !== ''
      ? configuredRelayUrl
      : `https://${DEFAULT_LOCAL_HOST}:${httpsPort}`;

  let host = relayEnv(env, 'TEST_RELAY_HOST');
  if (!host || host.trim() === '') {
    try {
      host = new URL(relayUrl).hostname;
    } catch {
      host = DEFAULT_LOCAL_HOST;
    }
  }

  const imapPort = toPort(relayEnv(env, 'TEST_RELAY_IMAPS_PORT'), DEFAULT_IMAPS_PORT);
  const smtpPort = toPort(relayEnv(env, 'TEST_RELAY_SMTPS_PORT'), DEFAULT_SMTPS_PORT);

  return {
    relayUrl,
    transportParams: {
      imapHost: host,
      imapPort,
      smtpHost: host,
      smtpPort,
      acceptInvalidCerts: true,
    },
    isTestrun: false,
  };
};
