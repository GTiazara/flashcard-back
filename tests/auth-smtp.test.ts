import { afterEach, describe, expect, it, vi } from 'vitest';
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { authRouter } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { User } from '../src/models.js';
import { sendToken } from '../src/mail.js';

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});
vi.mock('../src/mail.js', () => ({ sendToken: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('Récupération désactivée en production sans SMTP', () => {
  it('renvoie le même 503 pour toute adresse valide sans génération, DB ni mail', async () => {
    const config = loadConfig({
      NODE_ENV: 'production', MONGODB_URI: 'mongodb://unused.invalid/isolated', SESSION_SECRET: 'a'.repeat(48),
      FRONTEND_URL: 'https://app.example.com', CORS_ORIGIN: 'https://app.example.com',
    });
    const update = vi.spyOn(User, 'findOneAndUpdate');
    const find = vi.spyOn(User, 'findOne');
    const app = express();
    app.use(express.json(), authRouter(config));
    const errors: ErrorRequestHandler = (error, _req, res, _next) => {
      if (error instanceof HttpError) res.status(error.status).json({ message: error.message });
      else res.status(400).json({ message: 'Données invalides.' });
    };
    app.use(errors);
    const known = await request(app).post('/forgot-password').send({ email: 'known@example.com' }).expect(503);
    const unknown = await request(app).post('/forgot-password').send({ email: 'unknown@example.com' }).expect(503);
    expect(known.body).toEqual({ message: 'La récupération de mot de passe est indisponible pour le moment.' });
    expect(unknown.body).toEqual(known.body);
    await request(app).post('/forgot-password').send({ email: 'invalid' }).expect(400);
    expect(randomBytes).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(sendToken).not.toHaveBeenCalled();
  });
});