import type { Server } from 'node:http';

interface SessionStore {
  ready(): Promise<void>;
  close(): Promise<void>;
}

/** One owner: HTTP drain, session initialization drain, then shared MongoDB. */
export class BackendLifecycle {
  private server?: Server;
  private store?: SessionStore;
  private closing?: Promise<void>;

  constructor(private readonly disconnect: () => Promise<void>) {}

  async listen(server: Server, store: SessionStore, port: number, onError: (error: unknown) => void): Promise<void> {
    this.server = server;
    this.store = store;
    await store.ready();
    if (this.closing) throw new Error('Démarrage annulé pendant l’arrêt.');
    await new Promise<void>((resolve, reject) => {
      let started = false;
      const listening = () => { started = true; resolve(); };
      // Install before listen(): neither synchronous throws nor EADDRINUSE can
      // reach a success callback or escape as an unhandled server error.
      const error = (cause: Error) => {
        if (started) onError(cause);
        else { server.removeListener('listening', listening); reject(cause); }
      };
      server.on('error', error);
      server.once('listening', listening);
      try { server.listen(port); }
      catch (cause) { server.removeListener('listening', listening); reject(cause); }
    });
  }

  shutdown(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try {
        if (this.server?.listening) {
          await new Promise<void>((resolve, reject) => {
            this.server!.close(error => error ? reject(error) : resolve());
          });
        }
      } catch (error) { errors.push(error); }
      try { await this.store?.close(); } catch (error) { errors.push(error); }
      try { await this.disconnect(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Échec du nettoyage du backend.');
    });
    return this.closing;
  }
}

export function listenErrorMessage(error: unknown, port: number): string {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
    return `Le port ${port} est déjà occupé. Arrêtez l’autre instance du backend ou choisissez un autre PORT, puis relancez.`;
  }
  return `Impossible d’écouter sur le port ${port}. Vérifiez le port configuré et les permissions réseau.`;
}