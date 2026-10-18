import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { getMongo } from '../src/mongo.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { initializeIndexes, User } from '../src/models.js';

let mongo: MongoMemoryServer;
const stores: ReturnType<typeof createApp>['store'][] = [];
beforeAll(async () => { mongo = await MongoMemoryServer.create(); });
afterEach(async () => {
  try { for (const store of stores.splice(0)) await store.close(); }
  finally { await mongoose.disconnect(); }
});
afterAll(async () => { await mongo?.stop(); });

describe.each([undefined, '', '  override_b  '])('base applicative et sessions : MONGODB_DB=%j', database => {
  it('conserve la base URI sauf override explicite et partage le cycle de vie entre apps', async () => {
    // Configuration intégrale isolée, jamais de dotenv ni de process.env utilisateur.
    const config = loadConfig({
      NODE_ENV: 'test', MONGODB_URI: mongo.getUri('uri_a'), MONGODB_DB: database,
      SESSION_SECRET: 'ephemeral-mongo-tests-secret-at-least-32-characters', AUTH_RATE_LIMIT: '1000',
    });
    const first = getMongo(config);
    expect(getMongo(config)).toBe(first);
    const { connection, db } = await first;
    const name = database?.trim() || 'uri_a';
    expect(connection).toBe(mongoose.connection);
    expect(db.databaseName).toBe(name);
    expect(connection.name).toBe(name);
    await db.dropDatabase();
    await initializeIndexes();
    const one = createApp(config, { transactions: false });
    const two = createApp(config, { transactions: false });
    stores.push(one.store, two.store);
    expect((await one.store.collectionP).dbName).toBe(name);
    const agent = request.agent(one.app);
    const registration = await agent.post('/api/auth/register').send({ email: 'isolated@example.com', username: 'isolated', displayName: 'Isolated', password: 'EphemeralPassword!2026' }).expect(201);
    expect(await db.collection('users').countDocuments()).toBe(1);
    expect(await db.collection('sessions').countDocuments()).toBe(1);
    expect(await User.countDocuments()).toBe(1);
    if (name !== 'uri_a') {
      await expect(connection.getClient().db('uri_a').collection('sessions').countDocuments()).resolves.toBe(0);
      await expect(connection.getClient().db('uri_a').collection('users').countDocuments()).resolves.toBe(0);
    }
    const cookie = registration.headers['set-cookie'][0].split(';')[0];
    const closeClient = vi.spyOn(connection.getClient(), 'close');
    try {
      await one.store.close();
      await one.store.close();
      expect(closeClient).not.toHaveBeenCalled();
      await request(two.app).get('/api/auth/me').set('Cookie', cookie).expect(200);
      await request(two.app).post('/api/auth/login').send({ email: 'isolated@example.com', password: 'EphemeralPassword!2026' }).expect(200);
      await agent.get('/api/auth/me').expect(200);
      expect((await request(two.app).get('/').expect(200)).body).toEqual({ name: 'Mnemo API', status: 'ok', health: '/api/health', ready: '/api/ready' });
      expect((await request(two.app).get('/api/health').expect(200)).body).toEqual({ status: 'ok' });
      expect((await request(two.app).get('/api/ready').expect(200)).body).toEqual({ status: 'ok', connected: true });
      await expect(getMongo({ ...config, MONGODB_DB: 'refused_db' })).rejects.toThrow('autre configuration');
      await expect(getMongo({ ...config, MONGODB_URI: mongo.getUri('refused_uri') })).rejects.toThrow('autre configuration');
      await db.dropDatabase();
      await mongoose.disconnect();
      expect(closeClient).toHaveBeenCalledTimes(1);
      expect((await request(two.app).get('/api/ready').expect(503)).body).toEqual({ status: 'unavailable', connected: false });
    } finally { closeClient.mockRestore(); }
  });
});