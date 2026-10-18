import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ connect: vi.fn(), connection: { readyState: 0, db: {} } }));
vi.mock('mongoose', () => ({ default: mock }));
const config = { MONGODB_URI: 'mongodb://fake-user:fake-password@unused.invalid/uri_a', MONGODB_DB: undefined };

beforeEach(() => {
  vi.resetModules();
  mock.connection.readyState = 0;
  mock.connect.mockReset().mockImplementation(async () => { mock.connection.readyState = 1; });
});

describe('getMongo sans réseau ni dotenv', () => {
  it('partage exactement la promesse pending, le client et la base', async () => {
    const { getMongo } = await import('../src/mongo.js');
    let release!: () => void;
    mock.connect.mockImplementation(() => new Promise<void>(resolve => { release = () => { mock.connection.readyState = 1; resolve(); }; }));
    const first = getMongo(config);
    expect(getMongo(config)).toBe(first);
    await Promise.resolve();
    expect(mock.connect).toHaveBeenCalledExactlyOnceWith(config.MONGODB_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 10000 });
    release();
    expect(await first).toEqual({ connection: mock.connection, db: mock.connection.db });
    expect(getMongo(config)).toBe(first);
  });
  it('réinitialise le cache après erreur et permet une nouvelle tentative explicite', async () => {
    const { getMongo } = await import('../src/mongo.js');
    mock.connect.mockRejectedValueOnce(new Error('simulated failure'));
    const first = getMongo(config);
    expect(getMongo(config)).toBe(first);
    await expect(first).rejects.toThrow('simulated failure');
    const retry = getMongo(config);
    expect(retry).not.toBe(first);
    await retry;
    expect(mock.connect).toHaveBeenCalledTimes(2);
  });
  it('refuse URI/base différentes pending ou connectées sans exposer les valeurs', async () => {
    const { getMongo } = await import('../src/mongo.js');
    const first = getMongo(config);
    for (const changed of [{ ...config, MONGODB_URI: 'mongodb://other-secret@unused.invalid/db' }, { ...config, MONGODB_DB: 'other_private_db' }]) {
      for (const pending of [true, false]) {
        if (!pending) await first;
        await expect(getMongo(changed)).rejects.toThrow(/^Connexion MongoDB déjà initialisée avec une autre configuration\.$/);
      }
    }
    expect(mock.connect).toHaveBeenCalledTimes(1);
  });
  it('passe dbName seulement si explicitement défini et reconnecte après fermeture', async () => {
    const { getMongo } = await import('../src/mongo.js');
    await getMongo(config);
    mock.connection.readyState = 0;
    await getMongo({ ...config, MONGODB_DB: 'explicit_b' });
    expect(mock.connect).toHaveBeenLastCalledWith(config.MONGODB_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 10000, dbName: 'explicit_b' });
  });
  it.each([1, 2, 3])('refuse une connexion externe dans l’état %s', async state => {
    const { getMongo } = await import('../src/mongo.js');
    mock.connection.readyState = state;
    await expect(getMongo(config)).rejects.toThrow('hors du gestionnaire partagé');
    expect(mock.connect).not.toHaveBeenCalled();
  });
  it('refuse une demande pendant la fermeture sans ouvrir un second client', async () => {
    const { getMongo } = await import('../src/mongo.js');
    await getMongo(config);
    mock.connection.readyState = 3;
    await expect(getMongo(config)).rejects.toThrow('Fermeture MongoDB en cours.');
    expect(mock.connect).toHaveBeenCalledTimes(1);
  });
});