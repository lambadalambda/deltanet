import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveTestRelayConfig } from '../../src/testenv/relay-config.js';

/**
 * Vitest globalSetup for the integration suite.
 *
 * Default: bring up a fresh ephemeral podman chatmail relay via
 * `testenv/relay.sh up` before the suite, and tear it down after. The
 * script publishes the relay's ports to localhost and prints `export` lines
 * we parse into `process.env` so the tests (and `resolveTestRelayConfig`)
 * pick up the exact host/ports it published.
 *
 * Opt out with `HEADWATER_TEST_RELAY=testrun`: the suite then runs against the
 * real `nine.testrun.org` relay and this setup does nothing (no podman, no
 * container lifecycle), preserving the historical behavior.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RELAY_SH = resolve(here, '../../testenv/relay.sh');

const applyExports = (stdout: string): void => {
  for (const line of stdout.split('\n')) {
    const m = line.match(/^export\s+([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]!] = m[2]!;
  }
};

export default async function setup(): Promise<() => void> {
  const cfg = resolveTestRelayConfig(process.env);
  if (cfg.isTestrun) {
    console.log('[integration] HEADWATER_TEST_RELAY=testrun: using nine.testrun.org, no local relay');
    return () => {};
  }

  console.log('[integration] starting ephemeral podman chatmail relay (testenv/relay.sh up)...');
  const out = execFileSync('bash', [RELAY_SH, 'up'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  applyExports(out);
  console.log('[integration] local relay ready.');

  return () => {
    console.log('[integration] tearing down local relay (testenv/relay.sh down)...');
    try {
      execFileSync('bash', [RELAY_SH, 'down'], { stdio: 'inherit' });
    } catch (err) {
      console.error('[integration] relay teardown failed (non-fatal):', err);
    }
  };
}
