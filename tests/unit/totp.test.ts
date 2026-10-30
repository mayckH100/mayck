import { describe, it, expect } from 'vitest';
import { base32Decode, base32Encode, totpCode, verifyTotp, currentStep, generateRecoveryCodes, normalizeRecoveryCode, otpauthUrl } from '../../server/lib/totp.js';

describe('TOTP (RFC 6238)', () => {
  // Vetores oficiais do RFC 6238 (SHA-1, segredo "12345678901234567890"), truncados a 6 dígitos.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']])('t=%i → %s', (t, code) => {
    expect(totpCode(secret, Math.floor(t / 30))).toBe(code);
  });
  it('base32 ida e volta', () => {
    const b = Buffer.from([0, 1, 2, 250, 251, 252, 253, 7]);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
  it('aceita ±1 passo, recusa código reutilizado e lixo', () => {
    const now = Date.now();
    const s = currentStep(now);
    expect(verifyTotp(secret, totpCode(secret, s), null, now)).toBe(s);
    expect(verifyTotp(secret, totpCode(secret, s - 1), null, now)).toBe(s - 1);
    expect(verifyTotp(secret, totpCode(secret, s - 3), null, now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, s), s, now)).toBeNull(); // já usado
    expect(verifyTotp(secret, 'abcdef', null, now)).toBeNull();
  });
  it('códigos de recuperação únicos no formato XXXXX-XXXXX', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect(normalizeRecoveryCode(codes[0].toLowerCase())).toHaveLength(10);
  });
  it('URL otpauth para o app autenticador', () => {
    expect(otpauthUrl('ABC', 'a@b.com')).toBe('otpauth://totp/MCK%3Aa%40b.com?secret=ABC&issuer=MCK&algorithm=SHA1&digits=6&period=30');
  });
});
