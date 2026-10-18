import type { Collection } from 'mongoose';

/** Maintenance explicite, tous les producteurs d'écritures doivent être arrêtés. Aucun document modifié. */
export async function migrateEmailIndex(collection: Collection, maintenance: boolean) {
  if (!maintenance) throw new Error('Migration refusée : confirmer la maintenance et arrêter tous les producteurs d’écritures.');
  const indexes = await collection.indexes();
  const emailIndexes = indexes.filter(index => Object.keys(index.key).length === 1 && index.key.email === 1);
  const legacy = emailIndexes.filter(index => index.unique && !index.partialFilterExpression);
  const partial = emailIndexes.find(index => index.unique && !index.sparse &&
    JSON.stringify(index.partialFilterExpression) === JSON.stringify({ email: { $type: 'string' } }));
  if (emailIndexes.some(index => !legacy.includes(index) && index !== partial)) {
    throw new Error('Index email non reconnu : inspection manuelle requise. Aucun index supprimé.');
  }
  const duplicates = await collection.aggregate([
    { $match: { email: { $type: 'string' } } }, { $group: { _id: '$email', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }, { $limit: 1 },
  ]).toArray();
  if (duplicates.length) throw new Error('Emails dupliqués : migration refusée sans modification.');
  const removed: typeof legacy = [];
  try {
    // MongoDB 4.4 peut refuser la coexistence des deux définitions sur la même clé.
    for (const index of legacy) {
      await collection.dropIndex(index.name!);
      removed.push(index);
    }
    if (!partial) await collection.createIndex({ email: 1 }, {
      name: 'email_string_unique', unique: true, partialFilterExpression: { email: { $type: 'string' } },
    });
  } catch {
    try {
      for (const index of removed) {
        await collection.createIndex({ email: 1 }, { name: index.name!, unique: true, ...(index.sparse ? { sparse: true } : {}),
          ...(index.collation ? { collation: index.collation } : {}) });
      }
    } catch { throw new Error('Migration échouée et restauration index impossible : garder l’API arrêtée et restaurer les index depuis la sauvegarde.'); }
    throw new Error('Migration échouée ; anciens index restaurés. Garder l’API arrêtée et inspecter les index.');
  }
}