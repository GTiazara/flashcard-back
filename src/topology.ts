import type { Config } from './config.js';

type Admin = { command(command: Record<string, number>): Promise<{ setName?: string; msg?: string }> };

/** MongoDB 4.4 ne connaît pas toujours hello. Aucun fallback sur erreur d'auth/réseau. */
export async function detectTransactions(admin: Admin, mode: Config['MONGODB_TRANSACTIONS']): Promise<boolean> {
  let topology;
  try {
    topology = await admin.command({ hello: 1 });
  } catch (error) {
    if (!error || typeof error !== 'object'
      || !(('code' in error && error.code === 59) || ('codeName' in error && error.codeName === 'CommandNotFound'))) throw error;
    topology = await admin.command({ isMaster: 1 });
  }
  const transactions = Boolean(topology.setName || topology.msg === 'isdbgrid');
  if (!transactions && mode === 'required') {
    throw new Error('MongoDB doit être un replica set ou mongos avec MONGODB_TRANSACTIONS=required ; standalone refusé.');
  }
  return transactions;
}

export function standaloneWarning(production: boolean): string {
  return `${production ? 'ATTENTION PRODUCTION : ' : 'ATTENTION : '}MongoDB standalone : mutations sérialisées dans ce processus uniquement, sans transaction ni rollback. Une seule instance API est autorisée ; lectures intermédiaires et écritures partielles possibles après erreur/crash. Utilisez un replica set et MONGODB_TRANSACTIONS=required pour exiger les transactions.`;
}