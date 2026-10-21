import { Router, type Request, type RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Types } from 'mongoose';
import type { Config } from './config.js';
import { authenticated } from './auth.js';
import { Card, Chapter, Course, Deck, Like, Publication, Saved, StudySession, User } from './models.js';
import { description, HttpError, idSchema, list, ownerFields, pagination, param, position, publicUser, title, url } from './http.js';
import { accessibleDeck, createMutationExecutor, deckView, deleteChapters, deleteDecks, lockDeck, ownedCard, ownedChapter, ownedCourse, syncPublication, type MutationExecutor, writableDeck } from './data.js';

const courseInput = z.object({ title, description: description.optional(), color: z.string().max(32).optional(), icon: z.string().max(80).optional() }).strict();
const chapterInput = z.object({ title, description: description.optional(), position: position.optional() }).strict();
const deckInput = z.object({
  title, description: description.optional(), chapter: idSchema.nullable().optional(),
  subject: z.string().trim().max(100).optional(), level: z.string().trim().max(100).optional(),
  visibility: z.enum(['private', 'unlisted', 'public']).optional(), coverUrl: url.optional(),
}).strict();
const nonempty = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => schema.partial().refine(v => Object.keys(v).length > 0, 'Au moins un champ est requis.');
async function associateChapter(chapter: string | null | undefined, userId?: string) {
  if (chapter) {
    const record = await ownedChapter(chapter, userId);
    await ownedCourse(String(record.course), userId);
    await Chapter.updateOne({ _id: record._id }, { $currentDate: { updatedAt: true } });
  }
}
async function views(ids: unknown[], filter: Parameters<typeof deckView>[2] = { visibility: 'public' }) {
  const result = [];
  // Pas de Promise.all au sein d'une transaction MongoDB.
  for (const id of ids) {
    try { result.push(await deckView(id, false, filter)); }
    catch (error) { if (!(error instanceof HttpError && error.status === 404)) throw error; }
  }
  return result;
}

export function apiRouter(config: Pick<Config, 'CARD_TEXT_MAX_LENGTH'>, execute: MutationExecutor = createMutationExecutor()) {
  const router = Router();
  const mutation = (action: (req: Request) => Promise<unknown>, status = 200): RequestHandler => async (req, res) => {
    const result = await execute(() => action(req));
    if (status === 204) res.sendStatus(204);
    else res.status(status).json(result);
  };
  const cardTextMaxLength = config.CARD_TEXT_MAX_LENGTH;
  const cardText = z.string().trim().max(cardTextMaxLength);
  const cardShape = z.object({
    front: cardText.optional(), back: cardText.optional(),
    frontImageUrl: url.optional(), backImageUrl: url.optional(), position: position.optional(),
  }).strict();
  const faceReady = (face?: string, image?: string) => Boolean(face?.trim() || image?.trim());
  const cardInput = cardShape.superRefine((value, ctx) => {
    if (!faceReady(value.front, value.frontImageUrl)) ctx.addIssue({ code: 'custom', path: ['front'], message: 'La question doit contenir un texte ou une URL d\'image.' });
    if (!faceReady(value.back, value.backImageUrl)) ctx.addIssue({ code: 'custom', path: ['back'], message: 'La réponse doit contenir un texte ou une URL d\'image.' });
  });

  router.get('/config', (_req, res) => res.json({ cardTextMaxLength }));

  router.get('/profiles/:username', async (req, res) => {
    const username = z.string().regex(/^[a-z0-9_]{3,24}$/).parse(req.params.username);
    const user = await User.findOne({ username });
    if (!user) throw new HttpError(404, 'Profil introuvable.');
    const { page, limit, skip } = pagination(req);
    const decks = await Deck.find({ owner: user._id, visibility: 'public' }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit + 1).select('_id');
    const deckList = list(await views(decks.map(d => d._id)), page, limit);
    res.json({ ...publicUser(user), publicDeckCount: await Deck.countDocuments({ owner: user._id, visibility: 'public' }), followerCount: 0, followingCount: 0, decks: deckList.items, page, hasMore: deckList.hasMore });
  });
  router.patch('/profiles/:username', authenticated, mutation(async req => {
    const username = z.string().regex(/^[a-z0-9_]{3,24}$/).parse(req.params.username);
    const user = await User.findOne({ username });
    if (!user) throw new HttpError(404, 'Profil introuvable.');
    if (user.id !== req.userId) throw new HttpError(403, 'Ce profil ne vous appartient pas.');
    const input = nonempty(z.object({ displayName: z.string().trim().min(1).max(80), bio: z.string().trim().max(1000), avatarUrl: url }).strict()).parse(req.body);
    const { page, limit, skip } = pagination(req);
    Object.assign(user, input);
    await user.save();
    const decks = await Deck.find({ owner: user._id, visibility: 'public' }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit + 1);
    const deckList = list(await views(decks.map(d => d._id)), page, limit);
    return { ...publicUser(user), publicDeckCount: await Deck.countDocuments({ owner: user._id, visibility: 'public' }), followerCount: 0, followingCount: 0, decks: deckList.items, page, hasMore: deckList.hasMore };
  }));

  router.get('/courses', authenticated, async (req, res) => {
    const { page, limit, skip } = pagination(req);
    res.json(list(await Course.find({ owner: req.userId }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit + 1).lean(), page, limit));
  });
  router.post('/courses', authenticated, mutation(async req => Course.create({ ...courseInput.parse(req.body), owner: req.userId }), 201));
  router.patch('/courses/:id', authenticated, mutation(async req => {
    const course = await ownedCourse(param(req), req.userId);
    Object.assign(course, nonempty(courseInput).parse(req.body));
    return course.save();
  }));
  router.delete('/courses/:id', authenticated, mutation(async req => {
    const course = await ownedCourse(param(req), req.userId);
    const chapters = await Chapter.find({ course: course._id }).select('_id');
    await deleteChapters(chapters.map(c => c._id));
    await Course.deleteOne({ _id: course._id });
  }, 204));
  router.get('/courses/:id/chapters', authenticated, async (req, res) => {
    const course = await ownedCourse(param(req), req.userId);
    const { page, limit, skip } = pagination(req);
    res.json(list(await Chapter.find({ course: course._id, owner: req.userId }).sort({ position: 1, _id: 1 }).skip(skip).limit(limit + 1).lean(), page, limit));
  });
  router.post('/courses/:id/chapters', authenticated, mutation(async req => {
    const input = chapterInput.parse(req.body);
    const course = await ownedCourse(param(req), req.userId);
    await Course.updateOne({ _id: course._id }, { $currentDate: { updatedAt: true } });
    return Chapter.create({ ...input, course: course._id, owner: req.userId });
  }, 201));
  router.patch('/chapters/:id', authenticated, mutation(async req => {
    const chapter = await ownedChapter(param(req), req.userId);
    Object.assign(chapter, nonempty(chapterInput).parse(req.body));
    return chapter.save();
  }));
  router.delete('/chapters/:id', authenticated, mutation(async req => {
    const chapter = await ownedChapter(param(req), req.userId);
    await deleteChapters([chapter._id]);
  }, 204));

  router.get('/decks', authenticated, async (req, res) => {
    const { page, limit, skip } = pagination(req);
    const decks = await Deck.find({ owner: req.userId }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit + 1).select('_id');
    res.json(list(await views(decks.map(d => d._id), { owner: req.userId }), page, limit));
  });
  router.post('/decks', authenticated, mutation(async req => {
    const input = deckInput.parse(req.body);
    if (input.visibility === 'public') throw new HttpError(400, 'Ajoutez une carte avant de publier.');
    await associateChapter(input.chapter, req.userId);
    const deck = await Deck.create({ ...input, chapter: input.chapter ?? undefined, owner: req.userId });
    return deckView(deck._id, true);
  }, 201));
  router.get('/decks/:id', async (req, res) => {
    const deck = await accessibleDeck(param(req), req.userId);
    res.json(await deckView(deck._id, true, { $or: [{ visibility: { $in: ['public', 'unlisted'] } }, ...(req.userId ? [{ owner: req.userId }] : [])] }));
  });
  router.patch('/decks/:id', authenticated, mutation(async req => {
    const input = nonempty(deckInput).parse(req.body);
    const deck = await writableDeck(param(req), req.userId);
    Object.assign(deck, input);
    if (input.chapter === null) deck.set('chapter', undefined);
    // Vérifier avant toute écriture, notamment avant de toucher le chapitre.
    await deck.validate();
    if (deck.visibility === 'public' && !(await Card.exists({ deck: deck._id }))) throw new HttpError(400, 'Un paquet public doit contenir au moins une carte.');
    await associateChapter(input.chapter, req.userId);
    await lockDeck(deck);
    if (deck.visibility === 'public') {
      await syncPublication(deck);
      await deck.save(); // Visibilité publique en dernier.
    } else {
      await deck.save(); // Visibilité retirée avant suppression des relations.
      await syncPublication(deck);
    }
    return deckView(deck._id, true);
  }));
  router.delete('/decks/:id', authenticated, mutation(async req => {
    const deck = await writableDeck(param(req), req.userId);
    await deleteDecks([deck._id]);
  }, 204));
  router.post('/decks/:id/cards', authenticated, mutation(async req => {
    const input = cardInput.parse(req.body);
    const deck = await writableDeck(param(req), req.userId);
    await lockDeck(deck);
    const last = await Card.findOne({ deck: deck._id }).sort({ position: -1 });
    return Card.create({ ...input, position: input.position ?? (last ? last.position + 1 : 0), deck: deck._id, owner: req.userId });
  }, 201));
  router.post('/cards/quick', authenticated, mutation(async req => {
    const input = cardInput.safeExtend({ deck: idSchema.optional() }).parse(req.body);
    const { deck: deckId, ...card } = input;
    let deck = deckId
      ? await writableDeck(deckId, req.userId)
      : await Deck.findOne({ owner: req.userId, quickDefault: true }).select('+quickDefault');
    if (!deck) {
      deck = await Deck.findOneAndUpdate(
        { owner: req.userId, quickDefault: true },
        { $setOnInsert: { owner: req.userId, title: 'Général', description: 'Mes cartes créées rapidement.', subject: 'Général', visibility: 'private', quickDefault: true } },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
      ).select('+quickDefault');
    }
    await lockDeck(deck);
    const last = await Card.findOne({ deck: deck._id }).sort({ position: -1 });
    const created = await Card.create({ ...card, position: last ? last.position + 1 : 0, deck: deck._id, owner: req.userId });
    return { card: created, deck: { _id: deck._id, title: deck.title } };
  }, 201));
  router.patch('/cards/:id', authenticated, mutation(async req => {
    const input = nonempty(cardShape).parse(req.body);
    const card = await ownedCard(param(req), req.userId);
    const deck = await writableDeck(String(card.deck), req.userId);
    await lockDeck(deck);
    const next = {
      front: input.front ?? card.front, back: input.back ?? card.back,
      frontImageUrl: input.frontImageUrl ?? card.frontImageUrl ?? '', backImageUrl: input.backImageUrl ?? card.backImageUrl ?? '',
    };
    if (('front' in input || 'frontImageUrl' in input) && !faceReady(next.front, next.frontImageUrl)) throw new HttpError(400, 'La question doit contenir un texte ou une URL d\'image.');
    if (('back' in input || 'backImageUrl' in input) && !faceReady(next.back, next.backImageUrl)) throw new HttpError(400, 'La réponse doit contenir un texte ou une URL d\'image.');
    Object.assign(card, input);
    return card.save();
  }));
  router.delete('/cards/:id', authenticated, mutation(async req => {
    const card = await ownedCard(param(req), req.userId);
    const deck = await writableDeck(String(card.deck), req.userId);
    await lockDeck(deck);
    if (deck.visibility === 'public' && !(await Card.exists({ deck: deck._id, _id: { $ne: card._id } }))) {
      deck.visibility = 'private';
      await deck.save();
    }
    await card.deleteOne();
    if (deck.visibility !== 'public') await syncPublication(deck);
  }, 204));
  router.put('/decks/:id/cards/order', authenticated, mutation(async req => {
    const { ids } = z.object({ ids: z.array(idSchema).max(100000) }).strict().parse(req.body);
    const deck = await writableDeck(param(req), req.userId);
    const cards = await Card.find({ deck: deck._id }).select('_id');
    const wanted = new Set(ids);
    if (wanted.size !== ids.length || cards.length !== ids.length || cards.some(c => !wanted.has(c.id))) throw new HttpError(400, 'Les identifiants doivent être une permutation exacte des cartes du paquet.');
    await lockDeck(deck);
    for (const [index, id] of ids.entries()) await Card.updateOne({ _id: id, deck: deck._id }, { $set: { position: index } });
    return deckView(deck._id, true);
  }));
  router.post('/decks/:id/publish', authenticated, mutation(async req => {
    const deck = await writableDeck(param(req), req.userId);
    if (!(await Card.exists({ deck: deck._id }))) throw new HttpError(400, 'Un paquet public doit contenir au moins une carte.');
    await lockDeck(deck);
    deck.visibility = 'public';
    await syncPublication(deck);
    await deck.save();
    return Publication.findOne({ deck: deck._id }).lean();
  }));

  router.get('/feed', async (req, res) => {
    const { page, limit, skip } = pagination(req);
    const { sort, q } = z.object({ sort: z.enum(['recent', 'popular']).default('recent'), q: z.string().trim().max(200).default('') }).parse(req.query);
    // Agrégation avant pagination : classement popular global, jamais page par page.
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pipeline: import('mongoose').PipelineStage[] = [
      { $lookup: { from: 'decks', localField: 'deck', foreignField: '_id', as: 'deck' } }, { $unwind: '$deck' },
      { $match: { 'deck.visibility': 'public' } },
      { $lookup: { from: 'users', localField: 'owner', foreignField: '_id', as: 'owner' } }, { $unwind: '$owner' },
      ...(q ? [{ $match: { $or: ['deck.title', 'deck.description', 'owner.username', 'owner.displayName'].map(field => ({ [field]: { $regex: escaped, $options: 'i' } })) } }] : []),
      { $lookup: { from: 'likes', let: { publicationId: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$publication', '$$publicationId'] } } }, { $count: 'count' }], as: 'likes' } },
      { $set: { likeCount: { $ifNull: [{ $arrayElemAt: ['$likes.count', 0] }, 0] } } },
      { $sort: sort === 'popular' ? { likeCount: -1, createdAt: -1, _id: -1 } : { createdAt: -1, _id: -1 } },
      { $skip: skip }, { $limit: limit + 1 },
      { $project: { _id: 1, createdAt: 1, deck: 1, likeCount: 1, 'owner._id': 1, 'owner.username': 1, 'owner.displayName': 1, 'owner.avatarUrl': 1, 'owner.isGuest': { $ifNull: ['$owner.isGuest', false] } } },
    ];
    const publications = await Publication.aggregate(pipeline);
    const items = [];
    for (const publication of publications) {
      const cardCount = await Card.countDocuments({ deck: publication.deck._id });
      const preview = await Card.findOne({ deck: publication.deck._id }).sort({ position: 1, _id: 1 }).select('front back frontImageUrl backImageUrl -_id').lean();
      items.push({ ...publication, deck: { ...publication.deck, cardCount, preview },
        liked: Boolean(req.userId && await Like.exists({ user: req.userId, publication: publication._id })),
        saved: Boolean(req.userId && await Saved.exists({ user: req.userId, deck: publication.deck._id })),
      });
    }
    res.json(list(items, page, limit));
  });
  router.put('/publications/:id/like', authenticated, mutation(async req => {
    const { liked } = z.object({ liked: z.boolean() }).strict().parse(req.body);
    const publication = await Publication.findById(param(req));
    if (!publication) throw new HttpError(404, 'Publication introuvable.');
    const deck = await writableDeck(String(publication.deck), req.userId, false);
    if (deck.visibility !== 'public') throw new HttpError(404, 'Publication introuvable.');
    await lockDeck(deck);
    if (liked) await Like.updateOne({ user: req.userId, publication: publication._id }, { $setOnInsert: { user: req.userId, publication: publication._id } }, { upsert: true });
    else await Like.deleteOne({ user: req.userId, publication: publication._id });
    return { liked, likeCount: await Like.countDocuments({ publication: publication._id }) };
  }));
  router.get('/saved', authenticated, async (req, res) => {
    const { page, limit, skip } = pagination(req);
    const saved = await Saved.aggregate([
      { $match: { user: new Types.ObjectId(req.userId) } },
      { $lookup: { from: 'decks', localField: 'deck', foreignField: '_id', as: 'deck' } }, { $unwind: '$deck' },
      { $match: { 'deck.visibility': 'public' } }, { $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit + 1 },
      { $project: { deck: '$deck._id' } },
    ]);
    res.json(list(await views(saved.map(s => s.deck)), page, limit));
  });
  router.get('/saved-static', authenticated, async (req, res) => {
    const items = await Saved.find({ user: req.userId, staticSlug: { $type: 'string' } }).sort({ createdAt: -1, _id: -1 }).select('staticSlug -_id').lean();
    res.json({ slugs: items.map(item => item.staticSlug) });
  });
  router.put('/saved-static/:slug', authenticated, mutation(async req => {
    const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).parse(req.params.slug);
    const { saved } = z.object({ saved: z.boolean() }).strict().parse(req.body);
    const syntheticDeckId = new Types.ObjectId(createHash('sha256').update(`static:${slug}`).digest('hex').slice(0, 24));
    if (saved) await Saved.updateOne({ user: req.userId, deck: syntheticDeckId }, { $setOnInsert: { user: req.userId, deck: syntheticDeckId, staticSlug: slug } }, { upsert: true });
    else await Saved.deleteOne({ user: req.userId, deck: syntheticDeckId, staticSlug: slug });
    return { saved };
  }));
  router.put('/decks/:id/save', authenticated, mutation(async req => {
    const { saved } = z.object({ saved: z.boolean() }).strict().parse(req.body);
    const deck = await writableDeck(param(req), req.userId, false);
    if (deck.visibility !== 'public') throw new HttpError(404, 'Paquet public introuvable.');
    await lockDeck(deck);
    if (saved) await Saved.updateOne({ user: req.userId, deck: deck._id }, { $setOnInsert: { user: req.userId, deck: deck._id } }, { upsert: true });
    else await Saved.deleteOne({ user: req.userId, deck: deck._id });
    return { saved };
  }));
  router.post('/decks/:id/study-sessions', authenticated, mutation(async req => {
    const count = z.number().int().min(0).max(100000).optional();
    const input = z.object({
      cardsVisited: z.number().int().min(1).max(100000), durationSeconds: z.number().int().min(1).max(86400),
      knownCount: count, doubtCount: count, unknownCount: count,
    }).strict().refine(value => (value.knownCount ?? 0) + (value.doubtCount ?? 0) + (value.unknownCount ?? 0) <= value.cardsVisited, 'Les repères ne peuvent pas dépasser les cartes parcourues.').parse(req.body);
    const deck = await writableDeck(param(req), req.userId, false);
    if (!(await Card.exists({ deck: deck._id }))) throw new HttpError(400, 'Impossible de réviser un paquet vide.');
    await lockDeck(deck);
    return StudySession.create({ ...input, user: req.userId, deck: deck._id });
  }, 201));
  router.get('/study-sessions', authenticated, async (req, res) => {
    const { page, limit, skip } = pagination(req);
    // Le paquet n'est pas peuplé : un ancien accès public ne donne pas accès à son contenu désormais privé.
    res.json(list(await StudySession.find({ user: req.userId }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit + 1).lean(), page, limit));
  });
  return router;
}
