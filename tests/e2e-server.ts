import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { initializeIndexes } from '../src/models.js';
import { getMongo } from '../src/mongo.js';

// Deliberately no dotenv, process.env spread, or import of src/server.ts.
let mongo: MongoMemoryReplSet | undefined;
let store: ReturnType<typeof createApp>['store'] | undefined;
let server: Server | undefined;
let cleanup: Promise<void> | undefined;
function shutdown() {
  return cleanup ??= (async () => {
    server?.close();
    server?.closeIdleConnections();
    try {
      try { await store?.close(); }
      finally { await mongoose.disconnect(); }
    } finally { await mongo?.stop(); }
  })();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown().catch(() => { process.exitCode = 1; }); });
}

async function main() {
  mongo = await MongoMemoryReplSet.create({
    binary: { downloadDir: fileURLToPath(new URL('../node_modules/.cache/mongodb-memory-server/', import.meta.url)) },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const config = loadConfig({
    NODE_ENV: 'test', PORT: '3001', MONGODB_URI: mongo.getUri('flashcard_e2e'),
    SESSION_SECRET: 'qa-only-ephemeral-session-secret-not-for-production',
    CORS_ORIGIN: 'http://localhost:5174', FRONTEND_URL: 'http://localhost:5174',
    REQUIRE_EMAIL_VERIFICATION: 'false', AUTH_RATE_LIMIT: '1000',
  });
  await getMongo(config);
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName) throw new Error('Replica set requis.');
  await initializeIndexes();
  const service = createApp(config);
  store = service.store;
  // Test-only lifecycle routes, loopback binding, never part of the application.
  // Windows process-tree termination does not deliver SIGTERM: teardown awaits this cleanup.
  server = createServer((req, res) => {
    if (req.url === '/__qa/ready' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ service: 'flashcard-ephemeral-e2e', replicaSet: true }));
    } else if (req.url === '/__qa/shutdown' && req.method === 'POST' && req.headers.origin === config.CORS_ORIGIN) {
      void shutdown().then(() => { res.end('stopped'); }, () => {
        process.exitCode = 1; res.statusCode = 500; res.end('cleanup failed');
      });
    } else service.app(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(config.PORT, '127.0.0.1', resolve);
  });
  console.info('API E2E prête sur le port 3001 (replica set éphémère).');
}
main().catch(async () => {
  console.error('Démarrage API E2E impossible ; nettoyage des ressources temporaires.');
  process.exitCode = 1;
  await shutdown();
});