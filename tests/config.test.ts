import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const isolated = { NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1/uri_database', SESSION_SECRET: 'isolated-config-secret-at-least-32-characters' };

describe('MONGODB_DB sans environnement utilisateur', () => {
  it.each([undefined, '', '   ', '\t\n'])('traite %j comme absent', value => {
    expect(loadConfig({ ...isolated, MONGODB_DB: value }).MONGODB_DB).toBeUndefined();
  });
  it.each(['app', 'my_db-2026', 'é'.repeat(31) + 'a', 'a'.repeat(63)])('accepte un nom sûr %s', value => {
    expect(loadConfig({ ...isolated, MONGODB_DB: ` ${value} ` }).MONGODB_DB).toBe(value);
  });
  it.each(['/', '\\', '.', '$', '*', '?', '"', '<', '>', ':', '|', '\0', '\x01', '\x7f', ' ', '\t', '\n', '\ud800'])(
    'refuse le caractère %j sans exposer la valeur', character => {
      const value = `private${character}database`;
      expect(() => loadConfig({ ...isolated, MONGODB_DB: value })).toThrow('MONGODB_DB');
      try { loadConfig({ ...isolated, MONGODB_DB: value }); }
      catch (error) { expect((error as Error).message).not.toContain(value); }
    },
  );
  it.each(['a'.repeat(64), 'é'.repeat(32), '😀'.repeat(16)])('limite la longueur en octets UTF-8', value => {
    expect(() => loadConfig({ ...isolated, MONGODB_DB: value })).toThrow('63 octets UTF-8');
  });
  it('ne recopie pas une URI invalide dans les diagnostics de configuration', () => {
    expect(() => loadConfig({ ...isolated, MONGODB_URI: 'private-uri-with-password' })).toThrow('MONGODB_URI doit être une URI MongoDB.');
    try { loadConfig({ ...isolated, MONGODB_URI: 'private-uri-with-password' }); }
    catch (error) { expect((error as Error).message).not.toContain('private-uri-with-password'); }
  });
});