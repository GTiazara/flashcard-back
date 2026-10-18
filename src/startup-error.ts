/** Diagnostics fixes : ne jamais journaliser les messages MongoDB bruts (URI possible). */
export function startupErrorMessage(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const codes = new Set<unknown>();
  const names = new Set<unknown>();
  while (pending.length && seen.size < 50) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const entry = item as Record<string, unknown>;
    codes.add(entry.code);
    names.add(entry.name);
    names.add(entry.codeName);
    pending.push(entry.cause, entry.reason, entry.error);
    if (entry.servers instanceof Map) pending.push(...entry.servers.values());
  }
  if (codes.has('LEGACY_EMAIL_INDEX')) {
    return 'Connexion MongoDB réussie, mais ancien index email incompatible avec les profils invités. Arrêtez les écritures puis exécutez la migration email en maintenance décrite dans le README. Aucun utilisateur ni contenu ne doit être supprimé.';
  }
  if (codes.has(18) || names.has('AuthenticationFailed')) {
    return 'Authentification MongoDB refusée (code 18). Vérifiez le nom d’utilisateur, le mot de passe et authSource dans MONGODB_URI. Encodez les caractères spéciaux des identifiants en pourcentage. Ne partagez pas votre URI.';
  }
  if (codes.has(13) || names.has('Unauthorized')) {
    return 'Droits MongoDB insuffisants (code 13). Vérifiez les permissions du compte sur la base de l’application et la création des index.';
  }
  if (codes.has(59) || names.has('CommandNotFound')) {
    return 'Commande MongoDB indisponible (code 59 / CommandNotFound), y compris après le fallback hello vers isMaster si applicable. Vérifiez la version et la compatibilité du serveur ; une mise à niveau MongoDB est recommandée.';
  }
  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN') || codes.has('ECONNREFUSED') || codes.has('ETIMEOUT') || names.has('MongooseServerSelectionError')) {
    return 'Connexion MongoDB impossible. Vérifiez l’hôte, le port, le DNS, la disponibilité du serveur et, sur Atlas, la liste des adresses IP autorisées.';
  }
  if (codes.has(85) || codes.has(86) || codes.has(11000)) {
    return 'Initialisation des index MongoDB impossible : index incompatibles ou données en doublon. Vérifiez les index et les données existantes avant toute modification ; aucune suppression automatique n’est effectuée.';
  }
  return 'Démarrage impossible : vérifiez la connexion MongoDB et les index.';
}