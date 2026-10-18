import mongoose from 'mongoose';
import type { Config } from './config.js';

type MongoConfig = Pick<Config, 'MONGODB_URI' | 'MONGODB_DB'>;
export type Mongo = { connection: mongoose.Connection; db: NonNullable<mongoose.Connection['db']> };
type Cached = { uri: string; dbName: string | undefined; promise: Promise<Mongo>; connected: boolean };
let cached: Cached | undefined;

/** One pending connection and one shared client/database; never retarget an active connection. */
export function getMongo(config: MongoConfig): Promise<Mongo> {
  const { MONGODB_URI: uri, MONGODB_DB: dbName } = config;
  if (cached?.connected && mongoose.connection.readyState === 0) cached = undefined;
  if (cached) {
    if (cached.uri !== uri || cached.dbName !== dbName) {
      return Promise.reject(new Error('Connexion MongoDB déjà initialisée avec une autre configuration.'));
    }
    if (mongoose.connection.readyState === 3) return Promise.reject(new Error('Fermeture MongoDB en cours.'));
    return cached.promise;
  }
  if (mongoose.connection.readyState !== 0) {
    return Promise.reject(new Error('Connexion MongoDB déjà initialisée hors du gestionnaire partagé.'));
  }
  const entry: Cached = {
    uri, dbName, connected: false,
    promise: Promise.resolve().then(async () => {
      await mongoose.connect(uri, {
        maxPoolSize: 10, serverSelectionTimeoutMS: 10000,
        ...(dbName === undefined ? {} : { dbName }),
      });
      const connection = mongoose.connection;
      if (!connection.db) throw new Error('Connexion MongoDB indisponible.');
      entry.connected = true;
      return { connection, db: connection.db };
    }).catch((error: unknown) => {
      if (cached === entry) cached = undefined;
      throw error;
    }),
  };
  cached = entry;
  return entry.promise;
}