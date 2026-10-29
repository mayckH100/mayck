import { lookup } from 'node:dns/promises';
import { lookup as lookupCb, type LookupAddress } from 'node:dns';
import { isIP, BlockList } from 'node:net';
import { Agent } from 'undici';
import { httpFetch } from './fetcher.js';

type Resolver = (host: string) => Promise<string[]>;
const realResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
let resolver: Resolver = realResolver;
/** Somente testes: evita depender de DNS real. */
export function setResolver(fn: Resolver | null) {
  if (process.env.NODE_ENV !== 'test') throw new Error('setResolver só pode ser usado em testes');
  resolver = fn ?? realResolver;
}

// Redes que nunca podem ser alvo de requisições feitas pelo servidor (proteção SSRF).
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** Endereço IPv4 embutido em IPv6 (::ffff:a.b.c.d, ::ffff:7f00:1, NAT64 64:ff9b::/96, 6to4 2002::/16, ::a.b.c.d). */
function embeddedV4(ip: string): string | null {
  const l = ip.toLowerCase();
  const dotted = /^(?:::ffff:(?:0:)?|64:ff9b::|::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(l);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:(?:0:)?|64:ff9b::|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
  if (hex) {
    const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  const six = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(l);
  if (six) {
    const a = parseInt(six[1], 16), b = parseInt(six[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** Bloqueia requisições para redes internas/reservadas (proteção SSRF do bloco HTTP, integrações e IA). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v === 6) {
    const v4 = embeddedV4(ip);
    if (v4) return isIP(v4) !== 4 || blocked.check(v4, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true; // não é IP válido: trata como bloqueado
}

export async function assertPublicUrl(rawUrl: string, allowPrivate = process.env.ALLOW_PRIVATE_HTTP === 'true'): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('URL inválida');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Apenas http e https são permitidos');
  if (url.username || url.password) throw new Error('URL com usuário/senha embutidos não é permitida');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new Error('Endereço interno bloqueado');
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : await resolver(host);
  } catch {
    throw new Error(`Não foi possível resolver o domínio ${host}`);
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error('Endereço interno bloqueado');
  return url;
}

/**
 * Lookup usado na conexão real: confere o IP no momento de conectar, fechando a brecha de
 * DNS rebinding (o domínio resolver para um IP público na checagem e interno na conexão).
 */
function guardedLookup(hostname: string, options: any, cb: (...args: any[]) => void) {
  lookupCb(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = (Array.isArray(addrs) ? addrs : []) as LookupAddress[];
    if (process.env.ALLOW_PRIVATE_HTTP !== 'true' && (!list.length || list.some((a) => isPrivateAddress(a.address)))) {
      return cb(Object.assign(new Error('Endereço interno bloqueado'), { code: 'ESSRF' }));
    }
    if (options?.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}
let agent: Agent | null = null;
const safeAgent = () => (agent ??= new Agent({ connect: { lookup: guardedLookup as any } }));

const SAFE_HEADERS = new Set(['content-type', 'accept', 'user-agent']);

/**
 * fetch para URLs informadas por clientes (bloco HTTP dos fluxos, integrações, IA com URL própria).
 * Valida cada salto de redirecionamento, confere o IP na conexão e não repassa cabeçalhos
 * de autenticação para outro domínio num redirecionamento.
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let url = (await assertPublicUrl(rawUrl)).toString();
  let opts: RequestInit = { ...init };
  for (let hop = 0; ; hop++) {
    const res = await httpFetch(url, { ...opts, redirect: 'manual', ...({ dispatcher: safeAgent() } as object) });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) return res;
    if (hop >= maxRedirects) throw new Error('Redirecionamentos demais');
    const next = await assertPublicUrl(new URL(loc, url).toString());
    const method = String(opts.method ?? 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) opts = { ...opts, method: 'GET', body: undefined };
    if (next.origin !== new URL(url).origin) {
      const h: Record<string, string> = {};
      new Headers(opts.headers).forEach((v, k) => { if (SAFE_HEADERS.has(k)) h[k] = v; });
      opts = { ...opts, headers: h };
    }
    url = next.toString();
  }
}
