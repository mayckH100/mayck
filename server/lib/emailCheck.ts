import { promises as dns } from 'node:dns';
import { DISPOSABLE_DOMAINS_RAW } from './disposableDomains.data.js';

/**
 * Checagens do e-mail antes de enviar o código do cadastro:
 *  - formato;
 *  - domínio descartável/temporário (lista aberta embutida, sem API paga);
 *  - o domínio recebe e-mail (registro MX; sem MX, A/AAAA como no SMTP). Falha transitória do DNS não bloqueia:
 *    o código enviado por e-mail continua sendo a prova final de que o endereço existe.
 */

let disposable: Set<string> | null = null;
function disposableSet() {
  if (!disposable) disposable = new Set(DISPOSABLE_DOMAINS_RAW.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean));
  return disposable;
}

/** true se o domínio (ou qualquer domínio-pai dele, ex.: x.mailinator.com) está na lista de descartáveis. */
export function isDisposableDomain(domain: string): boolean {
  const parts = domain.trim().toLowerCase().replace(/\.$/, '').split('.');
  const set = disposableSet();
  for (let i = 0; i < parts.length - 1; i++) if (set.has(parts.slice(i).join('.'))) return true;
  return false;
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;

export function emailDomain(email: string): string | null {
  const m = EMAIL_RE.exec(email.trim());
  if (!m) return null;
  const local = email.split('@')[0];
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  const domain = m[1].toLowerCase();
  if (!/[a-z]{2,}$/.test(domain.split('.').pop()!)) return null; // TLD com letras
  return domain;
}

export interface DnsResolver {
  mx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  a(domain: string): Promise<string[]>;
  aaaa(domain: string): Promise<string[]>;
}
const realResolver: DnsResolver = { mx: (d) => dns.resolveMx(d), a: (d) => dns.resolve4(d), aaaa: (d) => dns.resolve6(d) };
let resolver: DnsResolver = realResolver;
/** Só para testes: troca o DNS por um simulado (null volta ao real). */
export function setDnsResolver(r: DnsResolver | null) { resolver = r ?? realResolver; }

const DNS_TIMEOUT_MS = 3000;
const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);
class DnsTimeout extends Error { code = 'ETIMEOUT'; }

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new DnsTimeout('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** 'ok' = recebe e-mail; 'none' = domínio não existe/não recebe e-mail; 'unknown' = DNS falhou (deixa passar). */
export async function domainAcceptsMail(domain: string): Promise<'ok' | 'none' | 'unknown'> {
  const deadline = Date.now() + DNS_TIMEOUT_MS;
  const left = () => Math.max(1, deadline - Date.now());
  try {
    const mx = await withTimeout(resolver.mx(domain), left());
    if (mx.length === 0) return 'none';
    // "Null MX" (RFC 7505): o domínio declara que não recebe e-mail.
    if (mx.every((r) => !r.exchange || r.exchange === '.')) return 'none';
    return 'ok';
  } catch (e) {
    if (!NOT_FOUND.has((e as { code?: string }).code ?? '')) return 'unknown';
  }
  // Sem MX: o SMTP entrega no A/AAAA do próprio domínio.
  const results = await Promise.allSettled([withTimeout(resolver.a(domain), left()), withTimeout(resolver.aaaa(domain), left())]);
  if (results.some((r) => r.status === 'fulfilled' && r.value.length > 0)) return 'ok';
  const allNotFound = results.every((r) => r.status === 'rejected' && NOT_FOUND.has((r.reason as { code?: string })?.code ?? ''));
  return allNotFound || results.every((r) => r.status === 'fulfilled') ? 'none' : 'unknown';
}

export type EmailCheck = { ok: true } | { ok: false; error: string };

export async function checkSignupEmail(email: string): Promise<EmailCheck> {
  const domain = emailDomain(email);
  if (!domain) return { ok: false, error: 'E-mail inválido. Confira se digitou certo (ex.: nome@empresa.com.br).' };
  if (isDisposableDomain(domain)) return { ok: false, error: 'Não aceitamos e-mails temporários ou descartáveis. Use seu e-mail pessoal ou da empresa.' };
  const dnsResult = await domainAcceptsMail(domain);
  if (dnsResult === 'none') return { ok: false, error: `O domínio "${domain}" não recebe e-mails. Confira se o endereço está correto.` };
  return { ok: true };
}
