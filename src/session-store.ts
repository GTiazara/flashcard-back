import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import type { Config } from './config.js';

/** Mongoose owns the shared client. Native TTL creates no local cleanup timers. */
export class SharedMongoStore extends MongoStore {
  private readonly initialization: Promise<void>;

  constructor(config: Config) {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.name) {
      throw new Error('Connecter MongoDB avant de créer le stockage de session.');
    }
    // connect-mongo uses mongodb 6.21, Mongoose 8 uses 6.20. Their client API is
    // runtime-compatible; private driver types are nominally incompatible.
    type StoreClient = NonNullable<ConstructorParameters<typeof MongoStore>[0]['client']>;
    super({
      client: mongoose.connection.getClient() as unknown as StoreClient,
      dbName: mongoose.connection.name,
      collectionName: 'sessions', ttl: config.SESSION_TTL_SECONDS,
      autoRemove: 'native', touchAfter: 60,
    });
    // collectionP is public in connect-mongo 5 and includes setAutoRemove/TTL.
    // Observe immediately, even if the owner fails before calling ready().
    this.initialization = this.collectionP.then(() => undefined);
    void this.initialization.catch(() => undefined);
  }

  ready(): Promise<void> {
    return this.initialization;
  }

  override close(): Promise<void> {
    // Never call super.close(): that would disconnect every app using this client.
    // Drain TTL creation before the owner disconnects, including failed startup.
    return this.initialization.then(() => undefined, () => undefined);
  }
}