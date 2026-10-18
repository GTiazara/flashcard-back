import { describe, expect, it } from 'vitest';
import { startupErrorMessage } from '../src/startup-error.js';

describe('diagnostics de démarrage sans secrets', () => {
  it('distingue la migration invités d’une erreur de connexion', () => {
    const result = startupErrorMessage({ code: 'LEGACY_EMAIL_INDEX', message: 'secret-value' });
    expect(result).toContain('Connexion MongoDB réussie');
    expect(result).toContain('migration email');
    expect(result).not.toContain('secret-value');
  });
  it('identifie un refus d’authentification sans exposer le message brut', () => {
    const result = startupErrorMessage({ code: 18, message: 'mongodb://private-user:private-password@private-host/db' });
    expect(result).toContain('code 18');
    expect(result).toContain('authSource');
    expect(result).not.toContain('private-');
  });

  it('identifie une cause imbriquée dans la sélection de serveur', () => {
    expect(startupErrorMessage({ name: 'MongooseServerSelectionError', reason: {
      servers: new Map([['redacted', { error: { cause: { code: 18 } } }]]),
    } })).toContain('code 18');
  });

  it.each([13, 59, 85, 86, 11000, 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEOUT'])(
    'fournit un diagnostic pour le code %s', code => {
      expect(startupErrorMessage({ code })).not.toBe('Démarrage impossible : vérifiez la connexion MongoDB et les index.');
    },
  );

  it('gère les erreurs inconnues et les références cycliques sans fuite', () => {
    const error: Record<string, unknown> = { message: 'secret-value' };
    error.cause = error;
    expect(startupErrorMessage(error)).toBe('Démarrage impossible : vérifiez la connexion MongoDB et les index.');
    expect(startupErrorMessage(null)).not.toContain('secret-value');
  });

  it('diagnostique CommandNotFound sans recopier le message', () => {
    const result = startupErrorMessage({ codeName: 'CommandNotFound', message: 'private-value' });
    expect(result).toContain('isMaster');
    expect(result).not.toContain('private-value');
  });
});