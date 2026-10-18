import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from '../src/origin.js';

const origins = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173'];

describe('isAllowedOrigin', () => {
  it.each(['development', 'test', 'production'] as const)('conserve origine exacte et absence en %s', NODE_ENV => {
    const config = { NODE_ENV, CORS_ORIGIN: origins[0]! };
    expect(isAllowedOrigin(config.CORS_ORIGIN, config)).toBe(true);
    expect(isAllowedOrigin(undefined, config)).toBe(true);
    expect(isAllowedOrigin('null', config)).toBe(false);
    expect(isAllowedOrigin('', config)).toBe(false);
  });

  it.each(origins)('accepte les équivalents loopback en développement depuis %s', CORS_ORIGIN => {
    for (const origin of origins) expect(isAllowedOrigin(origin, { NODE_ENV: 'development', CORS_ORIGIN })).toBe(true);
  });

  it.each(['test', 'production'] as const)('refuse les autres loopbacks en %s', NODE_ENV => {
    for (const CORS_ORIGIN of origins) {
      for (const origin of origins) expect(isAllowedOrigin(origin, { NODE_ENV, CORS_ORIGIN })).toBe(origin === CORS_ORIGIN);
    }
  });

  it.each([
    'https://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5174',
    'http://[::1]:5174', 'http://localhost', 'http://127.0.0.2:5173',
    'http://192.168.1.10:5173', 'http://0.0.0.0:5173', 'https://evil.example',
    'http://localhost.evil.example:5173', 'http://127.0.0.1.evil.example:5173',
    'http://localhost.:5173', 'http://localhost:5173/', 'http://127.0.0.1:5173/path',
    'http://user@localhost:5173', 'http://localhost:5173?query', 'http://localhost:5173#hash',
    'http://127.1:5173', 'http://2130706433:5173', 'http://0x7f000001:5173',
    'http://[::ffff:127.0.0.1]:5173', 'http://localhost:5173 https://evil.example',
    'null', '', 'not an origin', 'file://localhost',
  ])('refuse une origine différente ou malformée : %s', origin => {
    expect(isAllowedOrigin(origin, { NODE_ENV: 'development', CORS_ORIGIN: origins[0]! })).toBe(false);
  });

  it('ne généralise pas une origine configurée hors loopback', () => {
    for (const CORS_ORIGIN of ['http://app.example:5173', 'http://192.168.1.10:5173', 'http://127.0.0.2:5173']) {
      const config = { NODE_ENV: 'development' as const, CORS_ORIGIN };
      expect(isAllowedOrigin(CORS_ORIGIN, config)).toBe(true);
      for (const origin of origins) expect(isAllowedOrigin(origin, config)).toBe(false);
    }
  });

  it('compare protocole et port effectif, y compris HTTPS', () => {
    const config = { NODE_ENV: 'development' as const, CORS_ORIGIN: 'https://localhost' };
    expect(isAllowedOrigin('https://127.0.0.1', config)).toBe(true);
    expect(isAllowedOrigin('https://[::1]', config)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1', config)).toBe(false);
    expect(isAllowedOrigin('https://127.0.0.1:5173', config)).toBe(false);
  });
});