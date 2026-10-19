import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { createMutationExecutor, deleteDecks } from '../src/data.js';
import { getMongo } from '../src/mongo.js';
import { Card, Deck, Publication, User, initializeIndexes } from '../src/models.js';
import { detectTransactions } from '../src/topology.js';

/**
 * Compte et paquets publics d'exemple, le temps que la communauté existe.
 *
 *   npm run seed:mnemo
 *
 * Charge `.env` sans écraser les variables déjà exportées. Pour une autre base,
 * exporter `MONGODB_URI` (et `MONGODB_DB`) avant la commande.
 *
 * MNEMO_EMAIL       défaut mnemo@example.invalid
 * MNEMO_PASSWORD    requis seulement à la création si l'on ne veut pas d'un mot de passe aléatoire
 * MNEMO_MIN_USERS   défaut 5 : nombre de comptes permanents hors mnemo à partir duquel
 *                   aucun paquet d'exemple n'est ajouté
 * MONGODB_TRANSACTIONS  auto (défaut) ou required
 *
 * Catalogue : culture générale (texte, image HTTP(S), ou les deux). Un paquet dont le titre, la
 * description et les cartes sont encore ceux du catalogue est publié. Un paquet modifié
 * est laissé tel quel. L'ancien catalogue scolaire, s'il est encore intact, est retiré.
 * Au-delà du seuil, rien n'est ajouté et les exemples déjà présents restent en base.
 */

const USERNAME = 'mnemo';
const DISPLAY_NAME = 'Mnemo';
const BIO = 'Compte d\'exemples. Ces paquets publics de culture générale servent à découvrir l\'application en attendant que la communauté publie les siens.';
const PREVIOUS_BIO = 'Compte d\'exemples. Ces paquets publics servent à découvrir l\'application en attendant que la communauté publie les siens.';
const DEFAULT_EMAIL = 'mnemo@example.invalid';
const DEFAULT_MIN_USERS = 5;

class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

type ExampleCard = { front: string; back: string; frontImageUrl?: string; backImageUrl?: string };
type ExampleDeck = {
  title: string;
  description: string;
  subject: string;
  level: string;
  cards: ExampleCard[];
};

const examples: ExampleDeck[] = [
  {
    title: 'Culture g : géographie',
    description: 'Paquet d\'exemple de culture générale : repères géographiques, question puis réponse.',
    subject: 'Culture générale',
    level: 'Géographie',
    cards: [
      { front: 'Quelle est la capitale du Japon ?', back: 'Tokyo' },
      { front: 'Quelle est la capitale de l\'Australie ?', back: 'Canberra' },
      { front: 'Quel est le plus vaste océan ?', back: 'L\'océan Pacifique' },
      { front: 'Quel est le plus haut sommet du monde ?', back: 'L\'Everest' },
      { front: 'Quel fleuve traverse l\'Égypte ?', back: 'Le Nil' },
      { front: 'Quel détroit sépare l\'Europe et l\'Afrique ?', back: 'Le détroit de Gibraltar' },
      { front: 'Quel est le plus grand désert chaud du monde ?', back: 'Le Sahara' },
      { front: 'Dans quel pays se trouve le Machu Picchu ?', back: 'Au Pérou' },
    ],
  },
  {
    title: 'Culture g : histoire',
    description: 'Paquet d\'exemple de culture générale : grands repères historiques, question puis réponse.',
    subject: 'Culture générale',
    level: 'Histoire',
    cards: [
      { front: 'Qui atteint l\'Amérique en 1492 ?', back: 'Christophe Colomb' },
      { front: 'Quelle cité romaine est ensevelie par le Vésuve en 79 ?', back: 'Pompéi' },
      { front: 'Qui était Cléopâtre ?', back: 'La dernière reine d\'Égypte' },
      { front: 'Qui était le premier empereur romain ?', back: 'Auguste' },
      { front: 'En quelle année a lieu la prise de la Bastille ?', back: '1789' },
      { front: 'En quelle année l\'être humain marche-t-il sur la Lune ?', back: '1969' },
      { front: 'En quelle année tombe le mur de Berlin ?', back: '1989' },
      { front: 'Quelle civilisation a bâti le Machu Picchu ?', back: 'Les Incas' },
    ],
  },
  {
    title: 'Culture g : sciences',
    description: 'Paquet d\'exemple de culture générale : sciences, question puis réponse.',
    subject: 'Culture générale',
    level: 'Sciences',
    cards: [
      { front: 'Quelle est la formule chimique de l\'eau ?', back: 'H₂O' },
      { front: 'Quel gaz les plantes absorbent-elles pour la photosynthèse ?', back: 'Le dioxyde de carbone' },
      { front: 'Qui propose la théorie de la relativité ?', back: 'Albert Einstein' },
      { front: 'Quel élément chimique a pour symbole Au ?', back: 'L\'or' },
      { front: 'Combien de chromosomes possède une cellule humaine ?', back: '46' },
      { front: 'Quelle est la vitesse de la lumière dans le vide, en ordre de grandeur ?', back: 'Environ 300 000 km/s' },
      { front: 'Qui découvre la pénicilline ?', back: 'Alexander Fleming' },
      { front: 'Quelle planète est surnommée la planète rouge ?', back: 'Mars' },
    ],
  },
  {
    title: 'Culture g : arts',
    description: 'Paquet d\'exemple de culture générale : peinture et sculpture, question puis réponse.',
    subject: 'Culture générale',
    level: 'Arts',
    cards: [
      { front: 'Qui a peint La Joconde ?', back: 'Léonard de Vinci' },
      { front: 'Dans quel musée est exposée La Joconde ?', back: 'Le Louvre, à Paris' },
      { front: 'Qui a peint La Nuit étoilée ?', back: 'Vincent van Gogh' },
      { front: 'Qui a peint Guernica ?', back: 'Pablo Picasso' },
      { front: 'Qui a peint Les Nymphéas ?', back: 'Claude Monet' },
      { front: 'Quel mouvement artistique est associé à Monet ?', back: 'L\'impressionnisme' },
      { front: 'Qui a sculpté Le Penseur ?', back: 'Auguste Rodin' },
      { front: 'Où se trouve la chapelle Sixtine ?', back: 'Au Vatican' },
    ],
  },
  {
    title: 'Culture g : littérature',
    description: 'Paquet d\'exemple de culture générale : auteurs et œuvres, question puis réponse.',
    subject: 'Culture générale',
    level: 'Littérature',
    cards: [
      { front: 'Qui a écrit Les Misérables ?', back: 'Victor Hugo' },
      { front: 'Qui a écrit Madame Bovary ?', back: 'Gustave Flaubert' },
      { front: 'Qui a écrit Le Petit Prince ?', back: 'Antoine de Saint-Exupéry' },
      { front: 'Qui a écrit L\'Étranger ?', back: 'Albert Camus' },
      { front: 'Qui a écrit Germinal ?', back: 'Émile Zola' },
      { front: 'Qui a écrit Roméo et Juliette ?', back: 'William Shakespeare' },
      { front: 'Qui a écrit Don Quichotte ?', back: 'Miguel de Cervantes' },
      { front: 'Qui a écrit 1984 ?', back: 'George Orwell' },
    ],
  },
  {
    title: 'Culture g : cinéma',
    description: 'Paquet d\'exemple de culture générale : cinéma, question puis réponse.',
    subject: 'Culture générale',
    level: 'Cinéma',
    cards: [
      { front: 'Qui réalise Titanic, sorti en 1997 ?', back: 'James Cameron' },
      { front: 'Qui réalise Inception ?', back: 'Christopher Nolan' },
      { front: 'Dans quelle ville Humphrey Bogart tient-il un café dans le film de 1942 ?', back: 'Casablanca' },
      { front: 'Quel studio a créé Mickey Mouse ?', back: 'Les studios Disney' },
      { front: 'Comment s\'appelle le robot doré et humanoïde de Star Wars ?', back: 'C-3PO' },
      { front: 'Quel film d\'animation met en scène un rat cuisinier à Paris ?', back: 'Ratatouille' },
      { front: 'Comment s\'appelle la récompense du meilleur film aux Oscars ?', back: 'L\'Oscar du meilleur film' },
      { front: 'Qui joue Jack Sparrow dans Pirates des Caraïbes ?', back: 'Johnny Depp' },
    ],
  },
  {
    title: 'Culture g : musique',
    description: 'Paquet d\'exemple de culture générale : musique, question puis réponse.',
    subject: 'Culture générale',
    level: 'Musique',
    cards: [
      { front: 'Qui a composé Les Quatre Saisons ?', back: 'Antonio Vivaldi' },
      { front: 'Qui a composé la Neuvième Symphonie, avec l\'Ode à la joie ?', back: 'Ludwig van Beethoven' },
      { front: 'Qui a composé Le Lac des cygnes ?', back: 'Piotr Ilitch Tchaïkovski' },
      { front: 'Quel compositeur devient sourd à la fin de sa vie ?', back: 'Ludwig van Beethoven' },
      { front: 'Combien de touches a un piano standard ?', back: '88' },
      { front: 'Combien de cordes a une guitare classique ?', back: 'Six' },
      { front: 'Quel groupe interprète Bohemian Rhapsody ?', back: 'Queen' },
      { front: 'Quel instrument à vent est associé au dieu Pan ?', back: 'La flûte de Pan' },
    ],
  },
  {
    title: 'Culture g : sport',
    description: 'Paquet d\'exemple de culture générale : sport, question puis réponse.',
    subject: 'Culture générale',
    level: 'Sport',
    cards: [
      { front: 'Combien de joueurs une équipe de football aligne-t-elle sur le terrain ?', back: '11' },
      { front: 'Quelle est la longueur d\'un marathon ?', back: '42,195 km' },
      { front: 'Combien d\'anneaux figurent sur le drapeau olympique ?', back: 'Cinq' },
      { front: 'Où ont lieu les premiers Jeux olympiques modernes, en 1896 ?', back: 'À Athènes' },
      { front: 'Tous les combien d\'années ont lieu les Jeux olympiques d\'été ?', back: 'Tous les quatre ans' },
      { front: 'Quel sport se joue avec un volant ?', back: 'Le badminton' },
      { front: 'Quel pays remporte la Coupe du monde de football en 2018 ?', back: 'La France' },
      { front: 'Au tennis, comment appelle-t-on un score de zéro ?', back: 'Love, en anglais' },
    ],
  },
  {
    title: 'Culture g : en images',
    description: 'Paquet d\'exemple de culture générale : question et réponse en texte, en image, ou les deux.',
    subject: 'Culture générale',
    level: 'Images',
    cards: [
      { front: 'Quel monument est photographié ?', back: 'La tour Eiffel, à Paris', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg/250px-Tour_Eiffel_Wikimedia_Commons.jpg' },
      { front: 'Quel drapeau représente le Japon ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/9/9e/Flag_of_Japan.svg' },
      { front: 'Quel pays a ce drapeau ?', back: 'La France', frontImageUrl: 'https://upload.wikimedia.org/wikipedia/en/c/c3/Flag_of_France.svg' },
      { front: 'Quel tableau est représenté ?', back: 'La Joconde, de Léonard de Vinci', frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg/250px-Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg' },
      { front: 'Quelle planète est photographiée ?', back: 'La Terre', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/The_Earth_seen_from_Apollo_17.jpg/250px-The_Earth_seen_from_Apollo_17.jpg' },
      {
        front: 'Quel monument est photographié, et de quel pays vient-il ?',
        back: 'La Grande Muraille, en Chine',
        frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/23/The_Great_Wall_of_China_at_Jinshanling-edit.jpg/250px-The_Great_Wall_of_China_at_Jinshanling-edit.jpg',
        backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/f/fa/Flag_of_the_People%27s_Republic_of_China.svg',
      },
      { front: 'Quel drapeau représente l\'Allemagne ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/ba/Flag_of_Germany.svg/250px-Flag_of_Germany.svg.png' },
      { front: 'Quel drapeau représente l\'Italie ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/03/Flag_of_Italy.svg/250px-Flag_of_Italy.svg.png' },
      { front: 'Quel drapeau représente l\'Espagne ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Flag_of_Spain.svg/250px-Flag_of_Spain.svg.png' },
      { front: 'Quel drapeau représente les États-Unis ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a4/Flag_of_the_United_States.svg/250px-Flag_of_the_United_States.svg.png' },
      { front: 'Quel drapeau représente le Canada ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cf/Flag_of_Canada.svg/250px-Flag_of_Canada.svg.png' },
      { front: 'Quel drapeau représente l\'Inde ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/Flag_of_India.svg/250px-Flag_of_India.svg.png' },
      { front: 'Quel drapeau représente la Grèce ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Flag_of_Greece.svg/250px-Flag_of_Greece.svg.png' },
      { front: 'Quel drapeau représente la Suisse ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/08/Flag_of_Switzerland_%28Pantone%29.svg/250px-Flag_of_Switzerland_%28Pantone%29.svg.png' },
      { front: 'Quel drapeau représente la Suède ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Flag_of_Sweden.svg/250px-Flag_of_Sweden.svg.png' },
      { front: 'Quel drapeau représente le Mexique ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fc/Flag_of_Mexico.svg/250px-Flag_of_Mexico.svg.png' },
      { front: 'Quel drapeau représente l\'Égypte ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Flag_of_Egypt.svg/250px-Flag_of_Egypt.svg.png' },
      { front: 'Quel drapeau représente le Maroc ?', back: '', backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Flag_of_Morocco.svg/250px-Flag_of_Morocco.svg.png' },
      {
        front: 'Quel monument est photographié ?',
        back: 'Le Colisée, à Rome',
        frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/53/Colosseum_in_Rome%2C_Italy_-_April_2007.jpg/250px-Colosseum_in_Rome%2C_Italy_-_April_2007.jpg',
        backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/03/Flag_of_Italy.svg/250px-Flag_of_Italy.svg.png',
      },
      {
        front: 'Quel monument est photographié ?',
        back: 'Le Taj Mahal, en Inde',
        frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1d/Taj_Mahal_%28Edited%29.jpeg/250px-Taj_Mahal_%28Edited%29.jpeg',
        backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/Flag_of_India.svg/250px-Flag_of_India.svg.png',
      },
      {
        front: 'Quel monument est photographié ?',
        back: 'La statue de la Liberté, à New York',
        frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/Statue_of_Liberty%2C_NY.jpg/250px-Statue_of_Liberty%2C_NY.jpg',
        backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a4/Flag_of_the_United_States.svg/250px-Flag_of_the_United_States.svg.png',
      },
      { front: 'Quel site est photographié ?', back: 'Le Machu Picchu, au Pérou', frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/eb/Machu_Picchu%2C_Peru.jpg/250px-Machu_Picchu%2C_Peru.jpg' },
      {
        front: 'Quel bâtiment est photographié ?',
        back: 'L\'opéra de Sydney, en Australie',
        frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7c/Sydney_Opera_House_-_Dec_2008.jpg/250px-Sydney_Opera_House_-_Dec_2008.jpg',
        backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b9/Flag_of_Australia.svg/250px-Flag_of_Australia.svg.png',
      },
      {
        front: 'Quel monument est photographié ?',
        back: 'Le Parthénon, à Athènes',
        frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/da/The_Parthenon_in_Athens.jpg/250px-The_Parthenon_in_Athens.jpg',
        backImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Flag_of_Greece.svg/250px-Flag_of_Greece.svg.png',
      },
      { front: 'Quel site est photographié ?', back: 'Stonehenge, en Angleterre', frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3c/Stonehenge2007_07_30.jpg/250px-Stonehenge2007_07_30.jpg' },
      { front: 'Quel monument est photographié ?', back: 'La Sagrada Família, à Barcelone', frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ee/Sagrada_Familia_01.jpg/250px-Sagrada_Familia_01.jpg' },
      { front: 'Quel monument est photographié ?', back: 'L\'arc de Triomphe, à Paris', frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Arc_de_Triomphe_de_l%27%C3%89toile.jpg/250px-Arc_de_Triomphe_de_l%27%C3%89toile.jpg' },
      { front: 'Quel monument est photographié ?', back: 'Notre-Dame de Paris', frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/af/Notre-Dame_de_Paris_2013-07-24.jpg/250px-Notre-Dame_de_Paris_2013-07-24.jpg' },
      { front: 'Quel tableau est représenté ?', back: 'La Nuit étoilée, de Vincent van Gogh', frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg/250px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg' },
      { front: 'Quel tableau est représenté ?', back: 'La Jeune Fille à la perle, de Johannes Vermeer', frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d7/Meisje_met_de_parel.jpg/250px-Meisje_met_de_parel.jpg' },
      { front: 'Quel tableau est représenté ?', back: 'La Naissance de Vénus, de Sandro Botticelli', frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/Sandro_Botticelli_-_La_nascita_di_Venere_-_Google_Art_Project.jpg/250px-Sandro_Botticelli_-_La_nascita_di_Venere_-_Google_Art_Project.jpg' },
      { front: 'Quel animal est photographié ?', back: 'L\'éléphant d\'Afrique', frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/37/African_Bush_Elephant.jpg/250px-African_Bush_Elephant.jpg' },
      { front: 'Quel animal est photographié ?', back: 'Le panda géant', frontImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3c/Giant_Panda_2004-03-2.jpg/250px-Giant_Panda_2004-03-2.jpg' },
    ],
  },
];

/** Premier catalogue, scolaire. Retiré seulement s'il n'a pas été modifié. */
const retiredSchoolTitles = [
  'Capitales d\'Europe',
  'Anglais : les salutations',
  'Le système solaire',
  'Les natures de mots',
  'Dates de l\'histoire de France',
  'Le corps humain',
  'Fractions et pourcentages',
  'Être et avoir au présent',
];

function seedEmail(): string {
  const email = (process.env.MNEMO_EMAIL?.trim() || DEFAULT_EMAIL).toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new SeedError('MNEMO_EMAIL est invalide.');
  return email;
}

function minUsers(): number {
  const raw = process.env.MNEMO_MIN_USERS?.trim() || String(DEFAULT_MIN_USERS);
  if (!/^\d+$/.test(raw)) throw new SeedError('MNEMO_MIN_USERS doit être un entier positif.');
  const value = Number(raw);
  if (value < 1 || value > 100000) throw new SeedError('MNEMO_MIN_USERS doit être compris entre 1 et 100000.');
  return value;
}

function transactionsMode(): 'auto' | 'required' {
  const value = process.env.MONGODB_TRANSACTIONS?.trim() || 'auto';
  if (value !== 'auto' && value !== 'required') throw new SeedError('MONGODB_TRANSACTIONS doit valoir auto ou required.');
  return value;
}

function randomPassword(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let password = '';
  for (const byte of randomBytes(20)) password += alphabet[byte % alphabet.length] ?? alphabet[0];
  return password;
}

function seedPassword(): { password: string; generated: boolean } {
  const fromEnv = process.env.MNEMO_PASSWORD;
  if (fromEnv) {
    if (fromEnv.length < 12 || Buffer.byteLength(fromEnv, 'utf8') > 72) {
      throw new SeedError('MNEMO_PASSWORD doit contenir au moins 12 caractères et au plus 72 octets UTF-8.');
    }
    return { password: fromEnv, generated: false };
  }
  return { password: randomPassword(), generated: true };
}

type CardMatch = 'empty' | 'prefix' | 'exact' | 'different';

function matchCards(cards: ExampleCard[], expected: ExampleCard[]): CardMatch {
  if (cards.length === 0) return 'empty';
  if (cards.length > expected.length) return 'different';
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const sample = expected[index];
    if (!card || !sample || card.front !== sample.front || card.back !== sample.back || (card.frontImageUrl ?? '') !== (sample.frontImageUrl ?? '') || (card.backImageUrl ?? '') !== (sample.backImageUrl ?? '')) return 'different';
  }
  return cards.length === expected.length ? 'exact' : 'prefix';
}

async function ensureUser(): Promise<{ id: mongoose.Types.ObjectId; created: boolean; generatedPassword?: string }> {
  const existing = await User.findOne({ username: USERNAME });
  if (existing) {
    if (existing.isGuest) throw new SeedError('Le nom mnemo appartient à un profil invité. Aucun compte ni paquet modifié.');
    return { id: existing._id, created: false };
  }
  const email = seedEmail();
  if (await User.exists({ email })) throw new SeedError('MNEMO_EMAIL est déjà utilisé par un autre compte. Aucun compte créé.');
  const { password, generated } = seedPassword();
  try {
    const user = await User.create({
      isGuest: false,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      username: USERNAME,
      displayName: DISPLAY_NAME,
      bio: BIO,
      emailVerified: true,
    });
    return { id: user._id, created: true, generatedPassword: generated ? password : undefined };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      const again = await User.findOne({ username: USERNAME });
      if (again && !again.isGuest) return { id: again._id, created: false };
      throw new SeedError('Conflit d\'unicité sur le nom ou l\'email. Relancer le script.');
    }
    throw error;
  }
}

async function retireSchoolExamples(ownerId: mongoose.Types.ObjectId): Promise<number> {
  const decks = await Deck.find({
    owner: ownerId,
    title: { $in: retiredSchoolTitles },
    description: /^Paquet d'exemple/,
  }).select('_id');
  if (!decks.length) return 0;
  await deleteDecks(decks.map(deck => deck._id));
  return decks.length;
}

async function publish(deck: InstanceType<typeof Deck>) {
  if (!(await Card.exists({ deck: deck._id }))) throw new SeedError(`Le paquet « ${deck.title} » n'a aucune carte.`);
  await Publication.updateOne({ deck: deck._id }, { $setOnInsert: { owner: deck.owner } }, { upsert: true });
  if (deck.visibility !== 'public') {
    deck.visibility = 'public';
    await deck.save();
  }
}

type DeckResult = 'created' | 'completed' | 'present' | 'customized';

async function ensureDeck(ownerId: mongoose.Types.ObjectId, example: ExampleDeck): Promise<DeckResult> {
  let deck = await Deck.findOne({ owner: ownerId, title: example.title });
  if (!deck) {
    deck = await Deck.create({
      owner: ownerId,
      title: example.title,
      description: example.description,
      subject: example.subject,
      level: example.level,
      visibility: 'private',
    });
    await Card.insertMany(example.cards.map((card, position) => ({
      deck: deck!._id, owner: ownerId, front: card.front, back: card.back,
      frontImageUrl: card.frontImageUrl ?? '', backImageUrl: card.backImageUrl ?? '', position,
    })));
    await publish(deck);
    return 'created';
  }
  if (deck.description !== example.description) return 'customized';
  const stored = await Card.find({ deck: deck._id }).sort({ position: 1, _id: 1 }).select('front back frontImageUrl backImageUrl position');
  const match = matchCards(stored.map(card => ({ front: card.front, back: card.back, frontImageUrl: card.frontImageUrl || '', backImageUrl: card.backImageUrl || '' })), example.cards);
  if (match === 'different') return 'customized';
  if (match === 'empty' || match === 'prefix') {
    const start = stored.at(-1)?.position ?? -1;
    await Card.insertMany(example.cards.slice(stored.length).map((card, index) => ({
      deck: deck!._id, owner: ownerId, front: card.front, back: card.back,
      frontImageUrl: card.frontImageUrl ?? '', backImageUrl: card.backImageUrl ?? '', position: start + 1 + index,
    })));
    await publish(deck);
    return 'completed';
  }
  const published = await Publication.exists({ deck: deck._id });
  if (deck.visibility === 'public' && published) return 'present';
  await publish(deck);
  return 'completed';
}

async function main() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new SeedError('MONGODB_URI est requis.');
  const dbName = process.env.MONGODB_DB?.trim() || undefined;
  const threshold = minUsers();
  await getMongo({ MONGODB_URI: uri, MONGODB_DB: dbName });
  await initializeIndexes();
  const admin = mongoose.connection.db?.admin();
  if (!admin) throw new SeedError('Connexion MongoDB indisponible.');
  const transactions = await detectTransactions(admin, transactionsMode());
  const execute = createMutationExecutor(transactions);
  const user = await ensureUser();
  if (user.created) {
    console.log(user.generatedPassword
      ? `Compte mnemo créé. Mot de passe généré, affiché une seule fois : ${user.generatedPassword}`
      : 'Compte mnemo créé avec MNEMO_PASSWORD.');
  } else {
    const refreshed = await User.updateOne({ _id: user.id, bio: PREVIOUS_BIO }, { $set: { bio: BIO } });
    console.log(refreshed.modifiedCount ? 'Compte mnemo déjà présent, bio mise à jour.' : 'Compte mnemo déjà présent.');
  }
  const others = await User.countDocuments({ isGuest: false, _id: { $ne: user.id } });
  if (others >= threshold) {
    console.log(`${others} compte(s) permanent(s) hors mnemo, seuil ${threshold}. Aucun paquet d'exemple ajouté.`);
    return;
  }
  const retired = await execute(() => retireSchoolExamples(user.id));
  if (retired) console.log(`${retired} paquet(s) scolaire(s) d'exemple retiré(s).`);
  const counts: Record<DeckResult, number> = { created: 0, completed: 0, present: 0, customized: 0 };
  for (const example of examples) {
    const result = await execute(() => ensureDeck(user.id, example));
    counts[result] += 1;
  }
  console.log(`Paquets d'exemple : ${counts.created} créé(s), ${counts.completed} complété(s), ${counts.present} déjà public(s), ${counts.customized} laissé(s) tel(s) quel(s).`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof SeedError ? error.message : 'Échec du script. Vérifier la connexion, sans recopier l\'URI.');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
