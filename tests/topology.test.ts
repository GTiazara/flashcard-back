import { describe, expect, it, vi } from 'vitest';
import { detectTransactions, standaloneWarning } from '../src/topology.js';
import { loadConfig } from '../src/config.js';

describe('topologie MongoDB et compatibilité commandes 4.4', () => {
  it.each([{ setName: 'rs0' }, { msg: 'isdbgrid' }])('active les transactions pour %j', async response => {
    const command = vi.fn().mockResolvedValue(response);
    expect(await detectTransactions({ command }, 'auto')).toBe(true);
    expect(await detectTransactions({ command }, 'required')).toBe(true);
    expect(command).toHaveBeenCalledWith({ hello: 1 });
  });

  it('accepte standalone en auto et le refuse en required', async () => {
    const command = vi.fn().mockResolvedValue({ isWritablePrimary: true });
    expect(await detectTransactions({ command }, 'auto')).toBe(false);
    await expect(detectTransactions({ command }, 'required')).rejects.toThrow('MONGODB_TRANSACTIONS=required');
    expect(command.mock.calls).toEqual([[{ hello: 1 }], [{ hello: 1 }]]);
  });

  it.each([{ code: 59 }, { codeName: 'CommandNotFound' }])('fallback hello → isMaster uniquement pour %j', async error => {
    const command = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ setName: 'rs44' });
    expect(await detectTransactions({ command }, 'required')).toBe(true);
    expect(command.mock.calls).toEqual([[{ hello: 1 }], [{ isMaster: 1 }]]);
  });

  it('détecte aussi standalone et mongos via isMaster', async () => {
    for (const [response, expected] of [[{}, false], [{ msg: 'isdbgrid' }, true]] as const) {
      const command = vi.fn().mockRejectedValueOnce({ code: 59 }).mockResolvedValueOnce(response);
      expect(await detectTransactions({ command }, 'auto')).toBe(expected);
    }
  });

  it.each([{ code: 18 }, { code: 13 }, { code: 'ECONNRESET' }, new Error('CommandNotFound'), { code: 42 }])(
    'propage sans fallback ni contournement %j', async error => {
      const command = vi.fn().mockRejectedValue(error);
      await expect(detectTransactions({ command }, 'auto')).rejects.toBe(error);
      expect(command).toHaveBeenCalledTimes(1);
    },
  );

  it('propage l’erreur du fallback sans autre tentative', async () => {
    const error = { code: 13 };
    const command = vi.fn().mockRejectedValueOnce({ code: 59 }).mockRejectedValueOnce(error);
    await expect(detectTransactions({ command }, 'auto')).rejects.toBe(error);
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('refuse aussi standalone 4.4 en required après le fallback', async () => {
    const command = vi.fn().mockRejectedValueOnce({ code: 59 }).mockResolvedValueOnce({ ismaster: true });
    await expect(detectTransactions({ command }, 'required')).rejects.toThrow('standalone refusé');
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('avertit fortement en production et valide le mode sans environnement utilisateur', () => {
    const env = { MONGODB_URI: 'mongodb://127.0.0.1:1/unused', SESSION_SECRET: 'x'.repeat(32) };
    expect(loadConfig(env).MONGODB_TRANSACTIONS).toBe('auto');
    expect(loadConfig({ ...env, MONGODB_TRANSACTIONS: 'required' }).MONGODB_TRANSACTIONS).toBe('required');
    for (const value of ['false', 'true', '', 'never']) {
      expect(() => loadConfig({ ...env, MONGODB_TRANSACTIONS: value })).toThrow('MONGODB_TRANSACTIONS');
    }
    expect(standaloneWarning(true)).toContain('ATTENTION PRODUCTION');
    expect(standaloneWarning(false)).toContain('sans transaction ni rollback');
  });
});