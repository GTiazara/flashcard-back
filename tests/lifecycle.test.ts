import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { BackendLifecycle, listenErrorMessage } from '../src/lifecycle.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const close = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
});

describe('cycle de vie isolé, sans MongoDB ni dotenv', () => {
  it('port occupé : aucun succès ni rejet non géré ; nettoyage unique, serveur existant intact', async () => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, resolve));
    const port = (occupied.address() as AddressInfo).port;
    const order: string[] = [];
    const store = { ready: vi.fn(async () => {}), close: vi.fn(async () => { order.push('store'); }) };
    const lifecycle = new BackendLifecycle(async () => { order.push('mongo'); });
    const attempted = createServer();
    const success = vi.fn();
    const runtimeError = vi.fn();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const start = lifecycle.listen(attempted, store, port, runtimeError).then(success);
      await expect(start).rejects.toMatchObject({ code: 'EADDRINUSE' });
      await lifecycle.shutdown();
      await lifecycle.shutdown();
      await setImmediate();
      expect(success).not.toHaveBeenCalled();
      expect(runtimeError).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      expect(order).toEqual(['store', 'mongo']);
      expect(occupied.listening).toBe(true);
      expect(attempted.listening).toBe(false);
      expect(store.close).toHaveBeenCalledTimes(1);
    } finally {
      process.removeListener('unhandledRejection', unhandled);
      await lifecycle.shutdown();
      await close(occupied);
    }
  });

  it('initialisation pending puis erreur : aucun listen et MongoDB fermé après le drain du store', async () => {
    const init = deferred();
    const order: string[] = [];
    const server = createServer();
    const listen = vi.spyOn(server, 'listen');
    const lifecycle = new BackendLifecycle(async () => { order.push('mongo'); });
    const store = {
      ready: () => init.promise,
      close: async () => { await init.promise.catch(() => undefined); order.push('store'); },
    };
    const start = lifecycle.listen(server, store, 0, vi.fn());
    const failed = expect(start).rejects.toThrow('TTL failure');
    const shutdown = lifecycle.shutdown();
    expect(lifecycle.shutdown()).toBe(shutdown);
    await setImmediate();
    expect(order).toEqual([]);
    init.reject(new Error('TTL failure'));
    await failed;
    await shutdown;
    expect(listen).not.toHaveBeenCalled();
    expect(order).toEqual(['store', 'mongo']);
  });

  it('annule un démarrage encore pending si un arrêt a été demandé', async () => {
    const init = deferred();
    const server = createServer();
    const lifecycle = new BackendLifecycle(async () => {});
    const start = lifecycle.listen(server, { ready: () => init.promise, close: () => init.promise }, 0, vi.fn());
    const failed = expect(start).rejects.toThrow('annulé');
    const shutdown = lifecycle.shutdown();
    init.resolve();
    await Promise.all([failed, shutdown]);
    expect(server.listening).toBe(false);
  });

  it('attend la fin des requêtes HTTP avant store puis MongoDB et partage les arrêts répétés', async () => {
    const order: string[] = [];
    const received = deferred();
    let finish!: () => void;
    const server = createServer((_req, res) => { finish = () => res.end('ok'); received.resolve(); });
    const lifecycle = new BackendLifecycle(async () => { order.push('mongo'); });
    const store = { ready: async () => {}, close: async () => { order.push('store'); } };
    await lifecycle.listen(server, store, 0, vi.fn());
    const response = new Promise<void>((resolve, reject) => {
      get({ hostname: '127.0.0.1', port: (server.address() as AddressInfo).port, agent: false }, res => {
        res.resume();
        res.on('end', resolve);
        res.on('error', reject);
      }).on('error', reject);
    });
    try {
      await received.promise;
      const shutdown = lifecycle.shutdown();
      expect(lifecycle.shutdown()).toBe(shutdown);
      await setImmediate();
      expect(order).toEqual([]);
      finish();
      await Promise.all([response, shutdown]);
      expect(order).toEqual(['store', 'mongo']);
      expect(server.listening).toBe(false);
    } finally { finish(); await lifecycle.shutdown(); }
  });

  it('nettoie MongoDB même si la fermeture du store échoue ; rejet stable et observé', async () => {
    const disconnect = vi.fn(async () => {});
    const lifecycle = new BackendLifecycle(disconnect);
    await lifecycle.listen(createServer(), {
      ready: async () => {}, close: async () => { throw new Error('private failure'); },
    }, 0, vi.fn());
    await expect(lifecycle.shutdown()).rejects.toThrow('Échec du nettoyage');
    await expect(lifecycle.shutdown()).rejects.toThrow('Échec du nettoyage');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('intercepte aussi un throw synchrone de listen', async () => {
    const server = createServer();
    vi.spyOn(server, 'listen').mockImplementation(() => { throw new Error('private network error'); });
    const disconnect = vi.fn(async () => {});
    const lifecycle = new BackendLifecycle(disconnect);
    await expect(lifecycle.listen(server, { ready: async () => {}, close: async () => {} }, 0, vi.fn())).rejects.toThrow('private network error');
    await lifecycle.shutdown();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('ne lie aucun port avant ready et conserve le gestionnaire des erreurs après écoute', async () => {
    const init = deferred();
    const server = createServer();
    const lifecycle = new BackendLifecycle(async () => {});
    const runtimeError = vi.fn();
    const start = lifecycle.listen(server, { ready: () => init.promise, close: async () => {} }, 0, runtimeError);
    await setImmediate();
    expect(server.listening).toBe(false);
    init.resolve();
    try {
      await start;
      const failure = new Error('simulated runtime error');
      server.emit('error', failure);
      expect(runtimeError).toHaveBeenCalledExactlyOnceWith(failure);
    } finally { await lifecycle.shutdown(); }
  });

  it('nettoie aussi après une erreur de close HTTP puis de déconnexion, sans répéter les opérations', async () => {
    const order: string[] = [];
    const server = createServer();
    const lifecycle = new BackendLifecycle(async () => { order.push('mongo'); throw new Error('disconnect failure'); });
    await lifecycle.listen(server, { ready: async () => {}, close: async () => { order.push('store'); } }, 0, vi.fn());
    const originalClose = server.close.bind(server);
    vi.spyOn(server, 'close').mockImplementation(callback => {
      order.push('http');
      return originalClose(() => callback?.(new Error('simulated close failure')));
    });
    await expect(lifecycle.shutdown()).rejects.toBeInstanceOf(AggregateError);
    await expect(lifecycle.shutdown()).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(['http', 'store', 'mongo']);
    expect(server.listening).toBe(false);
  });

  it('diagnostics de port fixes sans message brut ni secrets', () => {
    expect(listenErrorMessage({ code: 'EADDRINUSE', message: 'mongodb://secret' }, 3000)).toBe('Le port 3000 est déjà occupé. Arrêtez l’autre instance du backend ou choisissez un autre PORT, puis relancez.');
    expect(listenErrorMessage(new Error('mongodb://secret'), 3000)).toBe('Impossible d’écouter sur le port 3000. Vérifiez le port configuré et les permissions réseau.');
  });
});