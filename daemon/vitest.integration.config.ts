import { defineConfig } from 'vitest/config';

/**
 * Integration-suite config. Runs only `tests/integration/**`, with a long
 * timeout (real SMTP/IMAP + securejoin), and a globalSetup that provisions a
 * fresh ephemeral podman chatmail relay for the run (skipped when
 * HEADWATER_TEST_RELAY=testrun; legacy DELTANET_TEST_RELAY is also accepted).
 *
 * Single-threaded: the tests share one local relay and register several
 * accounts each; running files in parallel would multiply concurrent
 * SMTP/IMAP load and securejoin handshakes against a single tmpfs-backed
 * relay for no real speedup (each test is dominated by store-and-forward
 * delivery latency, not CPU).
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    testTimeout: 300_000,
    hookTimeout: 320_000,
    fileParallelism: false,
  },
});
