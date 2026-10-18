import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export async function sendToken(config: Config, email: string, token: string, kind: 'reset' | 'verification') {
  const url = new URL(kind === 'reset' ? '/reset-password' : '/verify-email', config.FRONTEND_URL);
  url.searchParams.set('token', token);
  if (!config.SMTP_HOST) {
    if (config.NODE_ENV === 'production') throw new Error('SMTP non configuré.');
    return url.toString();
  }
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE,
    requireTLS: config.NODE_ENV === 'production' && !config.SMTP_SECURE,
    ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } } : {}),
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
  await transport.sendMail({
    from: config.MAIL_FROM, to: email,
    subject: kind === 'reset' ? 'Réinitialisation de votre mot de passe' : 'Confirmation de votre adresse email',
    text: `Pour ${kind === 'reset' ? 'réinitialiser votre mot de passe (1 heure)' : 'confirmer votre adresse email (24 heures)'}, ouvrez ce lien : ${url.toString()}\nSi vous n’êtes pas à l’origine de cette demande, ignorez ce message.`,
  });
  return undefined;
}