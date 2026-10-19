import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Card, Chapter, Course, Deck, initializeIndexes, Like, Publication, Saved, StudySession, User } from '../src/models.js';
import { detectTransactions } from '../src/topology.js';
import * as mail from '../src/mail.js';
import { migrateEmailIndex } from '../src/email-index.js';

describe.each([true, false])('API isolée : transactions=%s', transactions => {
let mongo: MongoMemoryReplSet | MongoMemoryServer;
let service: ReturnType<typeof createApp>;
let alice: ReturnType<typeof request.agent>;
let bob: ReturnType<typeof request.agent>;
let aliceId: string;
const stores: ReturnType<typeof createApp>['store'][] = [];
function makeService(config: ReturnType<typeof loadConfig>) {
  // Sans options en replica set : le contrat par défaut reste transactionnel.
  const value = transactions ? createApp(config) : createApp(config, { transactions: false });
  stores.push(value.store);
  return value;
}
const password = 'MotDePasseValide!2026';
const credentials = (username: string) => ({ email: `${username}@example.com`, password, username, displayName: username.toUpperCase() });
const json = { 'Content-Type': 'application/json' };
function configuration(extra: NodeJS.ProcessEnv = {}) {
  return loadConfig({ NODE_ENV: 'test', MONGODB_URI: mongo.getUri(), SESSION_SECRET: 'test-secret-with-at-least-32-characters', AUTH_RATE_LIMIT: '1000', ...extra });
}
async function deck(agent = alice, extra = {}) {
  return (await agent.post('/api/decks').send({ title: 'Biologie', ...extra }).expect(201)).body._id as string;
}
async function card(deckId: string, agent = alice, front = 'Question') {
  return (await agent.post(`/api/decks/${deckId}/cards`).send({ front, back: 'Réponse' }).expect(201)).body._id as string;
}
async function publish(deckId: string, agent = alice) {
  await card(deckId, agent);
  return (await agent.post(`/api/decks/${deckId}/publish`).send({}).expect(200)).body._id as string;
}
function assertNoSecrets(value: unknown) {
  for (const forbidden of ['guestTokenHash', 'passwordHash', 'resetTokenHash', 'verificationTokenHash', 'authVersion', '@example.com', 'emailVerified']) expect(JSON.stringify(value)).not.toContain(forbidden);
}
beforeAll(async () => {
  // Version par défaut supportée par mongodb-memory-server sur Windows moderne (7.x).
  mongo = transactions
    ? await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
    : await MongoMemoryServer.create({ instance: { storageEngine: 'wiredTiger' } });
  await mongoose.connect(mongo.getUri());
  expect(await detectTransactions(mongoose.connection.db!.admin(), 'auto')).toBe(transactions);
  await initializeIndexes();
  service = makeService(configuration());
});
beforeEach(async () => {
  for (const model of Object.values(mongoose.models)) await model.deleteMany({});
  await mongoose.connection.collection('sessions').deleteMany({});
  alice = request.agent(service.app);
  bob = request.agent(service.app);
  aliceId = (await alice.post('/api/auth/register').send(credentials('alice')).expect(201)).body._id;
  await bob.post('/api/auth/register').send(credentials('bob')).expect(201);
});
afterAll(async () => {
  try { for (const store of stores) await store.close(); }
  finally { try { await mongoose.disconnect(); } finally { await mongo?.stop(); } }
});

describe('Authentification et sécurité HTTP', () => {
  it('retourne utilisateur direct, cookie httpOnly/sameSite et session Mongo sans secret', async () => {
    const response = await alice.get('/api/auth/me').expect(200);
    expect(response.body).toMatchObject({ _id: aliceId, username: 'alice' });
    expect(response.body.user).toBeUndefined();
    assertNoSecrets(response.body);
    expect(await mongoose.connection.collection('sessions').countDocuments()).toBe(2);
    const login = await alice.post('/api/auth/login').send({ email: 'ALICE@example.com', password }).expect(200);
    expect(login.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(login.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(await User.findById(aliceId).lean()).not.toHaveProperty('passwordHash');
    expect(await User.findById(aliceId).lean()).not.toHaveProperty('email');
    await alice.post('/api/auth/logout').send({}).expect(204);
    await alice.get('/api/auth/me').expect(401);
    await request(service.app).get('/api/auth/me').expect(401);
  });
  it('valide mots de passe, usernames, unicité, injection et mass assignment', async () => {
    await request(service.app).post('/api/auth/register').send(credentials('alice')).expect(409);
    await request(service.app).post('/api/auth/register').send({ ...credentials('other'), email: 'alice@example.com' }).expect(409);
    await request(service.app).post('/api/auth/register').send(credentials('INVALID')).expect(400);
    await request(service.app).post('/api/auth/register').send({ ...credentials('other'), password: 'court' }).expect(400);
    await request(service.app).post('/api/auth/register').send({ ...credentials('other'), password: 'é'.repeat(40) }).expect(400);
    await alice.post('/api/auth/login').send({ email: 'alice@example.com', password: 'incorrect' }).expect(401);
    await alice.post('/api/auth/login').send({ email: { $ne: null }, password }).expect(400);
    await alice.post('/api/decks').send({ title: 'Injection', owner: aliceId }).expect(400);
  });
  it('refuse Origin hostile/null, exige JSON et limite CORS à une origine exacte', async () => {
    await alice.post('/api/courses').set('Origin', 'https://evil.example').send({ title: 'Non' }).expect(403);
    await alice.post('/api/courses').set('Origin', 'null').send({ title: 'Non' }).expect(403);
    await alice.post('/api/courses').type('form').send({ title: 'Non' }).expect(415);
    await alice.post('/api/courses').set(json).send('{bad json').expect(400);
    const response = await alice.post('/api/courses').set('Origin', 'http://localhost:5173').send({ title: 'Oui' }).expect(201);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    await request(service.app).options('/api/decks').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'POST').expect(204);
    await alice.get('/api/decks/not-an-id').expect(400);
    await alice.get('/api/decks?page=0').expect(400);
    await alice.get('/api/feed?limit=101').expect(400);
  });
  it('limite les tentatives auth avec réponse JSON', async () => {
    const limited = makeService(configuration({ AUTH_RATE_LIMIT: '1' }));
    await request(limited.app).post('/api/auth/login').send({ email: 'absent@example.com', password }).expect(401);
    const response = await request(limited.app).post('/api/auth/login').send({ email: 'absent@example.com', password }).expect(429);
    expect(response.body.message).toBeTypeOf('string');
  });
  it('reset hashé à usage unique, expiration et invalidation de toutes les sessions', async () => {
    const other = request.agent(service.app);
    await other.post('/api/auth/login').send({ email: 'alice@example.com', password }).expect(200);
    const response = await request(service.app).post('/api/auth/forgot-password').send({ email: 'alice@example.com' }).expect(200);
    const token = new URL(response.body.devResetUrl).searchParams.get('token')!;
    const stored = await User.findById(aliceId).select('+resetTokenHash +passwordHash');
    expect(stored!.resetTokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(stored!.passwordHash).not.toContain(password);
    const unknown = await request(service.app).post('/api/auth/forgot-password').send({ email: 'unknown@example.com' }).expect(200);
    expect(unknown.body.message).toBe(response.body.message);
    expect(unknown.body.devResetUrl).toBeUndefined();
    await request(service.app).post('/api/auth/reset-password').send({ token: 'a'.repeat(64), password }).expect(400);
    await request(service.app).post('/api/auth/reset-password').send({ token, password: `${password}!` }).expect(200);
    await request(service.app).post('/api/auth/reset-password').send({ token, password }).expect(400);
    await alice.get('/api/auth/me').expect(401);
    await other.get('/api/auth/me').expect(401);
    await alice.post('/api/auth/login').send({ email: 'alice@example.com', password }).expect(401);
    await alice.post('/api/auth/login').send({ email: 'alice@example.com', password: `${password}!` }).expect(200);
    const expired = await alice.post('/api/auth/forgot-password').send({ email: 'alice@example.com' }).expect(200);
    await User.updateOne({ _id: aliceId }, { $set: { resetExpiresAt: new Date(0) } });
    await alice.post('/api/auth/reset-password').send({ token: new URL(expired.body.devResetUrl).searchParams.get('token'), password }).expect(400);
  });
  it('production sans SMTP : reset désactivé identique, aucun jeton existant modifié ni mail', async () => {
    const production = makeService(configuration({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(64), FRONTEND_URL: 'https://mnemo.example', CORS_ORIGIN: 'https://mnemo.example' }));
    await User.updateOne({ _id: aliceId }, { $set: { resetTokenHash: 'a'.repeat(64), resetExpiresAt: new Date(Date.now() + 3600000) } });
    const snapshot = () => User.find().select('+resetTokenHash +resetExpiresAt +verificationTokenHash +verificationExpiresAt +passwordHash +authVersion').sort({ _id: 1 }).lean();
    const before = await snapshot();
    const send = vi.spyOn(mail, 'sendToken');
    try {
      const known = await request(production.app).post('/api/auth/forgot-password').send({ email: 'ALICE@example.com' }).expect(503);
      const absent = await request(production.app).post('/api/auth/forgot-password').send({ email: 'unknown@example.com' }).expect(503);
      const withoutToken = await request(production.app).post('/api/auth/forgot-password').send({ email: 'bob@example.com' }).expect(503);
      expect(known.body).toEqual({ message: 'La récupération de mot de passe est indisponible pour le moment.' });
      expect(absent.body).toEqual(known.body);
      expect(withoutToken.body).toEqual(known.body);
      expect(known.body).not.toHaveProperty('devResetUrl');
      expect(await snapshot()).toEqual(before);
      expect(send).not.toHaveBeenCalled();
      await request(production.app).post('/api/auth/forgot-password').send({ email: 'invalid' }).expect(400);
    } finally { send.mockRestore(); }
  });
  it('production sans SMTP : inscription, connexion et invité fonctionnent sans lien de développement', async () => {
    const production = makeService(configuration({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(64), FRONTEND_URL: 'https://mnemo.example', CORS_ORIGIN: 'https://mnemo.example', TRUST_PROXY: '1', REQUIRE_EMAIL_VERIFICATION: 'false' }));
    const send = vi.spyOn(mail, 'sendToken');
    try {
      const registered = await request(production.app).post('/api/auth/register').set('X-Forwarded-Proto', 'https').send(credentials('nosmtp')).expect(201);
      const loggedIn = await request(production.app).post('/api/auth/login').set('X-Forwarded-Proto', 'https').send({ email: 'nosmtp@example.com', password }).expect(200);
      expect(loggedIn.body._id).toBe(registered.body._id);
      const guest = await request(production.app).post('/api/auth/guest').set('X-Forwarded-Proto', 'https').send({}).expect(200);
      expect(guest.body.isGuest).toBe(true);
      for (const response of [registered, loggedIn, guest]) {
        assertNoSecrets(response.body);
        expect(response.body).not.toHaveProperty('devResetUrl');
        expect(response.body).not.toHaveProperty('devVerificationUrl');
        expect(response.headers['set-cookie'].some((cookie: string) => cookie.startsWith('flashcard.sid=') && cookie.includes('Secure'))).toBe(true);
      }
      expect(send).not.toHaveBeenCalled();
    } finally { send.mockRestore(); }
  });
  it('confirmation configurable sans session et consommation unique du jeton', async () => {
    const agent = request.agent(makeService(configuration({ REQUIRE_EMAIL_VERIFICATION: 'true' })).app);
    const response = await agent.post('/api/auth/register').send(credentials('charlie')).expect(201);
    expect(response.body.requiresVerification).toBe(true);
    expect(response.body._id).toBeUndefined();
    await agent.get('/api/auth/me').expect(401);
    await agent.post('/api/auth/login').send({ email: 'charlie@example.com', password }).expect(403);
    const token = new URL(response.body.devVerificationUrl).searchParams.get('token');
    await agent.post('/api/auth/verify-email').send({ token }).expect(200);
    await agent.post('/api/auth/verify-email').send({ token }).expect(400);
    await agent.post('/api/auth/login').send({ email: 'charlie@example.com', password }).expect(200);
    assertNoSecrets((await agent.get('/api/auth/me')).body);
  });
});

describe('Identités invitées automatiques', () => {
  function deviceCookie(response: request.Response) {
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return cookies.find(value => value.startsWith('mnemo.guest='))!.split(';')[0]!;
  }
  it('me est sans effet ; guest strict, stable, cookie serveur 400j et projections sans secrets', async () => {
    const agent = request.agent(service.app);
    await agent.get('/api/auth/me').expect(401);
    expect(await User.countDocuments()).toBe(2);
    await agent.post('/api/auth/guest').send({ userId: aliceId }).expect(400);
    const first = await agent.post('/api/auth/guest').send({}).expect(200);
    expect(first.body).toEqual({ _id: expect.any(String), username: expect.stringMatching(/^invite_[a-f0-9]{12}$/), displayName: expect.any(String), bio: '', avatarUrl: '', isGuest: true });
    const cookie = deviceCookie(first);
    const raw = cookie.split('=')[1]!;
    expect(raw).toMatch(/^[a-f0-9]{64}$/);
    const header = (first.headers['set-cookie'] as unknown as string[]).find(value => value.startsWith('mnemo.guest='))!;
    for (const value of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=34560000']) expect(header).toContain(value);
    expect(header).not.toContain('Secure');
    const stored = await User.findById(first.body._id).select('+guestTokenHash +email +passwordHash');
    expect(stored!.guestTokenHash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(stored!.email).toBeUndefined();
    expect(stored!.passwordHash).toBeUndefined();
    expect(await User.findById(first.body._id).lean()).not.toHaveProperty('guestTokenHash');
    const again = await agent.post('/api/auth/guest').send({}).expect(200);
    expect(again.body).toEqual(first.body);
    expect(again.headers['set-cookie'].some((value: string) => value.startsWith('mnemo.guest='))).toBe(false);
    // Perte réelle de toutes les sessions : le cookie device seul retrouve le même User.
    await mongoose.connection.collection('sessions').deleteMany({});
    await agent.get('/api/auth/me').expect(401);
    const restored = await agent.post('/api/auth/guest').send({}).expect(200);
    expect(restored.body).toEqual(first.body);
    expect(await User.countDocuments({ isGuest: true })).toBe(1);
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => request(service.app).post('/api/auth/guest').set('Cookie', cookie).send({})));
    expect(concurrent.map(value => value.status)).toEqual(Array(5).fill(200));
    expect(concurrent.every(value => value.body._id === first.body._id)).toBe(true);
    expect(await User.countDocuments({ isGuest: true })).toBe(1);
    await expect(User.create({ isGuest: true, username: 'another_guest', displayName: 'Autre', guestTokenHash: stored!.guestTokenHash })).rejects.toMatchObject({ code: 11000 });
    assertNoSecrets(restored.body);
    const profile = await agent.get(`/api/profiles/${first.body.username}`).expect(200);
    expect(profile.body.isGuest).toBe(true);
    assertNoSecrets(profile.body);
  });
  it('isole deux invités, un compte permanent et les cookies forgés sans fixation', async () => {
    const one = request.agent(service.app);
    const two = request.agent(service.app);
    const first = await one.post('/api/auth/guest').send({}).expect(200);
    const second = await two.post('/api/auth/guest').send({}).expect(200);
    expect(first.body._id).not.toBe(second.body._id);
    const id = await deck(one);
    const course = (await one.post('/api/courses').send({ title: 'Cours invité' }).expect(201)).body._id;
    const cid = await card(id, one);
    for (const other of [two, alice]) {
      await other.get(`/api/decks/${id}`).expect(404);
      await other.patch(`/api/cards/${cid}`).send({ back: 'Vol' }).expect(404);
      await other.patch(`/api/courses/${course}`).send({ title: 'Vol' }).expect(404);
    }
    const forged = `mnemo.guest=${'a'.repeat(64)}`;
    await request(service.app).get(`/api/decks/${id}`).set('Cookie', forged).set('X-User-ID', first.body._id).expect(404);
    for (const cookie of [forged, 'mnemo.guest=%E0%A4%A', 'mnemo.guest=bad', `${deviceCookie(first)}; ${deviceCookie(first)}`]) {
      const response = await request(service.app).post('/api/auth/guest').set('Cookie', cookie).send({}).expect(200);
      expect(response.body._id).not.toBe(first.body._id);
      expect(deviceCookie(response)).not.toBe(cookie);
    }
    const permanent = await alice.post('/api/auth/guest').send({}).expect(200);
    expect(permanent.body).toMatchObject({ _id: aliceId, isGuest: false });
    expect(permanent.headers['set-cookie']).toBeUndefined();
    const publicDeck = await deck(one, { visibility: 'unlisted' });
    expect((await request(service.app).get(`/api/decks/${publicDeck}`).expect(200)).body.owner.isGuest).toBe(true);
    expect(new User({ username: 'missing', displayName: 'Invalide' }).validateSync()?.errors).toHaveProperty('email');
    expect(new User({ username: 'missing', displayName: 'Invalide' }).validateSync()?.errors).toHaveProperty('passwordHash');
  });
  it('logout efface les deux cookies, conserve les contenus et ne reprend pas un ancien invité après login', async () => {
    const agent = request.agent(service.app);
    const guest = await agent.post('/api/auth/guest').send({}).expect(200);
    const id = await deck(agent);
    const login = await agent.post('/api/auth/login').send({ email: 'alice@example.com', password }).expect(200);
    expect(deviceCookie(login)).toBe('mnemo.guest=');
    expect((await agent.get('/api/decks')).body.items).toHaveLength(0);
    expect((await Deck.findById(id))!.owner.toString()).toBe(guest.body._id);
    const logout = await agent.post('/api/auth/logout').send({}).expect(204);
    expect(deviceCookie(logout)).toBe('mnemo.guest=');
    expect(logout.headers['set-cookie'].some((value: string) => value.startsWith('flashcard.sid=;'))).toBe(true);
    await agent.get('/api/auth/me').expect(401);
    const next = await agent.post('/api/auth/guest').send({}).expect(200);
    expect(next.body._id).not.toBe(guest.body._id);
    const guestLogout = await agent.post('/api/auth/logout').send({}).expect(204);
    expect(deviceCookie(guestLogout)).toBe('mnemo.guest=');
    await agent.get('/api/auth/me').expect(401);
    expect(await User.exists({ _id: guest.body._id })).toBeTruthy();
    expect(await Deck.exists({ _id: id })).toBeTruthy();
  });
  it('convertit atomiquement le même User, préserve les propriétaires et révoque ancien cookie et sessions', async () => {
    const agent = request.agent(service.app);
    const guest = await agent.post('/api/auth/guest').send({}).expect(200);
    const oldSession = request.agent(service.app);
    await oldSession.post('/api/auth/guest').set('Cookie', deviceCookie(guest)).send({}).expect(200);
    const id = await deck(agent);
    const course = (await agent.post('/api/courses').send({ title: 'Préservé' }).expect(201)).body._id;
    await agent.patch(`/api/profiles/${guest.body.username}`).send({ bio: 'Toujours ici' }).expect(200);
    const upgraded = await agent.post('/api/auth/register').send(credentials('converted')).expect(201);
    expect(upgraded.body).toMatchObject({ _id: guest.body._id, isGuest: false, bio: 'Toujours ici' });
    expect(deviceCookie(upgraded)).toBe('mnemo.guest=');
    expect(await User.countDocuments()).toBe(3);
    expect((await User.findById(guest.body._id).select('+guestTokenHash'))!.guestTokenHash).toBeUndefined();
    await agent.get(`/api/decks/${id}`).expect(200);
    await agent.patch(`/api/courses/${course}`).send({ title: 'Encore propriétaire' }).expect(200);
    await oldSession.get('/api/auth/me').expect(401);
    // Une requête guest peut directement remplacer une session devenue invalide.
    const stale = request.agent(service.app);
    await stale.post('/api/auth/guest').send({}).expect(200);
    const staleUser = (await stale.get('/api/auth/me')).body._id;
    await User.updateOne({ _id: staleUser }, { $inc: { authVersion: 1 } });
    expect((await stale.post('/api/auth/guest').send({}).expect(200)).body._id).toBe(staleUser);
    const replay = await request(service.app).post('/api/auth/guest').set('Cookie', deviceCookie(guest)).send({}).expect(200);
    expect(replay.body._id).not.toBe(guest.body._id);
    await agent.post('/api/auth/register').send(credentials('overwrite')).expect(409);
    expect((await User.findById(guest.body._id))!.username).toBe('converted');
    assertNoSecrets(upgraded.body);
  });
  it('garde le guest après collision email et empêche deux conversions concurrentes', async () => {
    const agent = request.agent(service.app);
    const guest = await agent.post('/api/auth/guest').send({}).expect(200);
    await agent.post('/api/auth/register').send({ ...credentials('duplicate'), email: 'alice@example.com' }).expect(409);
    expect((await agent.get('/api/auth/me').expect(200)).body).toEqual(guest.body);
    const results = await Promise.all([
      agent.post('/api/auth/register').send(credentials('winner_one')),
      agent.post('/api/auth/register').send(credentials('winner_two')),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    expect(await User.countDocuments({ _id: guest.body._id, isGuest: false })).toBe(1);
  });
  it('conversion avec confirmation : aucun accès avant vérification, ownership préservé après login', async () => {
    const agent = request.agent(makeService(configuration({ REQUIRE_EMAIL_VERIFICATION: 'true' })).app);
    const guest = await agent.post('/api/auth/guest').send({}).expect(200);
    const id = await deck(agent);
    const response = await agent.post('/api/auth/register').send(credentials('verified_guest')).expect(201);
    expect(response.body.requiresVerification).toBe(true);
    expect(deviceCookie(response)).toBe('mnemo.guest=');
    await agent.get('/api/auth/me').expect(401);
    await agent.get(`/api/decks/${id}`).expect(404);
    await agent.post('/api/auth/login').send({ email: 'verified_guest@example.com', password }).expect(403);
    await agent.post('/api/auth/verify-email').send({ token: new URL(response.body.devVerificationUrl).searchParams.get('token') }).expect(200);
    const login = await agent.post('/api/auth/login').send({ email: 'verified_guest@example.com', password }).expect(200);
    expect(login.body).toMatchObject({ _id: guest.body._id, isGuest: false });
    await agent.get(`/api/decks/${id}`).expect(200);
    expect(await User.countDocuments()).toBe(3);
  });
  it('échec SMTP restaure identité guest, cookie, session et contenus ; réessai possible', async () => {
    const agent = request.agent(makeService(configuration({ REQUIRE_EMAIL_VERIFICATION: 'true' })).app);
    const guest = await agent.post('/api/auth/guest').send({}).expect(200);
    const before = await User.findById(guest.body._id).select('+guestTokenHash +authVersion');
    const id = await deck(agent);
    const send = vi.spyOn(mail, 'sendToken').mockRejectedValueOnce(new Error('SMTP indisponible'));
    try {
      const failed = await agent.post('/api/auth/register').send(credentials('smtp_guest')).expect(503);
      expect(failed.headers['set-cookie']).toBeUndefined();
    } finally { send.mockRestore(); }
    expect((await agent.get('/api/auth/me').expect(200)).body).toEqual(guest.body);
    await agent.get(`/api/decks/${id}`).expect(200);
    const restored = await User.findById(guest.body._id).select('+guestTokenHash +authVersion +email +passwordHash +verificationTokenHash');
    expect(restored).toMatchObject({ isGuest: true, guestTokenHash: before!.guestTokenHash, authVersion: before!.authVersion });
    for (const field of ['email', 'passwordHash', 'verificationTokenHash']) expect(restored!.get(field)).toBeUndefined();
    expect((await request(service.app).post('/api/auth/guest').set('Cookie', deviceCookie(guest)).send({}).expect(200)).body._id).toBe(guest.body._id);
    await agent.post('/api/auth/register').send(credentials('smtp_guest')).expect(201);
  });
  it('les endpoints reset/login/verify excluent les guests même avec des champs injectés en DB', async () => {
    const guest = (await request(service.app).post('/api/auth/guest').send({}).expect(200)).body;
    const rawToken = 'b'.repeat(64);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await User.updateOne({ _id: guest._id }, { $set: { email: 'guest@example.com', resetTokenHash: tokenHash, resetExpiresAt: new Date(Date.now() + 60000), verificationTokenHash: tokenHash, verificationExpiresAt: new Date(Date.now() + 60000) } });
    const forgot = await request(service.app).post('/api/auth/forgot-password').send({ email: 'guest@example.com' }).expect(200);
    expect(forgot.body.devResetUrl).toBeUndefined();
    await request(service.app).post('/api/auth/reset-password').send({ token: rawToken, password }).expect(400);
    await request(service.app).post('/api/auth/verify-email').send({ token: rawToken }).expect(400);
    await request(service.app).post('/api/auth/login').send({ email: 'guest@example.com', password }).expect(401);
    const limited = makeService(configuration({ AUTH_RATE_LIMIT: '1' }));
    await request(limited.app).post('/api/auth/guest').send({}).expect(200);
    await request(limited.app).post('/api/auth/guest').send({}).expect(429);
  });
  it('cookie invité Secure en production derrière un proxy explicitement fiable', async () => {
    const production = makeService(configuration({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(64), FRONTEND_URL: 'https://mnemo.example', CORS_ORIGIN: 'https://mnemo.example', SMTP_HOST: 'smtp.example', MAIL_FROM: 'mail@mnemo.example', TRUST_PROXY: '1' }));
    const response = await request(production.app).post('/api/auth/guest').set('X-Forwarded-Proto', 'https').send({}).expect(200);
    for (const cookie of response.headers['set-cookie']) expect(cookie).toContain('Secure');
  });
  it.each([false, true])('migration index email historique sparse=%s, aucun document modifié', async sparse => {
    const collection = mongoose.connection.collection(`legacy_email_${sparse}`);
    await collection.insertOne({ email: 'legacy@example.com', username: 'legacy' });
    await collection.createIndex({ email: 1 }, { unique: true, ...(sparse ? { sparse: true } : {}) });
    const before = await collection.find().toArray();
    await expect(migrateEmailIndex(collection, false)).rejects.toThrow('maintenance');
    await migrateEmailIndex(collection, true);
    await migrateEmailIndex(collection, true);
    expect(await collection.find().toArray()).toEqual(before);
    const indexes = await collection.indexes();
    expect(indexes.find(index => index.name === 'email_string_unique')).toMatchObject({ unique: true, partialFilterExpression: { email: { $type: 'string' } } });
    expect(indexes.some(index => index.name === 'email_1')).toBe(false);
    await collection.insertMany([{ isGuest: true }, { isGuest: true }]);
    await expect(collection.insertOne({ email: 'legacy@example.com' })).rejects.toMatchObject({ code: 11000 });
    await collection.drop();
  });
  it('migration refuse les doublons/index inconnus et restaure un index en cas d’échec', async () => {
    const collection = mongoose.connection.collection('migration_failure');
    await collection.insertMany([{ email: 'duplicate@example.com' }, { email: 'duplicate@example.com' }]);
    const before = await collection.find().toArray();
    await expect(migrateEmailIndex(collection, true)).rejects.toThrow('dupliqués');
    expect(await collection.find().toArray()).toEqual(before);
    await collection.drop();
    await collection.insertOne({ email: 'unique@example.com' });
    await collection.createIndex({ email: 1 });
    await expect(migrateEmailIndex(collection, true)).rejects.toThrow('non reconnu');
    expect((await collection.indexes()).some(index => index.name === 'email_1')).toBe(true);
    await collection.dropIndex('email_1');
    await collection.createIndex({ email: 1 }, { unique: true, sparse: true });
    const create = vi.spyOn(collection, 'createIndex').mockRejectedValueOnce(new Error('Panne simulée'));
    try { await expect(migrateEmailIndex(collection, true)).rejects.toThrow('anciens index restaurés'); }
    finally { create.mockRestore(); }
    expect((await collection.indexes()).find(index => index.name === 'email_1')).toMatchObject({ unique: true, sparse: true });
    expect(await collection.countDocuments()).toBe(1);
    await collection.drop();
    const indexes = vi.spyOn(User.collection, 'indexes').mockResolvedValueOnce([{ name: 'email_1', key: { email: 1 }, unique: true }]);
    const drop = vi.spyOn(User.collection, 'dropIndex');
    try {
      await expect(initializeIndexes()).rejects.toThrow('Index email historique');
      expect(drop).not.toHaveBeenCalled();
    } finally { indexes.mockRestore(); drop.mockRestore(); }
  });
});

describe('CRUD, permissions et confidentialité', () => {
  it('cours/chapitres : CRUD, associations propriétaire et cascade complète', async () => {
    const course = (await alice.post('/api/courses').send({ title: 'Sciences', color: '#123456', icon: 'book' }).expect(201)).body;
    await alice.patch(`/api/courses/${course._id}`).send({ title: 'Sciences naturelles' }).expect(200);
    const chapter = (await alice.post(`/api/courses/${course._id}/chapters`).send({ title: 'Chapitre 1', position: 2 }).expect(201)).body;
    await alice.patch(`/api/chapters/${chapter._id}`).send({ position: 0 }).expect(200);
    expect((await alice.get(`/api/courses/${course._id}/chapters`).expect(200)).body.items).toHaveLength(1);
    await bob.post('/api/decks').send({ title: 'Vol', chapter: chapter._id }).expect(404);
    await bob.post(`/api/courses/${course._id}/chapters`).send({ title: 'Vol' }).expect(404);
    await bob.patch(`/api/courses/${course._id}`).send({ title: 'Vol' }).expect(404);
    await bob.patch(`/api/chapters/${chapter._id}`).send({ title: 'Vol' }).expect(404);
    const id = await deck(alice, { chapter: chapter._id });
    const publication = await publish(id);
    await bob.put(`/api/publications/${publication}/like`).send({ liked: true }).expect(200);
    await bob.put(`/api/decks/${id}/save`).send({ saved: true }).expect(200);
    await bob.post(`/api/decks/${id}/study-sessions`).send({ cardsVisited: 1, durationSeconds: 40 }).expect(201);
    await bob.delete(`/api/courses/${course._id}`).set(json).expect(404);
    await alice.delete(`/api/courses/${course._id}`).set(json).expect(204);
    for (const model of [Course, Chapter, Deck, Card, Publication, Like, Saved, StudySession]) expect(await model.countDocuments()).toBe(0);
  });
  it('private est invisible, unlisted accessible par ID mais absent des listes publiques', async () => {
    const privateId = await deck();
    const unlistedId = await deck(alice, { visibility: 'unlisted', title: 'Invisible recherche' });
    await card(unlistedId);
    await bob.get(`/api/decks/${privateId}`).expect(404);
    await request(service.app).get(`/api/decks/${privateId}`).expect(404);
    const response = await request(service.app).get(`/api/decks/${unlistedId}`).expect(200);
    expect(response.body.cardCount).toBe(1);
    expect(response.body.cards).toHaveLength(1);
    expect(response.body.owner.username).toBe('alice');
    assertNoSecrets(response.body);
    expect((await bob.get('/api/decks')).body.items).toHaveLength(0);
    expect((await bob.get('/api/feed?q=Invisible')).body.items).toHaveLength(0);
    expect((await bob.get('/api/profiles/alice')).body.decks).toHaveLength(0);
    await bob.patch(`/api/decks/${unlistedId}`).send({ title: 'Vol' }).expect(404);
    await bob.put(`/api/decks/${unlistedId}/save`).send({ saved: true }).expect(404);
    await bob.post(`/api/decks/${unlistedId}/study-sessions`).send({ cardsVisited: 2, durationSeconds: 10 }).expect(201);
    await bob.post(`/api/decks/${privateId}/study-sessions`).send({ cardsVisited: 1, durationSeconds: 10 }).expect(404);
    await request(service.app).post(`/api/decks/${unlistedId}/study-sessions`).send({ cardsVisited: 1, durationSeconds: 10 }).expect(401);
  });
  it('permutation exacte des cartes et isolation des écritures multi-utilisateurs', async () => {
    const id = await deck();
    const c1 = await card(id, alice, 'A');
    const c2 = await card(id, alice, 'B');
    const foreignDeck = await deck(bob);
    const foreign = await card(foreignDeck, bob);
    await bob.patch(`/api/cards/${c1}`).send({ back: 'Vol' }).expect(404);
    await bob.delete(`/api/cards/${c1}`).set(json).expect(404);
    await bob.post(`/api/decks/${id}/cards`).send({ front: 'X', back: 'X' }).expect(404);
    await bob.put(`/api/decks/${id}/cards/order`).send({ ids: [c2, c1] }).expect(404);
    for (const ids of [[c1], [c1, c1], [c1, foreign], []]) await alice.put(`/api/decks/${id}/cards/order`).send({ ids }).expect(400);
    const response = await alice.put(`/api/decks/${id}/cards/order`).send({ ids: [c2, c1] }).expect(200);
    expect(response.body.cards.map((c: { _id: string }) => c._id)).toEqual([c2, c1]);
    await alice.patch(`/api/cards/${c1}`).send({ front: 'Modifié', position: 4 }).expect(200);
    await alice.delete(`/api/decks/${id}`).set(json).expect(204);
    expect(await Card.countDocuments({ deck: id })).toBe(0);
    expect(await Card.countDocuments({ deck: foreignDeck })).toBe(1);
  });
  it('profil propriétaire uniquement, URLs sûres et decks publics seuls', async () => {
    const id = await deck();
    await publish(id);
    await deck(alice, { visibility: 'unlisted' });
    await deck();
    await bob.patch('/api/profiles/alice').send({ bio: 'Vol' }).expect(403);
    await alice.patch('/api/profiles/alice').send({ email: 'leak@example.com' }).expect(400);
    await alice.patch('/api/profiles/alice').send({ avatarUrl: 'javascript:alert(1)' }).expect(400);
    await alice.patch('/api/profiles/alice').send({ avatarUrl: 'pas-une-url' }).expect(400);
    const updated = await alice.patch('/api/profiles/alice').send({ displayName: 'Alice', bio: 'Bonjour', avatarUrl: 'https://example.com/avatar.png' }).expect(200);
    expect(updated.body).toMatchObject({ bio: 'Bonjour', publicDeckCount: 1, followerCount: 0, followingCount: 0 });
    const profile = (await request(service.app).get('/api/profiles/alice').expect(200)).body;
    expect(profile.decks).toHaveLength(1);
    expect(profile.decks[0]).toMatchObject({ _id: id, cardCount: 1 });
    assertNoSecrets(profile);
  });
  it('permet déplacement/détachement et supprime un chapitre sans supprimer les decks détachés', async () => {
    const course = (await alice.post('/api/courses').send({ title: 'Cours' }).expect(201)).body._id;
    const chapter = (await alice.post(`/api/courses/${course}/chapters`).send({ title: 'Chapitre' }).expect(201)).body._id;
    const foreignCourse = (await bob.post('/api/courses').send({ title: 'Cours Bob' }).expect(201)).body._id;
    const foreignChapter = (await bob.post(`/api/courses/${foreignCourse}/chapters`).send({ title: 'Chapitre Bob' }).expect(201)).body._id;
    const detached = await deck(alice, { chapter });
    const attached = await deck();
    await alice.patch(`/api/decks/${attached}`).send({ chapter: foreignChapter }).expect(404);
    await alice.patch(`/api/decks/${attached}`).send({ chapter }).expect(200);
    const response = await alice.patch(`/api/decks/${detached}`).send({ chapter: null }).expect(200);
    expect(response.body.chapter).toBeUndefined();
    await card(attached);
    await bob.delete(`/api/chapters/${chapter}`).set(json).expect(404);
    await alice.delete(`/api/chapters/${chapter}`).set(json).expect(204);
    await alice.get(`/api/decks/${attached}`).expect(404);
    await alice.get(`/api/decks/${detached}`).expect(200);
    expect(await Card.countDocuments({ deck: attached })).toBe(0);
    expect(await Course.countDocuments({ _id: course })).toBe(1);
  });
  it('pagine aussi cours, chapitres, profils et sauvegardes', async () => {
    const course = (await alice.post('/api/courses').send({ title: 'Cours 1' }).expect(201)).body._id;
    await alice.post('/api/courses').send({ title: 'Cours 2' }).expect(201);
    for (let i = 0; i < 2; i++) {
      await alice.post(`/api/courses/${course}/chapters`).send({ title: `Chapitre ${i}` }).expect(201);
      const id = await deck();
      await publish(id);
      await bob.put(`/api/decks/${id}/save`).send({ saved: true }).expect(200);
    }
    for (const endpoint of ['/api/courses', `/api/courses/${course}/chapters`, '/api/profiles/alice']) {
      const first = (await alice.get(`${endpoint}?limit=1`).expect(200)).body;
      expect(first.hasMore).toBe(true);
      expect(first.decks ?? first.items).toHaveLength(1);
      expect((await alice.get(`${endpoint}?limit=1&page=2`).expect(200)).body.hasMore).toBe(false);
    }
    expect((await bob.get('/api/saved?limit=1').expect(200)).body.hasMore).toBe(true);
    expect((await bob.get('/api/saved?limit=1&page=2').expect(200)).body.hasMore).toBe(false);
  });
  it('pagine les listes et garde l’historique personnel sans contenu devenu privé', async () => {
    const id = await deck(alice, { visibility: 'unlisted' });
    await card(id);
    await deck();
    const first = (await alice.get('/api/decks?limit=1')).body;
    expect(first.items).toHaveLength(1);
    expect(first.page).toBe(1);
    expect(first.hasMore).toBe(true);
    const second = (await alice.get('/api/decks?limit=1&page=2')).body;
    expect(second.hasMore).toBe(false);
    expect(second.items[0]._id).not.toBe(first.items[0]._id);
    for (const invalid of [{ cardsVisited: 0, durationSeconds: 1 }, { cardsVisited: 1, durationSeconds: 86401 }, { cardsVisited: 100001, durationSeconds: 1 }, { cardsVisited: 1.5, durationSeconds: 1 }]) await bob.post(`/api/decks/${id}/study-sessions`).send(invalid).expect(400);
    await bob.post(`/api/decks/${id}/study-sessions`).send({ cardsVisited: 3, durationSeconds: 30 }).expect(201);
    await bob.post(`/api/decks/${id}/study-sessions`).send({ cardsVisited: 2, durationSeconds: 20 }).expect(201);
    await alice.patch(`/api/decks/${id}`).send({ visibility: 'private' }).expect(200);
    const history = (await bob.get('/api/study-sessions?limit=1')).body;
    expect(history.hasMore).toBe(true);
    expect(history.items[0].deck).toBe(id);
    expect(JSON.stringify(history)).not.toContain('Question');
    expect((await alice.get('/api/study-sessions')).body.items).toHaveLength(0);
  });
});

describe('Publication et social', () => {
  it('refuse publication/révision vide, dépublie à la suppression de la dernière carte', async () => {
    await alice.post('/api/decks').send({ title: 'Vide', visibility: 'public' }).expect(400);
    const id = await deck();
    await alice.post(`/api/decks/${id}/publish`).send({}).expect(400);
    await alice.patch(`/api/decks/${id}`).send({ visibility: 'public' }).expect(400);
    await alice.post(`/api/decks/${id}/study-sessions`).send({ cardsVisited: 1, durationSeconds: 1 }).expect(400);
    const c1 = await card(id);
    const publication = (await alice.post(`/api/decks/${id}/publish`).send({}).expect(200)).body._id;
    expect((await alice.post(`/api/decks/${id}/publish`).send({}).expect(200)).body._id).toBe(publication);
    await bob.put(`/api/publications/${publication}/like`).send({ liked: true }).expect(200);
    await bob.put(`/api/decks/${id}/save`).send({ saved: true }).expect(200);
    await alice.delete(`/api/cards/${c1}`).set(json).expect(204);
    expect((await alice.get(`/api/decks/${id}`)).body.visibility).toBe('private');
    expect(await Publication.countDocuments()).toBe(0);
    expect(await Like.countDocuments()).toBe(0);
    expect(await Saved.countDocuments()).toBe(0);
    await bob.get(`/api/decks/${id}`).expect(404);
  });
  it('PATCH public crée publication, like/save idempotents sans copie et nettoyage au dépublier', async () => {
    const id = await deck();
    await card(id);
    await alice.patch(`/api/decks/${id}`).send({ visibility: 'public' }).expect(200);
    const publication = (await Publication.findOne({ deck: id }))!.id;
    for (let i = 0; i < 2; i++) {
      await bob.put(`/api/publications/${publication}/like`).send({ liked: true }).expect(200);
      await bob.put(`/api/decks/${id}/save`).send({ saved: true }).expect(200);
    }
    expect(await Like.countDocuments()).toBe(1);
    expect(await Saved.countDocuments()).toBe(1);
    expect(await Deck.countDocuments()).toBe(1);
    const feed = (await bob.get('/api/feed').expect(200)).body.items[0];
    expect(feed).toMatchObject({ _id: publication, liked: true, saved: true, likeCount: 1, owner: { username: 'alice' }, deck: { _id: id, cardCount: 1, preview: { front: 'Question', back: 'Réponse' } } });
    assertNoSecrets(feed);
    expect((await bob.get('/api/saved').expect(200)).body.items[0]).toMatchObject({ _id: id, cardCount: 1, owner: { username: 'alice' } });
    for (let i = 0; i < 2; i++) {
      await bob.put(`/api/publications/${publication}/like`).send({ liked: false }).expect(200);
      await bob.put(`/api/decks/${id}/save`).send({ saved: false }).expect(200);
    }
    await alice.patch(`/api/decks/${id}`).send({ visibility: 'unlisted' }).expect(200);
    expect(await Publication.countDocuments()).toBe(0);
    expect((await bob.get('/api/saved')).body.items).toHaveLength(0);
    await bob.put(`/api/publications/${publication}/like`).send({ liked: true }).expect(404);
    await bob.put(`/api/decks/${id}/save`).send({ saved: true }).expect(404);
  });
  it('popular global avant pagination, recherche littérale uniquement titre/description/créateur', async () => {
    const older = await deck(alice, { title: 'Ancien populaire', description: 'Mitochondrie' });
    const publication = await publish(older);
    const newer = await deck(bob, { title: 'Nouveau' });
    await publish(newer, bob);
    await bob.put(`/api/publications/${publication}/like`).send({ liked: true }).expect(200);
    expect((await bob.get('/api/feed?sort=popular&limit=1')).body.items[0].deck._id).toBe(older);
    expect((await bob.get('/api/feed?sort=recent&limit=1')).body.items[0].deck._id).toBe(newer);
    expect((await bob.get('/api/feed?q=Mitochondrie')).body.items).toHaveLength(1);
    expect((await bob.get('/api/feed?q=ALICE')).body.items).toHaveLength(1);
    expect((await bob.get('/api/feed?q=Question')).body.items).toHaveLength(0);
    expect((await bob.get('/api/feed?q=%2E%2A')).body.items).toHaveLength(0);
    expect((await bob.get('/api/feed?limit=1')).body.hasMore).toBe(true);
    expect((await bob.get('/api/feed?limit=1&page=2')).body.hasMore).toBe(false);
  });
  it('préserve les invariants sous likes/save/dépublication concurrents', async () => {
    const id = await deck();
    const publication = await publish(id);
    const results = await Promise.all([
      bob.put(`/api/publications/${publication}/like`).send({ liked: true }),
      bob.put(`/api/publications/${publication}/like`).send({ liked: true }),
      bob.put(`/api/decks/${id}/save`).send({ saved: true }),
      alice.patch(`/api/decks/${id}`).send({ visibility: 'private' }),
    ]);
    expect(results.map(r => r.status).every(s => [200, 404].includes(s))).toBe(true);
    expect(await Publication.countDocuments()).toBe(0);
    expect(await Like.countDocuments()).toBe(0);
    expect(await Saved.countDocuments()).toBe(0);
    expect((await bob.get('/api/feed')).body.items).toHaveLength(0);
  });
  it('ne laisse pas de publication vide si publication et dernière suppression sont concurrentes', async () => {
    const id = await deck();
    const last = await card(id);
    await alice.post(`/api/decks/${id}/publish`).send({}).expect(200);
    const results = await Promise.all([
      alice.post(`/api/decks/${id}/publish`).send({}),
      alice.delete(`/api/cards/${last}`).set(json),
    ]);
    expect([200, 400]).toContain(results[0]!.status);
    expect(results[1]!.status).toBe(204);
    expect(await Card.countDocuments({ deck: id })).toBe(0);
    expect(await Publication.countDocuments({ deck: id })).toBe(0);
    expect((await alice.get(`/api/decks/${id}`).expect(200)).body.visibility).toBe('private');
  });
});

describe('Limites configurables des faces', () => {
  it('valide la configuration sans environnement utilisateur et conserve le plafond modèle', async () => {
    expect(configuration().CARD_TEXT_MAX_LENGTH).toBe(10000);
    for (const value of ['1', '42', '10000']) expect(configuration({ CARD_TEXT_MAX_LENGTH: value }).CARD_TEXT_MAX_LENGTH).toBe(Number(value));
    for (const value of ['', '0', '-1', '10001', '1.5', 'abc', 'Infinity']) {
      expect(() => configuration({ CARD_TEXT_MAX_LENGTH: value })).toThrow('CARD_TEXT_MAX_LENGTH');
    }
    const id = await deck();
    // Même les caractères échappés en JSON restent sous le plafond de corps de 256 ko.
    await alice.post(`/api/decks/${id}/cards`).send({ front: '\u0001'.repeat(10000), back: '\u0001'.repeat(10000) }).expect(201);
    for (const field of ['front', 'back']) {
      await alice.post(`/api/decks/${id}/cards`).send({ front: 'Q', back: 'R', [field]: 'x'.repeat(10001) }).expect(400);
      const record = new Card({ owner: aliceId, deck: id, front: 'Q', back: 'R', [field]: 'x'.repeat(10001) });
      expect(record.validateSync()?.errors).toHaveProperty(field);
    }
  });
  it('expose seulement la limite publique et isole les configurations des applications', async () => {
    const config = configuration({ CARD_TEXT_MAX_LENGTH: '5' });
    const limited = makeService(config);
    config.CARD_TEXT_MAX_LENGTH = 9;
    expect((await request(limited.app).get('/api/config').expect(200)).body).toEqual({ cardTextMaxLength: 5 });
    expect((await request(service.app).get('/api/config').expect(200)).body).toEqual({ cardTextMaxLength: 10000 });
    const agent = request.agent(limited.app);
    await agent.post('/api/auth/login').send({ email: 'alice@example.com', password }).expect(200);
    const id = await deck(agent);
    const created = (await agent.post(`/api/decks/${id}/cards`).send({ front: ' 12345 ', back: 'abcde' }).expect(201)).body;
    expect(created.front).toBe('12345');
    for (const field of ['front', 'back']) {
      const rejected = await agent.post(`/api/decks/${id}/cards`).send({ front: 'Q', back: 'R', [field]: '123456' }).expect(400);
      expect(rejected.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: field })]));
      await agent.patch(`/api/cards/${created._id}`).send({ [field]: '123456' }).expect(400);
      await agent.patch(`/api/cards/${created._id}`).send({ [field]: 'abcde' }).expect(200);
      await agent.patch(`/api/cards/${created._id}`).send({ [field]: '   ' }).expect(400);
    }
    await agent.patch(`/api/cards/${created._id}`).send({ position: 2 }).expect(200);
    expect((await Card.findById(created._id))!.front).toBe('abcde');
    await alice.post(`/api/decks/${id}/cards`).send({ front: '123456', back: '123456' }).expect(201);
    const legacy = await card(id, alice, 'Ancienne face plus longue');
    await agent.patch(`/api/cards/${legacy}`).send({ position: 3 }).expect(200);
    await agent.patch(`/api/cards/${legacy}`).send({ front: 'Ancienne face plus longue' }).expect(400);
  });
  it('accepte le minimum de configuration de un caractère', async () => {
    const agent = request.agent(makeService(configuration({ CARD_TEXT_MAX_LENGTH: '1' })).app);
    await agent.post('/api/auth/login').send({ email: 'alice@example.com', password }).expect(200);
    const id = await deck(agent);
    await agent.post(`/api/decks/${id}/cards`).send({ front: 'Q', back: 'R' }).expect(201);
    await agent.post(`/api/decks/${id}/cards`).send({ front: 'QQ', back: 'R' }).expect(400);
  });
  it('accepte un texte, une image HTTP ou les deux sur chaque face', async () => {
    const id = await deck();
    const japan = 'https://upload.wikimedia.org/wikipedia/commons/9/9e/Flag_of_Japan.svg';
    const france = 'https://upload.wikimedia.org/wikipedia/en/c/c3/Flag_of_France.svg';
    const created = (await alice.post(`/api/decks/${id}/cards`).send({ front: 'Quel drapeau représente le Japon ?', back: '', backImageUrl: japan }).expect(201)).body;
    expect(created).toMatchObject({ back: '', backImageUrl: japan });
    await alice.post(`/api/decks/${id}/cards`).send({ front: '', back: 'La France', frontImageUrl: france }).expect(201);
    await alice.post(`/api/decks/${id}/cards`).send({ front: '', back: '', frontImageUrl: japan, backImageUrl: france }).expect(201);
    await alice.post(`/api/decks/${id}/cards`).send({ front: 'Question', back: '' }).expect(400);
    await alice.post(`/api/decks/${id}/cards`).send({ front: 'Question', back: 'Réponse', backImageUrl: 'javascript:alert(1)' }).expect(400);
    await alice.patch(`/api/cards/${created._id}`).send({ backImageUrl: '' }).expect(400);
    await alice.post(`/api/decks/${id}/publish`).send({}).expect(200);
    expect((await request(service.app).get('/api/feed')).body.items[0].deck.preview).toMatchObject({ front: 'Quel drapeau représente le Japon ?', backImageUrl: japan });
  });
  it('range les cartes rapides dans un paquet Général unique ou dans le paquet choisi', async () => {
    const first = (await alice.post('/api/cards/quick').send({ front: 'Question rapide', back: 'Réponse rapide' }).expect(201)).body;
    const second = (await alice.post('/api/cards/quick').send({ front: 'Autre question', back: 'Autre réponse' }).expect(201)).body;
    expect(first.deck).toMatchObject({ title: 'Général' });
    expect(second.deck._id).toBe(first.deck._id);
    expect(await Deck.countDocuments({ owner: aliceId, quickDefault: true })).toBe(1);
    expect(await Card.countDocuments({ deck: first.deck._id })).toBe(2);

    const chosen = await deck();
    const explicit = (await alice.post('/api/cards/quick').send({ front: 'Cours', back: 'Contenu', deck: chosen }).expect(201)).body;
    expect(explicit.deck._id).toBe(chosen);
    await bob.post('/api/cards/quick').send({ front: 'Intrusion', back: 'Refusée', deck: chosen }).expect(404);
    await alice.post('/api/cards/quick').send({ front: '', back: 'Invalide' }).expect(400);
  });
});

describe('Standalone : sérialisation, validation préalable et erreurs partielles explicites', () => {
  it.skipIf(transactions)('partage la file entre applications sur la même connexion', async () => {
    const other = request.agent(makeService(configuration()).app);
    await other.post('/api/auth/login').send({ email: 'alice@example.com', password }).expect(200);
    const id = await deck();
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? other : alice).post(`/api/decks/${id}/cards`).send({ front: `Q${index}`, back: 'R' }),
    ));
    expect(results.map(r => r.status)).toEqual(Array(8).fill(201));
    expect(results.map(r => r.body.position).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(await Card.countDocuments({ deck: id })).toBe(8);
  });

  it('rejette les opérations invalides avant les écritures métier, sans prétendre à un rollback', async () => {
    const course = (await alice.post('/api/courses').send({ title: 'Cours' }).expect(201)).body._id;
    const chapter = (await alice.post(`/api/courses/${course}/chapters`).send({ title: 'Chapitre' }).expect(201)).body._id;
    const empty = await deck();
    const id = await deck(alice, { visibility: 'unlisted' });
    const first = await card(id);
    const second = await card(id);
    const snapshot = async () => {
      const documents = [];
      for (const model of [Course, Chapter, Deck, Card, Publication, Like, Saved, StudySession]) {
        documents.push(await model.find().sort({ _id: 1 }).lean());
      }
      documents.push(await User.find().select('displayName bio avatarUrl updatedAt').sort({ _id: 1 }).lean());
      return JSON.stringify(documents);
    };
    const before = await snapshot();
    await alice.post(`/api/courses/${course}/chapters`).send({ title: '' }).expect(400);
    await alice.patch(`/api/decks/${empty}`).send({ visibility: 'public', chapter }).expect(400);
    await alice.post(`/api/decks/${empty}/publish`).send({}).expect(400);
    await alice.post(`/api/decks/${empty}/study-sessions`).send({ cardsVisited: 1, durationSeconds: 1 }).expect(400);
    await alice.put(`/api/decks/${id}/cards/order`).send({ ids: [first, first] }).expect(400);
    await alice.put(`/api/decks/${id}/cards/order`).send({ ids: [second] }).expect(400);
    await alice.post(`/api/decks/${id}/cards`).send({ front: 'Q', back: '' }).expect(400);
    await alice.patch(`/api/cards/${first}`).send({ position: -1 }).expect(400);
    await alice.put(`/api/decks/${id}/save`).send({ saved: true }).expect(404);
    await bob.patch(`/api/decks/${id}`).send({ title: 'Vol' }).expect(404);
    await alice.patch('/api/profiles/alice?page=0').send({ bio: 'Non écrit' }).expect(400);
    await alice.post(`/api/decks/${id}/cards`).set(json).send('{bad').expect(400);
    expect(await snapshot()).toBe(before);
  });

  it.skipIf(transactions)('retire la visibilité avant un nettoyage en erreur et permet de réessayer la dépublication', async () => {
    const id = await deck();
    const publication = await publish(id);
    await bob.put(`/api/publications/${publication}/like`).send({ liked: true }).expect(200);
    const failure = vi.spyOn(Like, 'deleteMany').mockRejectedValueOnce(new Error('simulated cleanup failure'));
    try { await alice.patch(`/api/decks/${id}`).send({ visibility: 'private' }).expect(500); }
    finally { failure.mockRestore(); }
    expect((await Deck.findById(id))!.visibility).toBe('private');
    expect(await Publication.countDocuments({ deck: id })).toBe(1); // Pas de faux rollback/nettoyage.
    await bob.get(`/api/decks/${id}`).expect(404);
    expect((await bob.get('/api/feed')).body.items).toHaveLength(0);
    expect((await bob.get('/api/profiles/alice')).body.decks).toHaveLength(0);
    await alice.patch(`/api/decks/${id}`).send({ visibility: 'private' }).expect(200);
    expect(await Publication.countDocuments()).toBe(0);
    expect(await Like.countDocuments()).toBe(0);
  });

  it.skipIf(transactions)('ne rend pas public si la création de publication échoue', async () => {
    const id = await deck();
    await card(id);
    const failure = vi.spyOn(Publication, 'updateOne').mockRejectedValueOnce(new Error('simulated publication failure'));
    try { await alice.post(`/api/decks/${id}/publish`).send({}).expect(500); }
    finally { failure.mockRestore(); }
    expect((await Deck.findById(id))!.visibility).toBe('private');
    expect(await Publication.countDocuments()).toBe(0);
    await bob.get(`/api/decks/${id}`).expect(404);
    await alice.post(`/api/decks/${id}/publish`).send({}).expect(200);
  });

  it.skipIf(transactions)('privatise avant suppression de la dernière carte, même si cette suppression échoue', async () => {
    const id = await deck();
    const last = await card(id);
    await alice.post(`/api/decks/${id}/publish`).send({}).expect(200);
    const failure = vi.spyOn(Card.prototype, 'deleteOne').mockRejectedValueOnce(new Error('simulated card failure'));
    try { await alice.delete(`/api/cards/${last}`).set(json).expect(500); }
    finally { failure.mockRestore(); }
    expect((await Deck.findById(id))!.visibility).toBe('private');
    expect(await Card.countDocuments({ deck: id })).toBe(1);
    expect((await bob.get('/api/feed')).body.items).toHaveLength(0);
    await alice.delete(`/api/cards/${last}`).set(json).expect(204);
    expect(await Publication.countDocuments()).toBe(0);
  });

  it.skipIf(transactions)('garde privé après échec du nettoyage suivant la dernière carte sans rollback', async () => {
    const id = await deck();
    const last = await card(id);
    await alice.post(`/api/decks/${id}/publish`).send({}).expect(200);
    const failure = vi.spyOn(Like, 'deleteMany').mockRejectedValueOnce(new Error('simulated cleanup failure'));
    try { await alice.delete(`/api/cards/${last}`).set(json).expect(500); }
    finally { failure.mockRestore(); }
    expect((await Deck.findById(id))!.visibility).toBe('private');
    expect(await Card.countDocuments({ deck: id })).toBe(0);
    expect(await Publication.countDocuments()).toBe(1);
    expect((await bob.get('/api/feed')).body.items).toHaveLength(0);
    await alice.patch(`/api/decks/${id}`).send({ visibility: 'private' }).expect(200);
    expect(await Publication.countDocuments()).toBe(0);
  });

  it.skipIf(transactions)('supprime les parents après les enfants et permet de reprendre une cascade échouée', async () => {
    const course = (await alice.post('/api/courses').send({ title: 'Cours' }).expect(201)).body._id;
    const chapter = (await alice.post(`/api/courses/${course}/chapters`).send({ title: 'Chapitre' }).expect(201)).body._id;
    const id = await deck(alice, { chapter });
    await publish(id);
    const failure = vi.spyOn(Card, 'deleteMany').mockRejectedValueOnce(new Error('simulated cascade failure'));
    try { await alice.delete(`/api/courses/${course}`).set(json).expect(500); }
    finally { failure.mockRestore(); }
    expect(await Course.countDocuments()).toBe(1);
    expect(await Chapter.countDocuments()).toBe(1);
    expect((await Deck.findById(id))!.visibility).toBe('private');
    expect((await bob.get('/api/feed')).body.items).toHaveLength(0);
    expect((await bob.get('/api/profiles/alice')).body.decks).toHaveLength(0);
    await alice.delete(`/api/courses/${course}`).set(json).expect(204);
    for (const model of [Course, Chapter, Deck, Card, Publication, Like, Saved, StudySession]) expect(await model.countDocuments()).toBe(0);
  });
});

describe('Exploitation', () => {
  it('health/ready et validation stricte des configurations', async () => {
    expect((await request(service.app).get('/api/health').expect(200)).body).toEqual({ status: 'ok' });
    expect((await request(service.app).get('/api/ready').expect(200)).body).toEqual({ status: 'ok', connected: true });
    expect(() => loadConfig({ MONGODB_URI: '', SESSION_SECRET: 'x'.repeat(32) })).toThrow('MONGODB_URI est vide');
    expect(() => configuration({ NODE_ENV: 'production' })).toThrow('Configuration invalide');
    expect(() => configuration({ CORS_ORIGIN: '*' })).toThrow('Configuration invalide');
    expect(() => configuration({ REQUIRE_EMAIL_VERIFICATION: 'yes' })).toThrow('Configuration invalide');
    expect(configuration({ NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(64), FRONTEND_URL: 'https://app.example.com', CORS_ORIGIN: 'https://app.example.com', SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'noreply@example.com' }).NODE_ENV).toBe('production');
    expect((await request(service.app).get('/api/unknown').expect(404)).body).toHaveProperty('message');
  });
  it('readiness renvoie 503 sans MongoDB tandis que health reste disponible', async () => {
    await mongoose.disconnect();
    try {
      expect((await request(service.app).get('/api/ready').expect(503)).body).toEqual({ status: 'unavailable', connected: false });
      await request(service.app).get('/api/health').expect(200);
    } finally { await mongoose.connect(mongo.getUri()); }
  });
});
});