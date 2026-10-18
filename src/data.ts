import mongoose from 'mongoose';
import { Card, Chapter, Course, Deck, Like, Publication, Saved, StudySession } from './models.js';
import { HttpError, ownerFields } from './http.js';

// Les transactions protègent aussi les invariants publication/carte lors d'écritures concurrentes.
mongoose.set('transactionAsyncLocalStorage', true);
export type MutationExecutor = <T>(fn: () => Promise<T>) => Promise<T>;
// Partagée par connexion, même entre plusieurs createApp. Jamais de mode global mutable.
const standaloneQueues = new WeakMap<object, Promise<void>>();
export function createMutationExecutor(transactions = true, connection: Pick<mongoose.Connection, 'transaction'> = mongoose.connection): MutationExecutor {
  if (transactions) return fn => connection.transaction(fn);
  return fn => {
    const previous = standaloneQueues.get(connection) ?? Promise.resolve();
    const result = previous.then(fn);
    // Une erreur libère la file, sans réexécuter fn ni simuler un rollback.
    standaloneQueues.set(connection, result.then(() => undefined, () => undefined));
    return result;
  };
}
export async function ownedCourse(id: string, userId?: string) {
  const item = await Course.findById(id);
  if (!item || String(item.owner) !== userId) throw new HttpError(404, 'Cours introuvable.');
  return item;
}
export async function ownedChapter(id: string, userId?: string) {
  const item = await Chapter.findById(id);
  if (!item || String(item.owner) !== userId) throw new HttpError(404, 'Chapitre introuvable.');
  return item;
}
export async function accessibleDeck(id: string, userId?: string, ownerOnly = false) {
  const item = await Deck.findById(id);
  if (!item || ((ownerOnly || item.visibility === 'private') && String(item.owner) !== userId)) throw new HttpError(404, 'Paquet introuvable.');
  return item;
}
export async function ownedCard(id: string, userId?: string) {
  const item = await Card.findById(id);
  if (!item || String(item.owner) !== userId) throw new HttpError(404, 'Carte introuvable.');
  return item;
}
export async function writableDeck(id: string, userId?: string, ownerOnly = true) {
  return accessibleDeck(id, userId, ownerOnly);
}
export async function lockDeck(deck: InstanceType<typeof Deck>) {
  // Tous les changements cartes/social prennent le même verrou d'écriture MongoDB.
  // Appelé après validation ; en standalone, la file de l'exécuteur sérialise déjà.
  await Deck.updateOne({ _id: deck._id }, { $currentDate: { updatedAt: true } });
}
export async function removePublication(deckId: unknown) {
  const publications = await Publication.find({ deck: deckId }).select('_id');
  await Like.deleteMany({ publication: { $in: publications.map(p => p._id) } });
  await Publication.deleteMany({ deck: deckId });
}
export async function syncPublication(deck: InstanceType<typeof Deck>) {
  if (deck.visibility === 'public') {
    if (!(await Card.exists({ deck: deck._id }))) throw new HttpError(400, 'Un paquet public doit contenir au moins une carte.');
    await Publication.updateOne({ deck: deck._id }, { $setOnInsert: { owner: deck.owner } }, { upsert: true });
  } else {
    await removePublication(deck._id);
    await Saved.deleteMany({ deck: deck._id });
  }
}
export async function deleteDecks(ids: unknown[]) {
  // Retirer la visibilité avant tout nettoyage, y compris si celui-ci échoue.
  await Deck.updateMany({ _id: { $in: ids } }, { $set: { visibility: 'private' } });
  const publications = await Publication.find({ deck: { $in: ids } }).select('_id');
  await Like.deleteMany({ publication: { $in: publications.map(p => p._id) } });
  await Publication.deleteMany({ deck: { $in: ids } });
  await Saved.deleteMany({ deck: { $in: ids } });
  await StudySession.deleteMany({ deck: { $in: ids } });
  await Card.deleteMany({ deck: { $in: ids } });
  await Deck.deleteMany({ _id: { $in: ids } });
}
export async function deleteChapters(ids: unknown[]) {
  const decks = await Deck.find({ chapter: { $in: ids } }).select('_id');
  await deleteDecks(decks.map(d => d._id));
  await Chapter.deleteMany({ _id: { $in: ids } });
}
export async function deckView(id: unknown, includeCards = false, filter: mongoose.FilterQuery<InstanceType<typeof Deck>> = {}) {
  const deck = await Deck.findOne({ _id: id, ...filter }).populate('owner', ownerFields).lean();
  if (!deck) throw new HttpError(404, 'Paquet introuvable.');
  const cardCount = await Card.countDocuments({ deck: id });
  return { ...deck, cardCount, ...(includeCards ? { cards: await Card.find({ deck: id }).sort({ position: 1, _id: 1 }).lean() } : {}) };
}