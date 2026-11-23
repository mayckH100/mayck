import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Formato do texto cifrado: v1:<iv b64>:<tag b64>:<dados b64> (AES-256-GCM). */
const PREFIX = 'v1';

export function getMasterKey(raw = process.env.MASTER_KEY): Buffer {
  if (!raw) {
    if (process.env.NODE_ENV === 'production') throw new Error('MASTER_KEY ausente');
    // Somente dev/teste: chave derivada fixa para permitir rodar localmente sem configuração.
    return createHash('sha256').update('mckbot-dev-only-key').digest();
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY deve ter 32 bytes em base64');
  return key;
}

export function encrypt(plain: string, key: Buffer = getMasterKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(payload: string, key: Buffer = getMasterKey()): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error('Formato de dado cifrado inválido');
  const [, ivB, tagB, dataB] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptOrNull(v?: string | null): string | null {
  return v ? encrypt(v) : null;
}
export function decryptOrNull(v?: string | null): string | null {
  return v ? decrypt(v) : null;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function hmacSha256Hex(secret: string, data: Buffer | string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Mostra apenas o final de um segredo (para exibir na UI). */
export function maskSecret(v?: string | null): string | null {
  if (!v) return null;
  return v.length <= 4 ? '••••' : '••••' + v.slice(-4);
}

/** v1.47.0: cifra bytes (ex.: amostra de voz) com AES-256-GCM. Formato: 'MCK1' + iv(12) + tag(16) + dados. */
export function encryptBytes(plain: Buffer, key: Buffer = getMasterKey(), aad?: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('MCK1'), iv, cipher.getAuthTag(), data]);
}
export function decryptBytes(payload: Buffer, key: Buffer = getMasterKey(), aad?: string): Buffer {
  if (payload.length < 32 || payload.toString('ascii', 0, 4) !== 'MCK1') throw new Error('Formato de dado cifrado inválido');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(4, 16));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(payload.subarray(16, 32));
  return Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]);
}
