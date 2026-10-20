import { createHash } from 'node:crypto';
import mongoose, { Schema } from 'mongoose';
import { CARD_TEXT_MAX_LENGTH } from './limits.js';

const ref = (model: string, required = true): { type: typeof Schema.Types.ObjectId; ref: string; required: boolean; index: boolean } => ({ type: Schema.Types.ObjectId, ref: model, required, index: true });
const text = (max: number, required = false) => ({ type: String, trim: true, maxlength: max, required });
function permanentIdentity(this: { isGuest?: boolean }) { return !this.isGuest; }
const userSchema = new Schema({
  isGuest: { type: Boolean, default: false, required: true },
  email: { ...text(254), lowercase: true, select: false },
  passwordHash: { type: String, required: permanentIdentity, select: false },
  recoverySecretHash: { type: String, select: false, match: /^[a-f0-9]{64}$/ },
  guestTokenHash: { type: String, select: false, unique: true, sparse: true },
  username: { ...text(24, true), match: /^[a-z0-9_]{3,24}$/, unique: true },
  displayName: text(80, true), bio: { ...text(1000), default: '' }, avatarUrl: { ...text(2048), default: '' },
  emailVerified: { type: Boolean, default: false },
  authVersion: { type: Number, default: 0, select: false },
  resetTokenHash: { type: String, select: false }, resetExpiresAt: { type: Date, select: false },
  verificationTokenHash: { type: String, select: false }, verificationExpiresAt: { type: Date, select: false },
}, { timestamps: true });
userSchema.index({ email: 1 }, { name: 'email_string_unique', unique: true, partialFilterExpression: { email: { $type: 'string' } } });
export const User = mongoose.model('User', userSchema);
export const Course = mongoose.model('Course', new Schema({
  owner: ref('User'), title: text(160, true), description: { ...text(4000), default: '' },
  color: { ...text(32), default: '' }, icon: { ...text(80), default: '' },
}, { timestamps: true }));
export const Chapter = mongoose.model('Chapter', new Schema({
  course: ref('Course'), owner: ref('User'), title: text(160, true),
  description: { ...text(4000), default: '' }, position: { type: Number, min: 0, default: 0, validate: Number.isInteger },
}, { timestamps: true }));
export const Deck = mongoose.model('Deck', new Schema({
  owner: ref('User'), chapter: ref('Chapter', false), title: text(160, true),
  description: { ...text(4000), default: '' }, subject: { ...text(100), default: '' }, level: { ...text(100), default: '' },
  visibility: { type: String, enum: ['private', 'unlisted', 'public'], default: 'private', index: true },
  coverUrl: { ...text(2048), default: '' },
  quickDefault: { type: Boolean, default: false, select: false },
}, { timestamps: true }));
Deck.schema.index({ owner: 1, createdAt: -1 });
Deck.schema.index({ owner: 1, quickDefault: 1 }, { unique: true, partialFilterExpression: { quickDefault: true } });
function httpImage(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch { return false; }
}
const cardSchema = new Schema({
  deck: ref('Deck'), owner: ref('User'),
  front: { ...text(CARD_TEXT_MAX_LENGTH), default: '' }, back: { ...text(CARD_TEXT_MAX_LENGTH), default: '' },
  frontImageUrl: { ...text(2048), default: '' }, backImageUrl: { ...text(2048), default: '' },
  position: { type: Number, min: 0, default: 0, validate: Number.isInteger },
}, { timestamps: true });
cardSchema.pre('validate', function () {
  for (const [label, textKey, imageKey] of [['question', 'front', 'frontImageUrl'], ['réponse', 'back', 'backImageUrl']] as const) {
    const face = String(this.get(textKey) ?? '').trim();
    const image = String(this.get(imageKey) ?? '').trim();
    if (image && !httpImage(image)) this.invalidate(imageKey, 'URL HTTP(S) requise.');
    if (!face && !httpImage(image)) this.invalidate(textKey, `La ${label} doit contenir un texte ou une URL d'image.`);
  }
});
cardSchema.index({ deck: 1, position: 1, _id: 1 });
export const Card = mongoose.model('Card', cardSchema);
const publicationSchema = new Schema({ deck: { ...ref('Deck'), unique: true }, owner: ref('User') }, { timestamps: { createdAt: true, updatedAt: false } });
export const Publication = mongoose.model('Publication', publicationSchema);
const likeSchema = new Schema({ user: ref('User'), publication: ref('Publication') }, { timestamps: true });
likeSchema.index({ user: 1, publication: 1 }, { unique: true });
export const Like = mongoose.model('Like', likeSchema);
const savedSchema = new Schema({ user: ref('User'), deck: ref('Deck') }, { timestamps: true });
savedSchema.index({ user: 1, deck: 1 }, { unique: true });
export const Saved = mongoose.model('Saved', savedSchema);
export const StudySession = mongoose.model('StudySession', new Schema({
  user: ref('User'), deck: ref('Deck'),
  cardsVisited: { type: Number, required: true, min: 1, max: 100000, validate: Number.isInteger },
  durationSeconds: { type: Number, required: true, min: 1, max: 86400, validate: Number.isInteger },
  knownCount: { type: Number, default: 0, min: 0, max: 100000, validate: Number.isInteger },
  doubtCount: { type: Number, default: 0, min: 0, max: 100000, validate: Number.isInteger },
  unknownCount: { type: Number, default: 0, min: 0, max: 100000, validate: Number.isInteger },
}, { timestamps: true }));
StudySession.schema.index({ user: 1, createdAt: -1 });
export async function initializeIndexes() {
  // Ne jamais supprimer implicitement un index de production (ni utiliser syncIndexes).
  // Le script de migration explicite s'exécute API arrêtée avant ce démarrage.
  const db = mongoose.connection.db;
  if (db && (await db.listCollections({ name: User.collection.name }).toArray()).length) {
    const indexes = await User.collection.indexes();
    if (indexes.some(index => Object.keys(index.key).length === 1 && index.key.email === 1 && index.unique && !index.partialFilterExpression)) {
      throw Object.assign(new Error('Index email historique incompatible avec les invités : exécuter la migration email en maintenance (voir README). Aucun index supprimé.'), { code: 'LEGACY_EMAIL_INDEX' });
    }
  }
  const legacy = await User.collection.find({ recoverySecret: { $type: 'string' } }).project({ recoverySecret: 1 }).toArray();
  for (const doc of legacy) {
    if (typeof doc.recoverySecret !== 'string' || !/^[a-f0-9]{64}$/.test(doc.recoverySecret)) continue;
    await User.collection.updateOne({ _id: doc._id, recoverySecret: doc.recoverySecret }, {
      $set: { recoverySecretHash: createHash('sha256').update(doc.recoverySecret).digest('hex') },
      $unset: { recoverySecret: '' },
    });
  }
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
}