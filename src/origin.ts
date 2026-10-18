import type { Config } from './config.js';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isAllowedOrigin(origin: string | undefined, config: Pick<Config, 'NODE_ENV' | 'CORS_ORIGIN'>): boolean {
  // Non-browser clients may omit Origin; an explicit "null" is not an omission.
  if (origin === undefined) return true;
  if (origin === config.CORS_ORIGIN) return true;
  if (config.NODE_ENV !== 'development') return false;
  try {
    const configured = new URL(config.CORS_ORIGIN);
    const requested = new URL(origin);
    // Require a serialized HTTP(S) origin, not a URL with credentials/path or
    // a non-canonical spelling normalized by URL (e.g. an alternative IP form).
    return ['http:', 'https:'].includes(configured.protocol)
      && requested.origin === origin
      && loopbackHosts.has(configured.hostname)
      && loopbackHosts.has(requested.hostname)
      && requested.protocol === configured.protocol
      && requested.port === configured.port;
  } catch { return false; }
}