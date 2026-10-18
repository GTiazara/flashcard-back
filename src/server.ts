import 'dotenv/config';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { loadConfig } from './config.js';
import { initializeIndexes } from './models.js';
import { createApp } from './app.js';
import { startupErrorMessage } from './startup-error.js';
import { detectTransactions, standaloneWarning } from './topology.js';
import { getMongo } from './mongo.js';
import { BackendLifecycle, listenErrorMessage } from './lifecycle.js';

const lifecycle = new BackendLifecycle(() => mongoose.disconnect());
let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    const timer = setTimeout(() => process.exit(1), 10000).unref();
    try { await lifecycle.shutdown(); }
    catch {
      console.error('Échec du nettoyage du backend.');
      process.exitCode = 1;
    } finally { clearTimeout(timer); }
  })();
  return shutdownPromise;
}

async function main() {
  const config = loadConfig();
  const { db } = await getMongo(config);
  const transactions = await detectTransactions(db.admin(), config.MONGODB_TRANSACTIONS);
  if (!transactions) console.warn(standaloneWarning(config.NODE_ENV === 'production'));
  await initializeIndexes();
  const { app, store } = createApp(config, { transactions });
  let ready = false;
  try {
    await lifecycle.listen(createServer(app), store, config.PORT, error => {
      console.error(listenErrorMessage(error, config.PORT));
      process.exitCode = 1;
      void shutdown();
    });
    ready = true;
  } catch (error) {
    // Readiness/index errors use MongoDB diagnostics, not port diagnostics.
    await store.ready().then(() => { ready = true; }, () => undefined);
    if (ready) {
      console.error(listenErrorMessage(error, config.PORT));
      process.exitCode = 1;
      await shutdown();
      return;
    }
    throw error;
  }
  console.info(`API flashcards démarrée sur le port ${config.PORT}.`);
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}
main().catch(async error => {
  console.error(error instanceof Error && (error.message.startsWith('Configuration invalide') || error.message.startsWith('MongoDB doit'))
    ? error.message : startupErrorMessage(error));
  process.exitCode = 1;
  await shutdown();
});