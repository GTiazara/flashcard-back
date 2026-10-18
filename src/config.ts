import { z } from 'zod';
import { CARD_TEXT_MAX_LENGTH } from './limits.js';

const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const databaseName = z.preprocess(
  value => typeof value === 'string' ? value.trim() || undefined : value,
  z.string().refine(value => !/[\s/\\.$*?"<>:|\p{Cc}\p{Cs}]/u.test(value) && Buffer.byteLength(value, 'utf8') <= 63,
    'MONGODB_DB doit être un nom de base sûr de 1 à 63 octets UTF-8, sans espaces, caractères réservés ni contrôles.').optional(),
);
const origin = z.url().refine(v => {
  try {
    const u = new URL(v);
    return ['http:', 'https:'].includes(u.protocol) && u.origin === v;
  } catch { return false; }
}, 'Une origine HTTP(S) exacte sans chemin ni slash final est requise.');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z.string().trim().min(1, 'MONGODB_URI est vide : renseignez une URI MongoDB dans .env.')
    .regex(/^mongodb(?:\+srv)?:\/\//, 'MONGODB_URI doit être une URI MongoDB.'),
  MONGODB_DB: databaseName,
  MONGODB_TRANSACTIONS: z.enum(['auto', 'required']).default('auto'),
  SESSION_SECRET: z.string().min(32),
  FRONTEND_URL: origin.default('http://localhost:5173'),
  CORS_ORIGIN: origin.default('http://localhost:5173'),
  REQUIRE_EMAIL_VERIFICATION: bool.default(false),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(2592000).default(604800),
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(30),
  CARD_TEXT_MAX_LENGTH: z.coerce.number().int().min(1).max(CARD_TEXT_MAX_LENGTH).default(CARD_TEXT_MAX_LENGTH),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().default(''),
}).superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (Boolean(v.SMTP_USER) !== Boolean(v.SMTP_PASS)) issue('SMTP_USER et SMTP_PASS doivent être renseignés ensemble.');
  if (v.SMTP_HOST && !z.email().safeParse(v.MAIL_FROM).success) issue('MAIL_FROM doit être un email valide avec SMTP.');
  if (!v.SMTP_HOST && (v.SMTP_USER || v.SMTP_PASS || v.MAIL_FROM)) issue('SMTP_HOST est requis pour la configuration SMTP.');
  if (v.NODE_ENV === 'production') {
    if (v.SESSION_SECRET.length < 48 || /replace|change|example/i.test(v.SESSION_SECRET)) issue('SESSION_SECRET de production : au moins 48 caractères aléatoires, sans valeur exemple.');
    if (![v.CORS_ORIGIN, v.FRONTEND_URL].every(url => url.startsWith('https://'))) issue('HTTPS requis en production pour les origines.');
    if (!v.SMTP_HOST) issue('SMTP_HOST est requis en production pour la récupération du compte.');
  }
});

export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Configuration invalide : ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}