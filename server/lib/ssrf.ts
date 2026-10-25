import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

type Resolver = (host: string) => Promise<string[]>;
const realResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
let resolver: Resolver = realResolver;
/** Somente testes: evita depender de DNS real. */
export function setResolver(fn: Resolver | null) {
  if (process.env.NODE_ENV !== 'test') throw new Error('setResolver só pode ser usado em testes');
  resolver = fn ?? realResolver;
}

/** Bloqueia requisições para redes internas (proteção SSRF do bloco HTTP e integrações). */
export function isPrivateAddress(ip: string): boolean {
  if (ip === '::1' || ip === '::' ) return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = ip.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

export async function assertPublicUrl(rawUrl: string, allowPrivate = process.env.ALLOW_PRIVATE_HTTP === 'true'): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('URL inválida');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Apenas http e https são permitidos');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) throw new Error('Endereço interno bloqueado');
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : await resolver(host);
  } catch {
    throw new Error(`Não foi possível resolver o domínio ${host}`);
  }
  if (addrs.some(isPrivateAddress)) throw new Error('Endereço interno bloqueado');
  return url;
}
