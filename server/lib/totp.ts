import { createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP (RFC 6238, SHA-1, 6 dígitos, passo de 30 s) — compatível com Google Authenticator, Microsoft Authenticator,
 * Authy, 2FAS etc. Implementação própria com node:crypto (sem dependência externa).
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_S = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** Segredo novo de 160 bits em base32. */
export const generateTotpSecret = () => base32Encode(randomBytes(20));

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP_STEP_S);

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Confere o código aceitando ±1 passo (relógio do celular adiantado/atrasado).
 * Recusa passos já usados (lastStep) — o mesmo código não serve duas vezes. Devolve o passo aceito ou null.
 */
export function verifyTotp(secret: string, code: string, lastStep?: number | null, now = Date.now()): number | null {
  const c = String(code).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = currentStep(now);
  for (const step of [cur - 1, cur, cur + 1]) {
    if (lastStep !== null && lastStep !== undefined && step <= lastStep) continue;
    if (totpCode(secret, step) === c) return step;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'MCK') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_S}`;
}

/** Códigos de recuperação: 10 códigos XXXXX-XXXXX (base32, ~50 bits cada). */
export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const s = base32Encode(randomBytes(7)).slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

export const normalizeRecoveryCode = (c: string) => String(c).toUpperCase().replace(/[^A-Z2-7]/g, '');
