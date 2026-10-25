import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, getMasterKey, maskSecret, safeEqual } from '../../server/lib/crypto.js';

describe('Criptografia AES-256-GCM', () => {
  it('cifra e decifra mantendo o texto original', () => {
    const c = encrypt('sk-minha-chave-secreta');
    expect(c).not.toContain('sk-minha');
    expect(c.startsWith('v1:')).toBe(true);
    expect(decrypt(c)).toBe('sk-minha-chave-secreta');
  });
  it('gera IV aleatório (mesmo texto → cifras diferentes)', () => {
    expect(encrypt('abc')).not.toBe(encrypt('abc'));
  });
  it('rejeita dado adulterado (tag de autenticação)', () => {
    const c = encrypt('valor');
    const parts = c.split(':');
    const data = Buffer.from(parts[3], 'base64');
    data[0] ^= 0xff;
    parts[3] = data.toString('base64');
    expect(() => decrypt(parts.join(':'))).toThrow();
  });
  it('rejeita chave mestra errada', () => {
    const c = encrypt('valor');
    expect(() => decrypt(c, randomBytes(32))).toThrow();
  });
  it('exige chave mestra de 32 bytes', () => {
    expect(() => getMasterKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
  it('mascara segredos e compara em tempo constante', () => {
    expect(maskSecret('abcdef123456')).toBe('••••3456');
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'b')).toBe(false);
    expect(safeEqual('a', 'ab')).toBe(false);
  });
});
