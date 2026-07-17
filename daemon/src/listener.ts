import { isIP } from 'node:net';

export type ListenerConfig = {
  hostname: string;
  port: number;
};

type ListenerEnv = Record<string, string | undefined>;

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost' ||
  (isIP(hostname) === 6 && hostname === '::1') ||
  (isIP(hostname) === 4 && hostname.startsWith('127.'));

export const resolveListenerConfig = (env: ListenerEnv): ListenerConfig => {
  const hostname = (env['HEADWATER_HOSTNAME'] ?? env['DELTANET_HOSTNAME'])?.trim() || '127.0.0.1';
  const port = Number(env['PORT'] ?? 4030);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const allowNonLoopback = env['HEADWATER_ALLOW_NON_LOOPBACK'] ?? env['DELTANET_ALLOW_NON_LOOPBACK'];
  if (!isLoopbackHostname(hostname) && allowNonLoopback !== '1') {
    throw new Error('non-loopback listeners require HEADWATER_ALLOW_NON_LOOPBACK=1');
  }
  return { hostname, port };
};
