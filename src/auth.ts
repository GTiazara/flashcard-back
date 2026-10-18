import { Router, type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { User } from './models.js';
import { HttpError, publicUser } from './http.js';
import { sendToken } from './mail.js';

declare module 'express-session' {
  interface SessionData { userId: string; authVersion: number }
}
declare global {
  namespace Express { interface Request { userId?: string } }
}
const email = z.email().max(254).transform(v => v.toLowerCase());
// bcrypt ne prend en compte que les 72 premiers octets.
const password = z.string().min(12).max(72).refine(v => Buffer.byteLength(v, 'utf8') <= 72, 'Maximum 72 octets UTF-8.');
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const token = () => randomBytes(32).toString('hex');
const guestCookieName = 'mnemo.guest';
const guestCookieAge = 400 * 24 * 60 * 60 * 1000;
function cookieOptions(config: Config) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: config.NODE_ENV === 'production', path: '/' };
}
function clearGuestCookie(res: Response, config: Config) { res.clearCookie(guestCookieName, cookieOptions(config)); }
// Pas de dépendance cookie-parser : décodage borné, doublons et encodages invalides refusés.
function guestCookie(req: Request): string | undefined {
  const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${guestCookieName}=`));
  if (values.length !== 1 || values[0]!.length > 256) return undefined;
  try {
    const value = decodeURIComponent(values[0]!.slice(guestCookieName.length + 1));
    return tokenSchema.safeParse(value).success ? value : undefined;
  } catch { return undefined; }
}
function guestIdentity() {
  const colors = ['Azur', 'Corail', 'Jade', 'Indigo', 'Ambre', 'Lilas'];
  const objects = ['Nuage', 'Carnet', 'Galet', 'Bambou', 'Prisme', 'Sillage'];
  const suffix = randomBytes(6).toString('hex');
  return { username: `invite_${suffix}`, displayName: `${objects[randomBytes(1)[0]! % objects.length]} ${colors[randomBytes(1)[0]! % colors.length]} · ${suffix.slice(0, 4)}` };
}

export async function identify(req: Request, _res: Response, next: NextFunction) {
  if (req.session.userId) {
    const user = await User.findById(req.session.userId).select('+authVersion');
    if (user && (user.isGuest || user.emailVerified) && user.authVersion === req.session.authVersion) req.userId = user.id;
    else await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  }
  next();
}
export function authenticated(req: Request, _res: Response, next: NextFunction) {
  if (!req.userId) throw new HttpError(401, 'Authentification requise.');
  next();
}
async function loginSession(req: Request, user: { _id: unknown; authVersion: number }) {
  await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.userId = String(user._id);
  req.session.authVersion = user.authVersion;
  await new Promise<void>((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
}

export function authRouter(config: Config) {
  const router = Router();
  router.post('/guest', async (req, res) => {
    z.object({}).strict().parse(req.body);
    const current = req.userId ? await User.findById(req.userId).select('+authVersion') : null;
    if (current) {
      // Une session valide prime toujours sur un éventuel cookie d'un autre profil.
      if (current.isGuest) await loginSession(req, current);
      return res.json(publicUser(current));
    }
    const deviceToken = guestCookie(req);
    let user = deviceToken ? await User.findOne({ isGuest: true, guestTokenHash: hash(deviceToken) }).select('+authVersion') : null;
    let newToken: string | undefined;
    if (!user) {
      // Ne jamais adopter un token fourni mais inconnu : évite la fixation d'identité.
      newToken = token();
      user = await User.create({ isGuest: true, guestTokenHash: hash(newToken), ...guestIdentity() });
    }
    await loginSession(req, user);
    if (newToken) res.cookie(guestCookieName, newToken, { ...cookieOptions(config), maxAge: guestCookieAge });
    return res.json(publicUser(user));
  });
  router.get('/me', authenticated, async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) throw new HttpError(401, 'Session invalide.');
    res.json(publicUser(user));
  });
  router.post('/register', async (req, res) => {
    const input = z.object({
      email, password, username: z.string().regex(/^[a-z0-9_]{3,24}$/),
      displayName: z.string().trim().min(1).max(80),
    }).strict().parse(req.body);
    const previous = req.userId ? await User.findById(req.userId).select('+guestTokenHash +authVersion') : null;
    if (previous && !previous.isGuest) throw new HttpError(409, 'Déconnectez-vous avant de créer un autre compte.');
    const verificationToken = token();
    const identity = {
      isGuest: false,
      email: input.email, username: input.username, displayName: input.displayName,
      passwordHash: await bcrypt.hash(input.password, 12),
      emailVerified: !config.REQUIRE_EMAIL_VERIFICATION,
      ...(config.REQUIRE_EMAIL_VERIFICATION ? {
        verificationTokenHash: hash(verificationToken), verificationExpiresAt: new Date(Date.now() + 86400000),
      } : {}),
    };
    const user = previous
      ? await User.findOneAndUpdate({ _id: previous._id, isGuest: true, authVersion: previous.authVersion, guestTokenHash: previous.guestTokenHash }, {
        $set: identity, $inc: { authVersion: 1 }, $unset: { guestTokenHash: 1, resetTokenHash: 1, resetExpiresAt: 1 },
      }, { new: true, runValidators: true }).select('+authVersion')
      : await User.create(identity);
    if (!user) throw new HttpError(409, 'Ce profil a déjà été converti. Reconnectez-vous.');
    if (config.REQUIRE_EMAIL_VERIFICATION) {
      let devVerificationUrl: string | undefined;
      try { devVerificationUrl = await sendToken(config, input.email, verificationToken, 'verification'); }
      catch {
        if (previous) {
          // Compensation CAS : ne jamais restaurer par-dessus une confirmation ou un reset concurrent.
          await User.updateOne({ _id: user._id, isGuest: false, emailVerified: false, authVersion: user.authVersion, verificationTokenHash: hash(verificationToken) }, {
            $set: { isGuest: true, username: previous.username, displayName: previous.displayName, emailVerified: false,
              authVersion: previous.authVersion, guestTokenHash: previous.guestTokenHash },
            $unset: { email: 1, passwordHash: 1, verificationTokenHash: 1, verificationExpiresAt: 1 },
          });
        } else await User.deleteOne({ _id: user._id, emailVerified: false, verificationTokenHash: hash(verificationToken) });
        throw new HttpError(503, 'Email de confirmation indisponible. Réessayez plus tard.');
      }
      if (previous) await new Promise<void>((resolve, reject) => req.session.destroy(err => err ? reject(err) : resolve()));
      if (previous || req.headers.cookie?.includes(`${guestCookieName}=`)) clearGuestCookie(res, config);
      if (previous) res.clearCookie('flashcard.sid', cookieOptions(config));
      res.status(201).json({ requiresVerification: true, message: 'Confirmez votre adresse email avant de vous connecter.', ...(devVerificationUrl ? { devVerificationUrl } : {}) });
    } else {
      await loginSession(req, user);
      if (previous || req.headers.cookie?.includes(`${guestCookieName}=`)) clearGuestCookie(res, config);
      res.status(201).json(publicUser(user));
    }
  });
  router.post('/login', async (req, res) => {
    const input = z.object({ email, password: z.string().min(1).max(256) }).strict().parse(req.body);
    const user = await User.findOne({ email: input.email, isGuest: { $ne: true } }).select('+passwordHash +authVersion');
    // Un hash factice évite le chemin rapide pour les emails inconnus.
    const valid = await bcrypt.compare(input.password, user?.passwordHash ?? dummyHash);
    if (!user || !valid) throw new HttpError(401, 'Email ou mot de passe incorrect.');
    if (!user.emailVerified) throw new HttpError(403, 'Confirmez votre adresse email.');
    await loginSession(req, user);
    clearGuestCookie(res, config);
    res.json(publicUser(user));
  });
  router.post('/logout', async (req, res) => {
    await new Promise<void>((resolve, reject) => req.session.destroy(err => err ? reject(err) : resolve()));
    res.clearCookie('flashcard.sid', { httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production', path: '/' });
    clearGuestCookie(res, config);
    res.sendStatus(204);
  });
  router.post('/forgot-password', async (req, res) => {
    const input = z.object({ email }).strict().parse(req.body);
    // Désactivation globale avant génération de jeton ou recherche de compte.
    if (config.NODE_ENV === 'production' && !config.SMTP_HOST) {
      throw new HttpError(503, 'La récupération de mot de passe est indisponible pour le moment.');
    }
    const resetToken = token();
    const user = await User.findOneAndUpdate({ email: input.email, isGuest: { $ne: true } }, {
      $set: { resetTokenHash: hash(resetToken), resetExpiresAt: new Date(Date.now() + 3600000) },
    });
    let devResetUrl: string | undefined;
    if (user) {
      // La réponse SMTP reste générique, y compris si la livraison échoue.
      try { devResetUrl = await sendToken(config, input.email, resetToken, 'reset'); }
      catch { /* Ne jamais journaliser l'email, le jeton ni l'erreur SMTP. */ }
    }
    res.json({ message: 'Si ce compte existe, un lien de réinitialisation a été envoyé.', ...(devResetUrl ? { devResetUrl } : {}) });
  });
  router.post('/reset-password', async (req, res) => {
    const input = z.object({ token: tokenSchema, password }).strict().parse(req.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await User.findOneAndUpdate({ isGuest: { $ne: true }, resetTokenHash: hash(input.token), resetExpiresAt: { $gt: new Date() } }, {
      $set: { passwordHash }, $inc: { authVersion: 1 }, $unset: { resetTokenHash: 1, resetExpiresAt: 1 },
    });
    if (!user) throw new HttpError(400, 'Lien de réinitialisation invalide ou expiré.');
    if (req.session.userId) await new Promise<void>((resolve, reject) => req.session.destroy(err => err ? reject(err) : resolve()));
    res.json({ message: 'Mot de passe réinitialisé. Reconnectez-vous.' });
  });
  router.post('/verify-email', async (req, res) => {
    const input = z.object({ token: tokenSchema }).strict().parse(req.body);
    const user = await User.findOneAndUpdate({ isGuest: { $ne: true }, verificationTokenHash: hash(input.token), verificationExpiresAt: { $gt: new Date() } }, {
      $set: { emailVerified: true }, $unset: { verificationTokenHash: 1, verificationExpiresAt: 1 },
    });
    if (!user) throw new HttpError(400, 'Lien de confirmation invalide ou expiré.');
    res.json({ message: 'Adresse email confirmée. Vous pouvez vous connecter.' });
  });
  return router;
}

const dummyHash = bcrypt.hashSync('not-a-user-password-2387', 12);