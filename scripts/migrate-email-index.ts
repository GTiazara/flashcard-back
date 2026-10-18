import mongoose from 'mongoose';
import { migrateEmailIndex } from '../src/email-index.js';

// Pas de dotenv, pas d'import des modèles (évite toute création automatique d'index).
// L'opérateur fournit l'URI via son environnement, jamais en argument ni dans les logs.
try {
  if (!process.argv.includes('--maintenance-confirmed')) throw new Error('Maintenance non confirmée.');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Configuration absente.');
  await mongoose.connect(uri, { autoIndex: false, ...(process.env.MONGODB_DB?.trim() ? { dbName: process.env.MONGODB_DB.trim() } : {}) });
  await migrateEmailIndex(mongoose.connection.collection('users'), true);
  console.log('Migration email terminée, aucun document modifié.');
} catch {
  console.error('Migration refusée ou échouée. Garder l’API arrêtée ; inspecter les index et la sauvegarde avant de redémarrer. Aucun document supprimé par ce script.');
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }