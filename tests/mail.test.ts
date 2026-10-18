import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { loadConfig } from '../src/config.js';
import { sendToken } from '../src/mail.js';

const base = {
  MONGODB_URI: 'mongodb://unused.invalid/isolated', SESSION_SECRET: 'a'.repeat(48),
  FRONTEND_URL: 'https://app.example.com', CORS_ORIGIN: 'https://app.example.com',
};
afterEach(() => vi.restoreAllMocks());

describe('sendToken : aucun fallback de production', () => {
  it.each(['reset', 'verification'] as const)('refuse %s sans SMTP avec une erreur sûre', async kind => {
    const transport = vi.spyOn(nodemailer, 'createTransport');
    await expect(sendToken(loadConfig({ ...base, NODE_ENV: 'production' }), 'private@example.com', 'private-token', kind))
      .rejects.toThrow(/^SMTP non configuré\.$/);
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['development', 'test'])('conserve les liens explicites sans SMTP en %s', async NODE_ENV => {
    const transport = vi.spyOn(nodemailer, 'createTransport');
    for (const kind of ['reset', 'verification'] as const) {
      const url = await sendToken(loadConfig({ ...base, NODE_ENV }), 'private@example.com', 'test-token', kind);
      expect(url).toBe(`https://app.example.com/${kind === 'reset' ? 'reset-password' : 'verify-email'}?token=test-token`);
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it('envoie via SMTP en production sans exposer le lien et exige STARTTLS', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const transport = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const config = loadConfig({ ...base, NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'mail@example.com' });
    expect(await sendToken(config, 'private@example.com', 'test-token', 'reset')).toBeUndefined();
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true }));
    expect(sendMail).toHaveBeenCalledOnce();
  });
});