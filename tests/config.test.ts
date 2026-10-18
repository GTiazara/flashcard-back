import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const isolated = { NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1/uri_database', SESSION_SECRET: 'isolated-config-secret-at-least-32-characters' };

const production = {
  ...isolated, NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(48),
  FRONTEND_URL: 'https://app.example.com', CORS_ORIGIN: 'https://app.example.com',
};
describe('SMTP facultatif sans environnement utilisateur', () => {
  it('accepte production sans SMTP, confirmation désactivée par défaut ou explicitement', () => {
    expect(loadConfig(production)).toMatchObject({ SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: false });
    expect(loadConfig({ ...production, REQUIRE_EMAIL_VERIFICATION: 'false' }).SMTP_HOST).toBe('');
  });
  it('exige SMTP pour la confirmation en production', () => {
    expect(() => loadConfig({ ...production, REQUIRE_EMAIL_VERIFICATION: 'true' })).toThrow('SMTP_HOST est requis');
    expect(loadConfig({ ...production, REQUIRE_EMAIL_VERIFICATION: 'true', SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'mail@example.com' }).REQUIRE_EMAIL_VERIFICATION).toBe(true);
  });
  it.each(['development', 'test'])('autorise confirmation sans SMTP en %s', NODE_ENV => {
    expect(loadConfig({ ...isolated, NODE_ENV, REQUIRE_EMAIL_VERIFICATION: 'true' }).SMTP_HOST).toBe('');
  });
  it.each([
    { SMTP_USER: 'user' }, { SMTP_PASS: 'private-pass' }, { MAIL_FROM: 'mail@example.com' },
    { SMTP_USER: 'user', SMTP_PASS: 'private-pass' },
    { SMTP_HOST: 'smtp.example.com' }, { SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'invalid' },
    { SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'mail@example.com', SMTP_USER: 'user' },
    { SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'mail@example.com', SMTP_PASS: 'private-pass' },
  ])('refuse SMTP partiel %j', extra => {
    expect(() => loadConfig({ ...production, ...extra })).toThrow('Configuration invalide');
  });
  it('accepte relais sans authentification et identifiants complets', () => {
    const smtp = { ...production, SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'mail@example.com' };
    expect(loadConfig(smtp).SMTP_USER).toBe('');
    expect(loadConfig({ ...smtp, SMTP_USER: 'user', SMTP_PASS: 'private-pass' }).SMTP_USER).toBe('user');
  });
  it('conserve secret 48 caractères non factice et HTTPS obligatoires sans SMTP', () => {
    for (const SESSION_SECRET of ['a'.repeat(47), 'replace-' + 'a'.repeat(48)]) {
      expect(() => loadConfig({ ...production, SESSION_SECRET })).toThrow('SESSION_SECRET de production');
    }
    for (const key of ['FRONTEND_URL', 'CORS_ORIGIN']) {
      expect(() => loadConfig({ ...production, [key]: 'http://app.example.com' })).toThrow('HTTPS requis');
    }
  });
});

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