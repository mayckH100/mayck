import { describe, it, expect, afterEach } from 'vitest';
import { parseFrom, brevoConfigured, smtpConfigured } from '../../server/lib/mailer.js';

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['BREVO_API_KEY', 'MAIL_FROM', 'SMTP_HOST']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('e-mail pela API do Brevo', () => {
  it('lê MAIL_FROM com e sem nome', () => {
    expect(parseFrom('MCKBOT <no-reply@mck.com.br>')).toEqual({ name: 'MCKBOT', email: 'no-reply@mck.com.br' });
    expect(parseFrom('"MCK Mensagens" <a@b.com>')).toEqual({ name: 'MCK Mensagens', email: 'a@b.com' });
    expect(parseFrom('no-reply@mck.com.br')).toEqual({ email: 'no-reply@mck.com.br' });
  });

  it('considera e-mail configurado só com BREVO_API_KEY + MAIL_FROM (sem SMTP)', () => {
    delete process.env.SMTP_HOST;
    process.env.BREVO_API_KEY = 'x';
    delete process.env.MAIL_FROM;
    expect(brevoConfigured()).toBe(false);
    process.env.MAIL_FROM = 'MCKBOT <no-reply@mck.com.br>';
    expect(brevoConfigured()).toBe(true);
    expect(smtpConfigured()).toBe(true);
    delete process.env.BREVO_API_KEY;
    expect(smtpConfigured()).toBe(false);
  });
});
