import { setImmediate } from 'node:timers/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

const mock = vi.hoisted(() => ({ createIndex: vi.fn(), close: vi.fn(), db: vi.fn() }));
vi.mock('mongoose', () => ({ default: { connection: {
  readyState: 1, name: 'isolated_sessions',
  getClient: () => ({ db: mock.db, close: mock.close }),
} } }));
import { SharedMongoStore } from '../src/session-store.js';

beforeEach(() => {
  vi.clearAllMocks();
  mock.db.mockReturnValue({ collection: () => ({ createIndex: mock.createIndex }) });
});
const config = { SESSION_TTL_SECONDS: 600 } as Config;

it('ready et close attendent le vrai collectionP, y compris la création TTL native', async () => {
  let resolve!: (name: string) => void;
  mock.createIndex.mockReturnValue(new Promise<string>(done => { resolve = done; }));
  const store = new SharedMongoStore(config);
  const ready = vi.fn();
  const closed = vi.fn();
  const waiting = store.ready().then(ready);
  const closing = store.close().then(closed);
  await setImmediate();
  expect(ready).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
  expect(mock.createIndex).toHaveBeenCalledWith({ expires: 1 }, { background: true, expireAfterSeconds: 0 });
  expect(mock.db).toHaveBeenCalledWith('isolated_sessions');
  resolve('expires_1');
  await Promise.all([waiting, closing, store.close()]);
  expect(mock.close).not.toHaveBeenCalled();
});

it('observe immédiatement une erreur TTL sans masquer le rejet de ready ni fermer le client partagé', async () => {
  const error = new Error('simulated TTL failure');
  mock.createIndex.mockRejectedValue(error);
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const store = new SharedMongoStore(config);
    // Deliberately let a turn pass before the owner awaits readiness.
    await setImmediate();
    expect(unhandled).not.toHaveBeenCalled();
    await expect(store.ready()).rejects.toBe(error);
    await Promise.all([store.close(), store.close()]);
    expect(mock.close).not.toHaveBeenCalled();
  } finally { process.removeListener('unhandledRejection', unhandled); }
});