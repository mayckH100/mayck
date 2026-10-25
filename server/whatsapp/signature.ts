import { hmacSha256Hex, safeEqual } from '../lib/crypto.js';

/** Valida o cabeçalho X-Hub-Signature-256 ("sha256=<hex>") enviado pela Meta. */
export function verifyHubSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + hmacSha256Hex(appSecret, rawBody);
  return safeEqual(header, expected);
}
