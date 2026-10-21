# Backend Flashcards — MVP

API française Node.js 24 / TypeScript strict / Express 5 / MongoDB-Mongoose. Aucun fichier du frontend ou de la racine du workspace n'est nécessaire.

## Installation et démarrage

### Docker Compose et Traefik (production)

Le [Dockerfile](Dockerfile) compile TypeScript dans une étape séparée puis exécute uniquement le JavaScript et les dépendances de production avec Node.js 24 et l'utilisateur non-root `node`. Aucun fichier d'environnement, test ou secret n'est copié dans l'image. Le [docker-compose.yml](docker-compose.yml) expose le port 3000 uniquement aux réseaux Docker, sans publication sur l'hôte, et rejoint le réseau Traefik externe `proxy`.

1. Copier [.env.production.example](.env.production.example) vers `.env.production` sur le serveur et renseigner les valeurs réelles. Ce fichier est ignoré par Git et exclu de l'image.
2. Renseigner `MONGODB_URI`, un `SESSION_SECRET` aléatoire d'au moins 48 caractères et les origines HTTPS `FRONTEND_URL`/`CORS_ORIGIN`. SMTP est facultatif avec `REQUIRE_EMAIL_VERIFICATION=false` : inscription, connexion et profils invités fonctionnent sans SMTP, mais la récupération de mot de passe est indisponible (503). Laisser `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` et `MAIL_FROM` vides pour ce mode. Avec `REQUIRE_EMAIL_VERIFICATION=true`, SMTP est obligatoire en production et son absence empêche le démarrage. Avec SMTP, renseigner `SMTP_HOST` et un `MAIL_FROM` valide ; `SMTP_SECURE=false` avec port 587 utilise STARTTLS, exigé en production ; `true` correspond au TLS direct, souvent port 465.
3. Vérifier que Traefik rejoint déjà le réseau externe `proxy`, avec les entrypoints `web` et `websecure`. Le DNS de `BACKEND_HOST` doit pointer sur ce serveur. Le réseau et MongoDB existants ne sont pas créés ni modifiés par ce Compose.
4. Si Traefik gère les certificats avec un resolver `le`, décommenter son label ; sinon fournir un certificat via la configuration TLS existante de Traefik. `tls=true` seul ne crée pas de certificat valide.
5. Valider avec `docker compose --env-file .env.production config --quiet`, puis lancer `docker compose --env-file .env.production up -d --build`. Toujours fournir `--env-file .env.production` pour ne pas charger par erreur le fichier local de développement. Les variables déjà exportées dans le shell peuvent remplacer celles du fichier : les vérifier avant déploiement.
6. Consulter `docker compose --env-file .env.production ps` et `docker compose --env-file .env.production logs --tail=100 flashcard-back`. Vérifier ensuite **https://flashcardback.skippylab.com/api/health** et **https://flashcardback.skippylab.com/api/ready** (adapter si `BACKEND_HOST` change).

Le healthcheck utilise `/api/ready` pour tenir compte de MongoDB. Docker marque un conteneur non prêt comme `unhealthy` ; `restart: unless-stopped` ne le redémarre pas à lui seul tant que le processus continue à fonctionner. L'image utilise un système de fichiers en lecture seule, `/tmp` en mémoire, aucune capability et `no-new-privileges`. Le délai d'arrêt de 15 secondes laisse passer le nettoyage applicatif borné à 10 secondes.

Validation locale de cette livraison : configuration Compose validée avec des valeurs fictives, compilation TypeScript réussie. Le daemon Docker local étant arrêté, le build de l'image et le démarrage conteneurisé n'ont pas été exécutés. Le scanner de l'éditeur signale actuellement cinq vulnérabilités de sévérité haute sur l'image de base `node:24-alpine` ; auditer l'image réellement construite et utiliser une révision corrigée avant exposition en production. Ne pas considérer la validation de syntaxe comme une certification de sécurité de l'image.

**MongoDB :** utiliser une adresse joignable depuis le conteneur, pas `localhost` (qui désigne le backend lui-même). Le nom DNS `mongodb` nécessite de rejoindre le réseau Docker où MongoDB est attaché ; sinon utiliser son adresse LAN/port réellement publiés. Conserver `authSource` cohérent avec la base d'authentification. Le réseau MongoDB dédié peut être ajouté au service et déclaré externe si nécessaire ; ne jamais publier les identifiants dans les labels Traefik. Le Compose n'ajoute pas de seconde instance MongoDB et ne modifie aucun volume existant.

**Origines et cookies :** `CORS_ORIGIN` désigne le frontend, pas l'API. Pour conserver les sessions, privilégier un domaine personnalisé Pages tel que `https://flashcard.skippylab.com` et le backend `https://flashcardback.skippylab.com`. Un frontend sur `https://gtiazara.github.io` reste cross-site avec cette API et les cookies `SameSite=Lax` actuels. Ne pas désactiver les protections CORS/CSRF pour contourner cette limite. La valeur frontend à compiler est `VITE_API_BASE_URL=https://flashcardback.skippylab.com/api`.

**Proxy :** `TRUST_PROXY=1` suppose que Traefik est le relais directement devant l'API, sans accès direct au port par un client non fiable ; adapter cette valeur à la topologie réelle. Les variables SvelteKit `ORIGIN`, `HOST_HEADER`, `PROTOCOL_HEADER`, `ADMIN_SECRET` et `BODY_SIZE_LIMIT` de geopinpoint ne sont pas des paramètres de cette API Express et ne sont donc pas reprises. Le backend écoute déjà sur toutes les interfaces ; `HOST` n'est pas nécessaire.

**Maintenance :** un ancien index email doit être migré avant le démarrage des profils invités, selon la procédure ci-dessous. L'image de production ne contient pas `tsx` ni les scripts de maintenance : exécuter la migration depuis une copie de travail avec ses dépendances de développement, API arrêtée, pas en contournant l'erreur ou en supprimant les utilisateurs. Sur standalone, garder une seule instance backend ; préférer `MONGODB_TRANSACTIONS=required` avec replica set pour exiger l'atomicité. Le contenu d'exemple `npm run seed:mnemo` s'exécute de la même façon depuis une copie de travail (voir [Compte et paquets d'exemple](#compte-et-paquets-dexemple-seedmnemo)).

### Démarrage sans Docker

1. Installer les dépendances avec `npm install` depuis ce dossier.
2. Renseigner `.env` (déjà fourni, ignoré par Git), en se basant sur `.env.example`.
3. Définir `MONGODB_URI` et remplacer `SESSION_SECRET` par une valeur aléatoire. Une URI vide empêche le démarrage avec un message explicite. Ne jamais publier ce fichier ni ses valeurs.
4. Exécuter `npm run dev` pour le développement, ou `npm run build` puis `npm start` pour le JavaScript compilé.
5. Exécuter `npm test` pour les tests d'intégration. Ils ne lisent pas `.env` et n'utilisent jamais la base de travail.
6. Facultatif : exécuter `npm run seed:mnemo` pour ajouter le compte `mnemo` et ses paquets publics d'exemple (voir ci-dessous).

### Compte et paquets d'exemple (`seed:mnemo`)

Tant que l'application compte peu d'utilisateurs, le fil public serait vide. Le script [scripts/seed-mnemo.ts](scripts/seed-mnemo.ts) le peuple avec des contenus d'exemple :

```bash
npm run seed:mnemo
```

1. **Compte** : crée l'utilisateur permanent `mnemo` (nom affiché « Mnemo », email confirmé) s'il n'existe pas. S'il existe déjà, il est réutilisé sans modification. Le script s'arrête sans rien écrire si `mnemo` est un profil invité ou si l'email choisi appartient déjà à un autre compte.
2. **Paquets** : 8 paquets publics de culture générale, 8 cartes question / réponse chacun (géographie, histoire, sciences, arts, littérature, cinéma, musique, sport), plus le paquet « Culture g : en images » (une trentaine de cartes : texte, image HTTP(S), ou les deux sur chaque face). Matière affichée : « Culture générale ». Chacun est créé privé, rempli, puis publié avec sa publication : il apparaît dans le fil, la recherche et le profil `/profiles/mnemo`. Les images d'exemple viennent de Wikimedia Commons.
3. **Seuil** : dès que la base compte au moins `MNEMO_MIN_USERS` comptes permanents hors `mnemo` (les invités ne comptent pas), aucun paquet n'est ajouté. Les exemples de culture générale déjà présents restent : les retirer depuis le compte `mnemo` si nécessaire. L'ancien catalogue scolaire, encore intact (description d'exemple d'origine), est retiré avant d'ajouter la culture générale.

Le script est idempotent : un paquet est retrouvé par son titre chez `mnemo`. S'il correspond encore au catalogue, ses cartes manquantes sont ajoutées et il est republié ; s'il a été modifié (description ou cartes), il est laissé tel quel. Les écritures passent par le même exécuteur que l'API (transactions en replica set, file sérialisée en standalone).

| Variable | Rôle |
| --- | --- |
| `MNEMO_EMAIL` | Email du compte, défaut `mnemo@example.invalid` (adresse non routable : la récupération de mot de passe ne fonctionnera pas) |
| `MNEMO_PASSWORD` | Utilisé seulement à la création ; 12 caractères à 72 octets UTF-8. Absent : mot de passe aléatoire **affiché une seule fois** dans la console |
| `MNEMO_MIN_USERS` | Entier de 1 à 100000, défaut `5` |

Le script charge `.env` via dotenv sans écraser les variables déjà exportées et utilise aussi `MONGODB_URI`, `MONGODB_DB` et `MONGODB_TRANSACTIONS`. Ces variables `MNEMO_*` ne sont jamais lues par l'API. Conserver le mot de passe généré dans un gestionnaire de secrets ; ne pas le copier dans un ticket. Pour le changer ensuite, se connecter au compte `mnemo`, ou supprimer ce compte puis relancer le script.

**Production :** l'image ne contient ni `tsx` ni les scripts. Lancer le seed depuis une copie de travail ayant ses dépendances de développement, avec `MONGODB_URI`/`MONGODB_DB` de production exportés dans le shell (le script ne lit pas `.env.production`). L'API peut rester démarrée ; en standalone, la file de sérialisation est propre au processus du script et ne protège donc pas des écritures concurrentes de l'API : préférer un moment de faible trafic.

### Port occupé et arrêt du backend

Un seul backend peut écouter sur un même `PORT`. Un second `npm run dev`/`npm start` échoue avec **« Le port 3000 est déjà occupé »** (ou le port configuré), sans message de démarrage réussi et avec un code de sortie non nul. Arrêter l'instance en double depuis son terminal, ou choisir explicitement un autre `PORT` et adapter le client. Aucun processus existant n'est arrêté automatiquement ; ne pas changer les identifiants MongoDB pour résoudre cette erreur.

Avant l'écoute HTTP, le serveur attend les index applicatifs **et `SharedMongoStore.ready()`**, qui inclut la collection de sessions et son index TTL natif. Toute erreur d'initialisation est observée immédiatement, puis signalée sans URI ni message brut. Même après un démarrage interrompu, le nettoyage attend cette initialisation avant de déconnecter le client partagé : pas de fermeture Mongoose pendant la création TTL.

Sur SIGINT/SIGTERM, l'arrêt idempotent termine d'abord les requêtes HTTP, attend `store.close()` (drain uniquement, jamais fermeture du client partagé), puis appelle `mongoose.disconnect()`. Les erreurs de démarrage, d'écoute et de nettoyage gardent un code de sortie non nul. Un délai maximal de 10 secondes force une sortie en échec si l'arrêt reste bloqué ; aucun gestionnaire global ne masque les exceptions ou rejets non gérés.

### URLs dans le navigateur

- API : **http://localhost:3000/** renvoie seulement `{ "name": "Mnemo API", "status": "ok", "health": "/api/health", "ready": "/api/ready" }`, sans configuration.
- Santé : **http://localhost:3000/api/health** ; disponibilité MongoDB : **http://localhost:3000/api/ready** (503 si déconnectée).
- Interface : **http://localhost:5173/login** et **http://localhost:5173/register**, lorsque le frontend est démarré séparément.

Le backend ne sert pas de page de connexion et ne fournit aucun accès navigateur à MongoDB. Les comptes du site sont distincts des identifiants MongoDB.

### Origines locales et erreur « Origine non autorisée »

URL canonique du frontend : **http://localhost:5173**. Avec `NODE_ENV=development` **et une `CORS_ORIGIN` dont l’hôte est loopback**, le backend accepte aussi ses équivalents `localhost`, `127.0.0.1` et `[::1]`, exclusivement avec le **même protocole et le même port**. Ainsi `CORS_ORIGIN=http://localhost:5173` accepte `http://127.0.0.1:5173`, mais pas HTTPS, le port 5174, une autre IP, un hôte ressemblant à localhost ni `Origin: null`. Une origine configurée non loopback n’ouvre aucune exception. En `test` et `production`, la correspondance reste exacte.

La garde HTTP et le callback CORS utilisent le même prédicat ; CORS renvoie l’origine réellement demandée et autorisée avec credentials, jamais un joker ni une autre origine. Les requêtes sans `Origin` restent autorisées sans header CORS d’origine inventé. Aucun proxy ne doit réécrire `Origin` pour contourner le contrôle. Les cookies ne sont pas partagés entre localhost et 127.0.0.1 : garder la même URL de navigateur pour conserver sa session.

Vite écoute sur 127.0.0.1, port 5173, avec `strictPort: true` : un port occupé provoque un échec explicite, pas un basculement silencieux sur 5174 refusé par l’API. Les ports explicites des tests E2E restent possibles. Après modification de configuration, redémarrer le backend puis recharger le frontend ; ne pas élargir CORS pour masquer un conflit de ports.

### Base et client MongoDB partagés

`MONGODB_DB` est **facultatif** : absent, vide ou composé uniquement d'espaces, il conserve la sélection de base existante de `MONGODB_URI`. Aucun nom de base de test ni autre base n'est substitué par l'application. S'il est renseigné, il est trimé et transmis comme `dbName` : il remplace **explicitement** la base de l'URI pour les données **et les sessions**. Exemple conceptuel : une URI visant `base_a` et `MONGODB_DB=base_b` utilisent `base_b` pour les deux. Le nom doit tenir dans 63 octets UTF-8, sans espaces, contrôles, caractères de substitution Unicode isolés ni caractères réservés `/ \\ . $ * ? " < > : |`.

La base applicative ne définit pas la base d'authentification du compte MongoDB : `authSource` reste une option distincte de l'URI, à régler selon l'endroit où ce compte a été créé. Définir `MONGODB_DB` ne réécrit ni l'URI ni ses options d'authentification.

`getMongo(config)` partage une seule promesse de connexion en cours puis retourne `{ connection, db }`. Le pool Mongoose est limité à 10 connexions, avec un délai de sélection du serveur de 10 secondes. Une erreur libère le cache pour une tentative explicite ultérieure ; aucun retry applicatif ni fallback JSON silencieux. Une URI ou un `MONGODB_DB` différent est refusé tant que la connexion partagée est en cours ou active, sans exposer leurs valeurs. Une connexion externe active est également refusée ; après déconnexion complète, une nouvelle initialisation explicite est possible. Redémarrer le service pour changer la base en exploitation.

Le store utilise **le client de `mongoose.connection.getClient()`** et **`mongoose.connection.name`** comme `dbName`, y compris lorsque la base URI diffère de l'override. `SharedMongoStore.close()` ne ferme pas ce client : l'expiration TTL native ne crée aucun timer de nettoyage local. Plusieurs applications/stores peuvent donc partager la connexion et fermer un store sans interrompre les sessions des autres. **Seul le propriétaire du cycle de vie, le serveur via `mongoose.disconnect()`, ferme le client** après l'arrêt HTTP ; les applications embarquées doivent assurer ce même nettoyage final. Les pilotes installés de Mongoose/connect-mongo (6.20/6.21) ont des types privés distincts : l'adaptation de type est limitée à ce passage du client, sans nouveau pilote ni seconde connexion.

Validation du 18 octobre 2026 après partage du client : build backend réussi, **7 fichiers / 127 tests réussis et 6 ignorés** (cas standalone ignorés uniquement dans le passage replica set). Les tests ajoutés couvrent la validation UTF-8, la promesse concurrente unique, la reprise après erreur, le refus de reconfiguration sans secrets, la conservation de la base URI et l'override réel A → B pour données et sessions. Fermer deux fois un store ne ferme pas le client et les sessions d'une autre app restent utilisables ; la déconnexion finale Mongoose ferme le client une seule fois. Non-régression frontend sans modification de son code : build en mode integration sans dotenv, **32 tests unitaires et 1 parcours navigateur réel réussis**, nettoyage des stores/Mongoose/replica set confirmé, ports QA libérés.

### MongoDB : détection automatique, standalone et transactions

`MONGODB_TRANSACTIONS=auto` (défaut) détecte la topologie au démarrage :

- **Replica set** (`setName`) ou **mongos** (`msg=isdbgrid`) : transactions Mongoose avec propagation de session par AsyncLocalStorage. Un replica set local à un membre suffit ; Atlas convient également.
- **Standalone** : accepté avec avertissement explicite, sans transaction. Les mutations métier du routeur sont sérialisées FIFO par connexion Mongoose et par processus, y compris si plusieurs applications partagent cette connexion. Aucun échec ne relance automatiquement la fonction métier ; aucune compensation ni simulation de rollback.
- `MONGODB_TRANSACTIONS=required` : refuse standalone avant l'initialisation des index et l'écoute HTTP. **Recommandé en production**. En `auto`, standalone reste accepté en production mais affiche un avertissement renforcé ; cela ne le rend pas adapté à un déploiement multi-instance.

La sonde utilise `hello`, avec repli sur `isMaster` **uniquement** pour le code 59 ou `codeName=CommandNotFound`. Les erreurs d'authentification, de droits ou de réseau sont propagées sans repli ni changement de mode. Il n'existe aucun basculement vers standalone après l'échec d'une transaction. Le compte DB doit disposer des droits applicatifs, de création des collections/index et, en mode transactionnel, des transactions. Aucun contrôle d'authentification, de propriété, de validation ou index unique n'est contourné. Les index sont initialisés avant l'écoute HTTP ; aucun index existant n'est supprimé automatiquement.

**Limites standalone : une seule instance API, un seul processus et une seule connexion métier partagée pour la base.** Pas de cluster Node, workers API, connexions indépendantes vers la même base ou autres producteurs d'écritures. La file n'est ni un verrou distribué ni durable. Les lectures ne passent pas dans cette file : elles peuvent observer des états intermédiaires, et une lecture déjà commencée peut conserver un ancien état de visibilité. Une erreur/crash peut laisser des écritures partielles persistantes et des relations à nettoyer ; une réponse 500 ne signifie pas « aucune écriture ». Les sessions/auth ont leur fonctionnement propre et ne constituent pas une transaction avec les mutations métier. Utiliser un replica set pour les garanties atomiques et la concurrence multi-instance.

L'ordre des écritures réduit l'exposition sans garantir l'isolation :

- publication : vérifier les cartes avant écriture, créer la publication, puis enregistrer la visibilité publique en dernier ;
- dépublication : enregistrer private/unlisted avant de nettoyer publication, likes et sauvegardes ;
- suppression de decks : rendre d'abord les decks privés, puis nettoyer les enfants/relations et supprimer les decks ;
- suppression de la dernière carte publique : rendre le deck privé avant de supprimer la carte, puis nettoyer les relations ;
- cascades cours/chapitres : supprimer les parents après les enfants afin de pouvoir réessayer le nettoyage depuis un parent encore présent.

Les requêtes invalides sont contrôlées avant les écritures métier. Cela n'est pas un rollback en standalone. Après un échec partiel, inspecter l'état avant de réessayer : une dépublication peut être réappliquée par PATCH private/unlisted ; une cascade dont le parent existe peut être relancée. Si la dernière carte a déjà été supprimée mais que son nettoyage a échoué, la suppression de cette carte retournera 404 ; un PATCH private du deck permet de relancer le nettoyage. Une publication créée avant un échec d'enregistrement du deck peut rester non visible. Ces cas ne sont ni réparés automatiquement ni couverts par une garantie d'atomicité.

### Compatibilité MongoDB 4.4 et tests isolés

Le repli de commande `hello` → `isMaster` permet de détecter les serveurs MongoDB 4.4 où `hello` est absent. Les opérations utilisées restent compatibles avec MongoDB 4.4 et le pilote de Mongoose 8, en standalone ou replica set selon le mode choisi. **MongoDB 4.4 est en fin de vie (EOL)** : une mise à niveau vers une version maintenue est fortement recommandée pour la sécurité et le support. Aucun Docker ou serveur distant n'est modifié par ce projet.

`npm test` utilise exclusivement `mongodb-memory-server` : toute la suite HTTP est exécutée sur un replica set éphémère puis sur un **vrai standalone éphémère**. La version de binaire par défaut fournie par la dépendance est une **7.x compatible Windows moderne** ; aucune version 4.4 n'est forcée. La compatibilité des commandes 4.4 est couverte par des mocks (code 59/CommandNotFound, `isMaster`, erreurs d'auth/droits/réseau), pas par un binaire 4.4 exécuté sous Windows. Cela ne constitue pas une certification runtime complète de MongoDB 4.4 ni un test réel de mongos.

Les tests HTTP couvrent auth/sessions, droits propriétaires, CRUD cours/chapitres/decks/cartes, ordre, publication, social, révision, dernière carte, cascades et concurrence. Les tests standalone supplémentaires couvrent plusieurs applications sur la même connexion et des pannes injectées pour vérifier les états partiels et l'ordre de retrait de visibilité. Les requêtes malformées/invalides sont vérifiées sans écriture métier ; aucun rollback standalone n'est revendiqué. Les tests unitaires vérifient aussi FIFO, libération de file après erreur, absence de retry et isolation des connexions/exécuteurs.

Le premier lancement télécharge un binaire MongoDB : un accès réseau et une machine autorisant son exécution sont nécessaires. Aucun fichier d'environnement utilisateur n'est lu, aucune base utilisateur n'est utilisée. Stores, connexions et processus MongoDB temporaires sont fermés en fin de suite, sans serveur permanent.

Validation standalone/compatibilité du 18 octobre 2026 : `npm run build` réussi ; `npm test` : **4 fichiers, 86 tests réussis et 6 ignorés**. Les 6 ignorés sont les scénarios de panne/sérialisation spécifiques au standalone lorsqu'ils sont rencontrés dans le passage replica set ; ils sont exécutés et réussissent dans le passage standalone. Aucun test réel MongoDB 4.4 ou mongos n'a été exécuté.

### Dépannage de la connexion

Le démarrage fournit des diagnostics fixes sans afficher l’URI ni les messages bruts susceptibles de contenir des identifiants.

- **Code 18 / AuthenticationFailed** : le serveur répond, mais refuse l’authentification. Vérifier le compte MongoDB (pas le compte de connexion au site Atlas), son mot de passe et sa base d’authentification `authSource`. La base de données applicative et la base où le compte a été créé peuvent être différentes. Si le compte a été créé dans `admin`, ajouter `authSource=admin` aux options de l’URI ; conserver une autre valeur si le compte a été créé ailleurs. Ne pas ajouter aveuglément cette option.
- Les caractères réservés du nom d’utilisateur ou du mot de passe doivent être encodés en pourcentage dans l’URI, par exemple `@` → `%40`, `#` → `%23`, `:` → `%3A`, `%` → `%25`. Encoder les composants d’identification, pas l’URI entière, et éviter le double encodage. Garder la valeur de `MONGODB_URI` entre guillemets dans dotenv, notamment si elle contient `#`.
- **Code 13 / Unauthorized** : vérifier les droits du compte sur la base applicative et les index.
- **Code 59 / CommandNotFound** : `hello` bénéficie du repli ciblé sur `isMaster`. Si une commande reste indisponible, vérifier la compatibilité/version du serveur et envisager sa mise à niveau. Aucun message MongoDB brut n'est journalisé.
- **Erreur réseau/DNS** : vérifier serveur, port, DNS et autorisations IP Atlas, sans ouvrir inutilement l’accès à toutes les adresses.
- **Index incompatibles/doublons** : examiner les données et index existants ; ne pas supprimer la base ou les index sans diagnostic et sauvegarde.

Après correction, relancer le backend : une modification du fichier d’environnement n’est pas nécessairement détectée par le watcher. Ne jamais copier l’URI ou le mot de passe dans un ticket ou une conversation.

### Test navigateur intégré isolé

Depuis le dossier voisin `flashcard-front`, `npm run test:integration` lance Chromium, Vite sur **http://localhost:5174** et `tests/e2e-server.ts` sur **127.0.0.1:3001**. Installer d’abord les dépendances des deux projets et Chromium côté frontend. Les ports doivent être libres ; aucun serveur existant n’est réutilisé.

Le serveur QA importe `createApp`, `loadConfig` et l’initialisation des modèles/index, **jamais** `src/server.ts` ou dotenv. Sa configuration test est fournie intégralement sans fusion avec l’environnement utilisateur : URI de `MongoMemoryReplSet` uniquement, base temporaire, secret de session QA, `CORS_ORIGIN` et `FRONTEND_URL` fixés à **http://localhost:5174**, SMTP absent et vérification email désactivée. Aucun fichier `.env*` n’est lu par ce serveur ou le Vite d’intégration, aucun accès à une base réelle existante. Le binaire MongoDB est réutilisé depuis `node_modules/.cache/mongodb-memory-server` ; le délai de démarrage autorise 10 minutes pour son premier téléchargement.

Le parcours réel couvre deux comptes inscrits dans le navigateur, organisation/cartes/révision/publication, recherche/like/save/profil et refus d’accès privés/écritures étrangères, puis dépublication et retrait des listes publiques/sauvegardes. Les vérifications HTTP utilisent les cookies des contextes Playwright indépendants, sans Supertest ni mocks. Voir le README frontend pour le périmètre détaillé.

Le teardown attend la fermeture du store, de Mongoose et du replica set avant la terminaison des processus. Sous Windows, une route de cycle de vie spécifique au **serveur QA loopback** permet ce nettoyage sans dépendre de SIGTERM ; SIGINT/SIGTERM nettoient également les ressources. Ne pas déployer ce serveur de test. Traces réseau désactivées, aucune URI ni secret journalisé, aucun serveur permanent. Validation du 18 octobre 2026 : **1 scénario E2E réel réussi**, nettoyage confirmé ; aucun changement métier nécessaire.

## Configuration

| Variable | Valeur / rôle |
| --- | --- |
| `NODE_ENV` | `development`, `test`, `production` |
| `PORT` | `3000` par défaut |
| `MONGODB_URI` | Obligatoire, schéma `mongodb://` ou `mongodb+srv://` |
| `MONGODB_DB` | Facultatif ; trim, vide = absent ; nom sûr de 63 octets UTF-8 maximum ; priorité explicite sur la base de l'URI, sans modifier `authSource` |
| `MONGODB_TRANSACTIONS` | `auto` (défaut) : détection replica set/mongos ou standalone sérialisé ; `required` : refuse standalone |
| `SESSION_SECRET` | Au moins 32 caractères, 48 en production ; valeur exemple refusée en production |
| `CORS_ORIGIN` | Une origine exacte, sans slash final, par défaut `http://localhost:5173` ; équivalents loopback à protocole/port identiques uniquement en `development` |
| `FRONTEND_URL` | Origine des liens de confirmation/réinitialisation, même défaut |
| `REQUIRE_EMAIL_VERIFICATION` | Booléen textuel `true` / `false`, défaut `false` ; `true` exige SMTP en production |
| `TRUST_PROXY` | Nombre de relais de confiance, défaut `0` ; configurer précisément derrière un reverse proxy |
| `SESSION_TTL_SECONDS` | Défaut 604800 (7 jours), minimum 60, maximum 2592000 |
| `AUTH_RATE_LIMIT` | Défaut 30 requêtes POST auth par IP et par fenêtre de 15 minutes |
| `CARD_TEXT_MAX_LENGTH` | Entier de 1 à 10000 inclus, défaut 10000 ; maximum par face après trim, configurable uniquement vers le bas |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP facultatif si confirmation désactivée ; serveur, port (587), TLS direct (défaut `false`, STARTTLS possible) |
| `SMTP_USER`, `SMTP_PASS` | Tous deux définis ou tous deux absents (relais SMTP autorisé) |
| `MAIL_FROM` | Email expéditeur obligatoire si SMTP activé |

En production : HTTPS obligatoire pour les deux origines, cookies `Secure`, secret de session non factice d'au moins 48 caractères. SMTP est facultatif avec `REQUIRE_EMAIL_VERIFICATION=false` : inscription, connexion et profils invités restent utilisables. Avec `REQUIRE_EMAIL_VERIFICATION=true`, l'absence de SMTP est refusée au démarrage. Une configuration SMTP partielle reste refusée : expéditeur valide avec un hôte, identifiants utilisateur/mot de passe ensemble, aucun expéditeur ni identifiant sans hôte. SMTP configuré utilise TLS direct ou STARTTLS obligatoire en production. Terminer TLS sur un proxy correctement déclaré via `TRUST_PROXY`. Aucun jeton de développement n'est renvoyé en production. Avec SMTP, les emails sont envoyés et aucun lien n'est exposé dans les réponses. Sans SMTP en `development` ou `test` uniquement, les champs explicites `devResetUrl` / `devVerificationUrl` permettent les tests manuels, y compris la confirmation activée sans SMTP. Ces liens vont vers les pages frontend `/reset-password?token=…` et `/verify-email?token=…`. Aucun secret ni lien n'est journalisé.

Lorsque la confirmation est activée, la livraison de l'email d'inscription est attendue (ou un lien de développement hors production) ; en cas d'échec, l'inscription non confirmée est annulée et une erreur 503 permet de réessayer. En production sans SMTP, `POST /api/auth/forgot-password` est explicitement désactivé : toute adresse valide reçoit le même **503** et le message « La récupération de mot de passe est indisponible pour le moment. », sans recherche de compte, génération/enregistrement de jeton, modification d'un jeton existant, appel mail ni `devResetUrl`. La validation des entrées reste active (400 si invalide). Avec SMTP, la récupération renvoie 200 et un message générique, y compris en cas d'email inconnu ou d'échec de livraison. Sans SMTP hors production, le lien de développement reste disponible. Le mode développement expose volontairement l'existence d'un compte par `devResetUrl` ; ne jamais l'utiliser en production.

Validation SMTP facultatif du 18 octobre 2026 : `npm run build` réussi ; `npm test` : **13 fichiers, 233 tests réussis et 6 ignorés** (cas spécifiques au standalone ignorés dans le passage replica set uniquement). Tests de configuration sans dotenv, garde `sendToken` sans envoi réseau, absence de génération de jeton/recherche DB/appel mail pour le reset désactivé, réponses 503 identiques, conservation des jetons existants et inscription/connexion/invités en production sans SMTP sur MongoDB éphémères. Aucun fichier d'environnement réel ni base utilisateur utilisé.

## Convention HTTP

Préfixe métier unique : **`/api`** ; seul l'accueil JSON descriptif est à **`/`**. Les identifiants sont des chaînes `_id` MongoDB (jamais renommés `id`). Un objet individuel est direct. Toute liste utilise `{ items, page, hasMore }`, avec `page=1`, `limit=12`, maximum `limit=100`. Les champs `page` et `hasMore` sont également présents sur le profil ; sa liste demandée est nommée `decks` (contrat profil conservé).

Erreurs : `{ message, errors? }`. `errors` contient les chemins et messages de validation, jamais les valeurs soumises. Codes : 400 validation, 401 non connecté, 403 origine interdite/profil d'un autre utilisateur/email non confirmé, 404 ressource absente ou inaccessible, 409 contrainte unique, 413 corps trop grand, 415 absence de JSON, 429 limite dépassée, 503 SMTP/readiness indisponible, 500 générique. Les créations renvoient 201 ; publication idempotente 200 ; suppressions et logout 204.

Toutes les mutations, **y compris DELETE, logout et publish sans corps**, exigent `Content-Type: application/json` (envoyer `{}` si nécessaire). Les cookies doivent être envoyés avec `credentials: 'include'` dans le navigateur. `Origin`, s'il est présent, doit correspondre à `CORS_ORIGIN`, y compris sur les lectures ; seule l’exception loopback en `development` décrite plus haut est permise. `null` est refusé. Les requêtes non navigateur sans Origin sont autorisées. CORS reflète uniquement l’origine demandée autorisée avec credentials. Préflight OPTIONS pris en charge.

### Authentification

| Méthode / route | Entrée | Résultat |
| --- | --- | --- |
| POST `/auth/guest` | `{}` strict | 200, utilisateur direct + session invitée (ou compte permanent déjà authentifié inchangé) |
| POST `/auth/register` | `{username,password,email?,displayName?}` | 201 + `recoveryUrl` affiché une seule fois à la création. Sans email : session immédiate, nom affiché = pseudo ou nom d'invité conservé. Avec email : comportement historique |
| POST `/auth/login` | `{username,password}` ou `{email,password}` | Utilisateur direct + session renouvelée. L'email reste accepté pour les comptes qui en ont un |
| GET `/auth/recovery` | Session permanente | `{hasLink,hasEmail}`. Ne renvoie jamais l'URL : seul le SHA-256 du secret est stocké |
| POST `/auth/recovery` | `{}` | Remplace le secret. Réponse `{url,hasLink,hasEmail}` : l'URL n'est lisible que dans cette réponse |
| POST `/auth/recover` | `{token,password}` | Nouveau mot de passe, sessions révoquées, le même lien reste valable |
| POST `/auth/delete-account` | `{confirm:"supprimer",password?}` | 204. Mot de passe obligatoire hors invité (400 s'il est faux, la session reste). Efface le compte et ses contenus, puis la session |
| POST `/auth/logout` | `{}` | 204, session détruite, cookies session et device invité effacés pour tous les comptes |
| GET `/auth/me` | — | Utilisateur direct, ou 401 |
| POST `/auth/forgot-password` | `{email}` | 200 `{message,devResetUrl?}` ; production sans SMTP : 503 `{message}` identique pour toute adresse valide |
| POST `/auth/reset-password` | `{token,password}` | `{message}`, invalide toutes les anciennes sessions |
| POST `/auth/verify-email` | `{token}` | `{message}`, connexion ensuite nécessaire |

Emails normalisés en minuscules, index unique **partiel sur les emails de type string**, username unique. Username strict `^[a-z0-9_]{3,24}$`. Profil dans le même document User, `isGuest:boolean` (défaut false), email et passwordHash obligatoires seulement pour les comptes permanents. Le mot de passe comporte 12 caractères minimum et 72 octets UTF-8 maximum (limite bcrypt), hash bcrypt coût 12. Jetons aléatoires 256 bits, seuls les SHA-256 sont stockés, expiration reset 1 h / vérification 24 h, consommation atomique à usage unique. Un nouveau forgot remplace le jeton précédent. Aucun champ email/hash/jeton/version d'auth n'est renvoyé, même à son propriétaire. Login, forgot, reset et confirmation excluent explicitement les invités.

### Invité automatique : contrat navigateur à intégrer séparément

Le frontend n'est pas modifié ici. À son initialisation **une seule fois**, appeler `GET /api/auth/me` avec credentials ; uniquement après un **401**, appeler `POST /api/auth/guest` avec `{}` et credentials. Mutualiser cette initialisation (promesse partagée), pas d'appel à chaque montage de composant et pas de retry en boucle après une autre erreur. `GET /me` seul ne crée ni utilisateur ni session persistante. Tous les POST auth, y compris guest, partagent la limite existante **30 / IP / 15 minutes** par défaut.

Réponse utilisateur directe exacte (GET me, POST guest, login, register sans confirmation) : `{_id,username,displayName,bio,avatarUrl,isGuest}`. `_id` est une chaîne MongoDB ; `isGuest` est toujours booléen, false pour les anciens comptes. Les profils publics ajoutent également `isGuest` ; les projections owner l'incluent sur les nouveaux comptes. Pas d'enveloppe `user`, pas d'email et aucun secret. Guest répond toujours **200**, qu'il retrouve ou crée un utilisateur ; register garde **201**, y compris pour une conversion.

Le seul secret d'identité invitée côté navigateur est le cookie **serveur** `mnemo.guest` : 32 octets aléatoires, encodés en 64 caractères hexadécimaux, `HttpOnly`, `SameSite=Lax`, `Secure` en production, chemin `/`, sans Domain, Max-Age **400 jours**. Aucun localStorage, clé frontend, header userID ou identifiant fourni par le client n'authentifie un utilisateur. En DB, seul son SHA-256 est conservé dans `guestTokenHash`, non sélectionné par défaut, unique sparse. Un cookie inconnu, forgé, ambigu ou mal encodé n'est jamais adopté : un nouveau secret est généré. Un cookie valide retrouve uniquement un User encore invité et recrée une session `flashcard.sid` avec régénération, sauvegarde, `userId` et `authVersion`. Le cookie device n'est émis que pour un nouvel invité, pas renouvelé à chaque appel. Une session valide prime sur un cookie device, y compris pour un compte permanent : ce dernier est renvoyé sans création ni régénération.

Les invités utilisent exactement les permissions propriétaire existantes : cours, chapitres, cartes, publications et historique restent liés au même User. Aucun reset quotidien, aucune purge et **aucun TTL sur les users ou leurs contenus**. Les 400 jours sont une durée maximale demandée au navigateur, pas une garantie de conservation du cookie et **pas une promesse de purge des données**. Message de profil conseillé : « Profil invité lié à ce navigateur. La perte des cookies ou la déconnexion peut vous faire perdre l'accès à vos cours. Créez un compte pour sécuriser cet accès. » Les noms affichés sont générés à partir de mots originaux du projet, sans liste de personnalités reprise.

`POST /register` convertit uniquement l'invité de la **session authentifiée courante** (initialiser guest avant), jamais un invité indiqué par ID ou par le seul cookie device. Une mise à jour atomique conditionnée par `_id`, `isGuest`, version et hash empêche les doubles conversions et l'écrasement d'un compte permanent. Le même `_id`, la bio et tous les propriétaires sont conservés. Un nouveau compte envoie `username` et `password` : le nom affiché reprend le pseudo, ou le nom déjà choisi par l'invité. `email` et `displayName` restent acceptés pour les comptes qui les utilisaient déjà ; la confirmation email ne s'applique que si un email est fourni. L'unicité email/username reste imposée. Le lien de récupération est affiché une seule fois au propriétaire ; la base ne conserve que son SHA-256. Le hash device est supprimé et les anciennes sessions invitées invalidées par incrément de version. Le cookie device est effacé après succès. Un utilisateur permanent déjà connecté reçoit 409 s'il tente register.

Avec confirmation obligatoire et un email fourni, la conversion attend SMTP en production (lien de développement autorisé sans SMTP en `development`/`test`) : après succès, pas de session, connexion 403 tant que l'email n'est pas confirmé, puis login explicite ; les contenus restent privés et conservés. Une panne SMTP renvoie 503 et restaure l'identité invitée (même `_id`, hash device, version, username/displayName), sans supprimer l'utilisateur ou ses cours. La compensation est conditionnelle : elle ne remplace pas une confirmation/reset concurrent déjà effectué. DB et SMTP ne sont pas une transaction distribuée ; un arrêt brutal du processus ou une panne DB pendant la compensation nécessite une inspection opérateur, pas une suppression de données.

La connexion à un **compte existant** remplace la session et efface le cookie device, **sans transfert ni fusion implicite** des contenus invités. Avertissement frontend avant login : « Se connecter à un compte existant ne transfère pas les cours de cet invité. Pour les conserver, créez un compte depuis ce profil. » Logout efface les deux cookies, même pour un compte permanent sur appareil partagé, mais ne supprime ni User ni contenu. Comme tout bearer cookie, une copie dérobée du cookie device reste sensible ; ne jamais la journaliser. La conversion révoque son hash en DB.

### Migration sûre de l'ancien index email (maintenance explicite)

Une base existante peut avoir `email_1` unique normal ou sparse : ces index ne permettent pas correctement plusieurs invités sans email. Le démarrage **inspecte** les index et refuse un index unique email non partiel avec un message de maintenance ; il ne lance aucun `dropIndex` ou `syncIndexes` automatique. Ne jamais supprimer des documents, la base, ou des emails pour contourner ce refus.

Avant déploiement : sauvegarder la base et la définition de ses index, **arrêter toutes les API et tous les autres producteurs d'écritures**, puis inspecter les index de `users`. Le script `npm run migrate:email-index -- --maintenance-confirmed` est une opération opérateur, **jamais exécutée par les tests ou le démarrage**. Il ne charge aucun dotenv : fournir `MONGODB_URI` et éventuellement `MONGODB_DB` par l'environnement sécurisé du processus, jamais en argument ou dans un ticket. Aucun nouveau paramètre `.env.example` n'est nécessaire.

Le script examine les index, refuse les définitions email inconnues et les doublons string, puis remplace seulement l'ancien index email unique normal/sparse par `email_string_unique`, unique avec `partialFilterExpression: {email: {$type: 'string'}}`. Il ne modifie **aucun document**, n'ajoute pas d'email null aux invités et conserve les autres index. La suppression/recréation de l'index n'est pas atomique (notamment MongoDB 4.4) : la maintenance réelle et la sauvegarde sont obligatoires. En cas d'échec de création, il tente de restaurer l'ancien index ; si la restauration échoue, garder l'API arrêtée et restaurer depuis la sauvegarde. Vérifier les index après l'opération avant de redémarrer. La migration est idempotente ; aucune migration n'a été exécutée sur une base de travail lors de cette implémentation.

Validation invités du 18 octobre 2026 : `npm run build` réussi ; `npm test` : **7 fichiers, 151 tests réussis, 6 ignorés** (cas standalone ignorés dans le passage replica set seulement). Couverture ajoutée : cookie stable après perte des sessions, reprise concurrente sans doublon, unicité hash/email, isolation invités/comptes privés, cookies forgés/mal encodés, logout/login sans fusion, conversion même `_id` et collisions concurrentes, confirmation et restauration SMTP, exclusion des guests des resets, cookies Secure et rate limit, migrations normal/sparse idempotentes, refus des doublons/index inconnus et restauration après panne. Tests sur MongoDB éphémères uniquement, sans dotenv ni accès à une DB de travail ; scripts QA existants inchangés.

Sessions MongoDB dans `sessions`, cookie `flashcard.sid`, `httpOnly`, `sameSite=lax`, chemin `/`, sans Domain. Renouvellement de l'ID à la connexion et à l'inscription authentifiée. Les sessions précédentes deviennent inutilisables après reset via une version d'auth vérifiée en DB à chaque requête. Les documents de session expirent via index TTL. L'index TTL MongoDB peut nettoyer avec un léger délai ; le store contrôle aussi l'expiration à la lecture.

### Profils et organisation (auth obligatoire pour les mutations)

| Méthode / route | Entrée / résultat |
| --- | --- |
| GET `/profiles/:username` | Public : `{_id,username,displayName,bio,avatarUrl,publicDeckCount,followerCount:0,followingCount:0,decks,page,hasMore}` ; decks publics seulement, avec cardCount |
| PATCH `/profiles/:username` | Propriétaire : `{displayName?,bio?,avatarUrl?}` ; même profil public |
| GET / POST `/courses` | Liste propriétaire / création `{title,description?,color?,icon?}` |
| PATCH / DELETE `/courses/:id` | Propriétaire ; modification partielle / cascade |
| GET / POST `/courses/:id/chapters` | Propriétaire ; liste / création `{title,description?,position?}` |
| PATCH / DELETE `/chapters/:id` | Propriétaire ; modification partielle / cascade |
| GET / POST `/decks` | Mes decks avec cardCount / création `{title,description?,chapter?,subject?,level?,visibility?,coverUrl?}` |
| GET `/decks/:id` | Deck accessible avec cards ordonnées, cardCount et owner `{_id,username,displayName,avatarUrl}` |
| PATCH / DELETE `/decks/:id` | Propriétaire ; champs de création partiels / cascade |
| POST `/decks/:id/cards` | Propriétaire : `{front?,back?,frontImageUrl?,backImageUrl?,position?}` ; chaque face a un texte ou une image ; position finale automatique si absente |
| POST `/cards/quick` | Création rapide : mêmes faces et `deck?`. Sans deck, crée au besoin le paquet privé unique « Général ». Réponse `{card, deck:{_id,title}}` |
| PATCH / DELETE `/cards/:id` | Propriétaire : `{front?,back?,frontImageUrl?,backImageUrl?,position?}` / suppression |
| PUT `/decks/:id/cards/order` | Propriétaire : `{ids:[]}` permutation complète, sans doublon ni carte étrangère ; retourne deck avec cards |

`chapter` est facultatif ; `null` sur PATCH détache le paquet. Le chapitre doit appartenir au même utilisateur et son cours doit exister. La création rapide peut viser n'importe quel paquet propriétaire, y compris un paquet rangé dans un cours. Sans choix, le marqueur interne `quickDefault` garantit un seul paquet « Général » par propriétaire et n'est pas exposé dans les réponses API. Suppression d'un cours → chapitres → decks → cartes, publications, likes, sauvegardes et historique associé. Suppression d'un chapitre applique la même cascade à ses decks. Les listes de chapitres/cartes sont triées par position puis `_id` ; les autres listes par date puis `_id` décroissants.

Les URL sont HTTP(S) uniquement ou vides, au plus 2048 caractères. Titres : 1–160 caractères ; descriptions : 4000 ; displayName : 1–80 ; bio : 1000. Chaque face de carte (`front` / `back`) contient un texte, une image (`frontImageUrl` / `backImageUrl`), ou les deux. Le texte, après trim, va de 0 à `CARD_TEXT_MAX_LENGTH` caractères et peut être vide seulement si l'image HTTP(S) de la même face est présente. Un PATCH de position seule reste possible. Les corps n'acceptent aucun champ inconnu et les PATCH vides sont refusés. Les textes sont stockés comme texte brut : le frontend ne doit pas les injecter en HTML non assaini. Les images sont affichées par leur URL, sans téléchargement ni HTML.

`GET /api/config` est public et renvoie uniquement `{ "cardTextMaxLength": 10000 }` (ou la valeur configurée), jamais les secrets de configuration. La configuration est validée au démarrage puis injectée dans chaque routeur ; aucune lecture d’environnement par validation ni mutation globale des modèles. POST et PATCH des faces appliquent la limite après trim, en unités UTF-16 (comme `String.length` et `maxlength` du navigateur). Le plafond Mongoose reste 10000, commun à tous les modèles/processus ; le corps JSON reste limité à **256 ko**. Une valeur supérieure à 10000, nulle, fractionnaire ou invalide empêche le démarrage. Redémarrer le backend puis recharger le frontend après un changement. Les cartes existantes ne sont ni tronquées ni migrées : une face renvoyée en écriture doit respecter la nouvelle limite ; un PATCH de position seule reste possible.

Validation des limites le 18 octobre 2026 : build backend réussi et **23 tests d’intégration réussis**, dont bornes de configuration, plafond des modèles, POST/PATCH des deux faces, trim, isolation entre applications configurées différemment et réponse publique limitée au seul champ autorisé. Non-régression croisée : build frontend, **32 tests unitaires**, **38 E2E mockés** desktop/mobile et **1 E2E réel** réussis ; ports QA 3001/5174 libres et aucun processus mongod restant après nettoyage.

### Visibilité et social

- `private` (défaut) : seul le propriétaire peut lire, même avec l'identifiant ; 404 pour les autres.
- `unlisted` : l'identifiant constitue une capacité de lecture, y compris visiteur ; jamais listé dans feed, recherche, profil ou sauvegardes. Seul le propriétaire le voit dans sa liste personnelle.
- `public` : lecture publique, publication unique obligatoire et au moins une carte. Un deck vide ne peut pas être créé directement public : créer privé, ajouter les cartes puis publier.
- Passer public par PATCH crée la publication ; passer private/unlisted supprime publication, likes et sauvegardes. Supprimer la dernière carte d'un paquet public le rend privé et le dépublie. Ces écritures sont atomiques **uniquement en mode transactionnel** ; en standalone, les limites et l'ordre décrits plus haut s'appliquent.

| Méthode / route | Entrée / résultat |
| --- | --- |
| POST `/decks/:id/publish` | Propriétaire, `{}` ; publication directe `{_id,deck,owner,createdAt}` ; idempotent |
| GET `/feed?sort=recent\|popular&q=&page=1&limit=12` | Public ; publications `{_id,createdAt,deck:{...deck,cardCount,preview:{front,back,frontImageUrl,backImageUrl}},owner:{_id,username,displayName,avatarUrl},likeCount,liked,saved}` |
| PUT `/publications/:id/like` | Auth : `{liked:boolean}` ; `{liked,likeCount}` ; idempotent |
| GET `/saved` | Auth ; liste de decks publics actuels avec cardCount et owner, pas de copie |
| PUT `/decks/:id/save` | Auth : `{saved:boolean}` ; `{saved}` ; public seulement, idempotent |
| POST `/decks/:id/study-sessions` | Auth, deck accessible non vide ; `{cardsVisited,durationSeconds,knownCount?,doubtCount?,unknownCount?}` ; la somme des repères ne dépasse pas `cardsVisited` ; session directe |
| GET `/study-sessions` | Auth ; historique personnel paginé, référence deck non peuplée |
| GET `/health` | `{status:"ok"}` |
| GET `/ready` | 200 `{status:"ok",connected:true}` ou 503 `{status:"unavailable",connected:false}` |

`popular` : total de likes décroissant, puis date décroissante et `_id` pour départager. Classement/recherche avant pagination. Recherche littérale insensible à la casse sur titre, description, username et displayName du créateur, jamais les cartes ni les contenus non publics. `liked` et `saved` valent false pour les visiteurs.

`cardsVisited` : entier 1–100000 (les passages répétés sont permis, ce n'est pas un nombre de cartes distinctes) ; `durationSeconds` : entier 1–86400. `knownCount`, `doubtCount` et `unknownCount` sont des entiers 0–100000, facultatifs, et leur somme ne peut pas dépasser `cardsVisited`. Le frontend en déduit un taux : connu vaut 1, le doute 0,5 et inconnu 0. Ce taux est une annotation de l'utilisateur, pas une maîtrise certifiée. L'historique ne peuple jamais le contenu d'un deck qui peut être devenu privé. Pas d'abonnements, commentaires, copie de sauvegarde ni algorithme de répétition espacée dans ce MVP.

## Architecture et garanties

- `src/config.ts` : configuration Zod et contraintes production.
- `src/mongo.ts` : promesse de connexion partagée, pool et refus de reconfiguration active.
- `src/session-store.ts` : sessions sur le même client et la même base ; fermeture réservée à Mongoose.
- `src/models.ts` : modèles, index uniques/relations et validation DB Mongoose.
- `src/auth.ts` : auth, profils automatiques, versionnement des sessions et jetons.
- `src/routes.ts` : contrat HTTP et validation stricte.
- `src/data.ts` : permissions, exécuteurs transactionnel/standalone, file par connexion et cascades.
- `src/app.ts` : application testable, cookies, store Mongo, CORS, Helmet, CSRF, rate limiting, erreurs.
- `src/mail.ts` : SMTP et liens de développement explicites.
- `src/server.ts` : démarrage validé, index et arrêt gracieux.
- `src/topology.ts` : détection hello/isMaster, refus required et avertissement standalone.
- `scripts/migrate-email-index.ts` : migration explicite de l'ancien index email, API arrêtée.
- `scripts/seed-mnemo.ts` : compte `mnemo` et paquets publics d'exemple, idempotent.
- `tests/integration.test.ts` : tests HTTP avec sessions réelles, replica set et standalone MongoDB temporaires.
- `tests/topology.test.ts`, `tests/executor.test.ts`, `tests/startup-error.test.ts` : commandes compatibles 4.4, modes, exécuteurs et diagnostics sans secrets.

`createApp(config, options?)` accepte `{ transactions: boolean }`, fourni par la détection dans le serveur. Sans options, **le chemin transactionnel reste le défaut**, même si la configuration indique `auto` : cette API de fabrique ne sonde pas MongoDB. Les tests/appels embarqués sur standalone doivent passer `{ transactions: false }`. Chaque application capture son propre exécuteur, sans mode global mutable ; les exécuteurs standalone d'une même connexion partagent leur file. `apiRouter(config, execute?)` capture également l'exécuteur injecté ; les contrats HTTP et réponses publiques ne changent pas, `/api/config` ne publie pas le mode ni les secrets.

En replica set/mongos, les mutations métier s'exécutent dans des transactions, sans opérations parallèles sur une même transaction. Les mutations de cartes/social/pub prennent un verrou d'écriture sur le deck après validation ; MongoDB réessaie les conflits transactionnels. En standalone, la file remplace seulement la concurrence des écritures dans le processus, jamais l'atomicité ni l'isolation des lectures. Les publications et relations sociales sont toujours protégées par des index uniques. MongoDB n'offrant pas de clés étrangères, les associations et droits sont contrôlés par l'API ; les écritures directes en base contournent ces contrôles.

Le rate limiter est en mémoire par processus ; en déploiement multi-instance (replica set/mongos uniquement), ajouter une limitation partagée au reverse proxy ou un store partagé avant exposition publique. Les sessions et index d'unicité sont partagés en MongoDB ; les transactions ne sont utilisées que si la topologie les permet. Les contenus non listés sont des capacités : ne pas exposer leurs identifiants dans des liens publics. Aucun serveur durable n'est démarré par les tests.