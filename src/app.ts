import express, { type ErrorRequestHandler } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { HttpError } from './http.js';
import { authRouter, identify } from './auth.js';
import { apiRouter } from './routes.js';
import { createMutationExecutor } from './data.js';
import { SharedMongoStore } from './session-store.js';
import { isAllowedOrigin } from './origin.js';

export function createApp(config: Config, options: { transactions: boolean } = { transactions: true }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet());
  app.use((req, _res, next) => {
    const origin = req.get('origin');
    if (!isAllowedOrigin(origin, config)) throw new HttpError(403, 'Origine non autorisée.');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Content-Type application/json requis.');
    next();
  });
  app.use(cors({
    origin: (origin, callback) => callback(null, origin !== undefined && isAllowedOrigin(origin, config) ? origin : false),
    credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));
  app.use(express.json({ limit: '256kb', strict: true }));
  app.get('/', (_req, res) => res.json({ name: 'Mnemo API', status: 'ok', health: '/api/health', ready: '/api/ready' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/ready', (_req, res) => {
    const connected = mongoose.connection.readyState === 1;
    res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'unavailable', connected });
  });
  const store = new SharedMongoStore(config);
  store.on('error', () => { console.error('Stockage de session indisponible.'); });
  app.use(session({
    name: 'flashcard.sid', secret: config.SESSION_SECRET, store,
    resave: false, saveUninitialized: false, unset: 'destroy',
    cookie: { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'lax', maxAge: config.SESSION_TTL_SECONDS * 1000, path: '/' },
  }));
  app.use(identify);
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: config.AUTH_RATE_LIMIT,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { message: 'Trop de tentatives. Réessayez dans 15 minutes.' },
  });
  const execute = createMutationExecutor(options.transactions);
  app.use('/api/auth', (req, res, next) => req.method === 'POST' ? authLimiter(req, res, next) : next(), authRouter(config, execute));
  app.use('/api', apiRouter(config, execute));
  app.use((_req, _res) => { throw new HttpError(404, 'Route introuvable.'); });
  const errors: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    if (err instanceof ZodError) res.status(400).json({ message: 'Données invalides.', errors: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    else if (err instanceof HttpError) res.status(err.status).json({ message: err.message });
    else if (err instanceof mongoose.Error.ValidationError || err instanceof mongoose.Error.CastError) res.status(400).json({ message: 'Données invalides.' });
    else if (typeof err === 'object' && err !== null && 'code' in err && err.code === 11000) res.status(409).json({ message: 'Cette valeur existe déjà (email, nom d’utilisateur ou relation unique).' });
    else if (err instanceof SyntaxError && 'body' in err) res.status(400).json({ message: 'JSON invalide.' });
    else if (typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.too.large') res.status(413).json({ message: 'Corps de requête trop volumineux.' });
    else {
      console.error('Erreur interne du serveur.');
      res.status(500).json({ message: 'Erreur interne du serveur.' });
    }
  };
  app.use(errors);
  return { app, store };
}