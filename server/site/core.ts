/**
 * v1.44.0 — Chat para o site do cliente (puro, testável): limite por IP, origem autorizada e formatação.
 */
import { createHash } from 'node:crypto';

/** Limite por janela fixa (ex.: 20 por minuto por IP). Memória do processo; o relógio é injetável para testes. */
export class JanelaLimite {
  private mapa = new Map<string, { inicio: number; n: number }>();
  constructor(private max: number, private janelaMs: number, private agora: () => number = Date.now) {}
  /** true = pode; false = passou do limite. Conta a tentativa. */
  tentar(chave: string): boolean {
    const t = this.agora();
    let e = this.mapa.get(chave);
    if (!e || t - e.inicio >= this.janelaMs) { e = { inicio: t, n: 0 }; this.mapa.set(chave, e); }
    e.n++;
    if (this.mapa.size > 20000) this.limpar(t);
    return e.n <= this.max;
  }
  /** Segundos até liberar (para o cabeçalho Retry-After). */
  esperaSeg(chave: string): number {
    const e = this.mapa.get(chave);
    return e ? Math.max(1, Math.ceil((e.inicio + this.janelaMs - this.agora()) / 1000)) : 1;
  }
  limpar(t = this.agora()) { for (const [k, e] of this.mapa) if (t - e.inicio >= this.janelaMs) this.mapa.delete(k); }
  reset() { this.mapa.clear(); }
}

/** Lista de domínios autorizados (um por linha ou separados por vírgula): "loja.com.br", "*.loja.com.br". */
export function lerDominios(raw: string | null | undefined): string[] {
  return [...new Set((raw ?? '').split(/[\n,;\s]+/).map((d) => d.trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')).filter((d) => /^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$|^localhost$/.test(d)))].slice(0, 20);
}

/** A origem (cabeçalho Origin) pode usar o chat? Lista vazia = qualquer site. */
export function origemPermitida(origin: string | null | undefined, dominios: string[]): boolean {
  if (!dominios.length) return true;
  if (!origin) return false;
  let host: string;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  return dominios.some((d) => d.startsWith('*.') ? host === d.slice(2) || host.endsWith(d.slice(1)) : host === d || host === `www.${d}`);
}

/** Id do visitante gerado pelo widget: 32 a 64 caracteres hexadecimais. */
export const visitanteValido = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32,64}$/.test(v);

/** Identificador do contato do visitante (não revela o segredo do navegador). */
export function waIdDoVisitante(publicKey: string, visitante: string): string {
  return 'site:' + createHash('sha256').update(`${publicKey}:${visitante}`).digest('hex').slice(0, 24);
}

/** Cor #rrggbb válida (senão a padrão). */
export const corValida = (c: unknown, padrao = '#d90429') => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : padrao);

/** Texto do visitante: sem caracteres de controle, até 2.000 caracteres. */
export function limparTexto(t: unknown, max = 2000): string {
  // eslint-disable-next-line no-control-regex
  return String(t ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

/** Código para colar no site. */
export function codigoEmbed(base: string, publicKey: string): string {
  return `<script src="${base.replace(/\/+$/, '')}/widget.js" data-org="${publicKey}" async></script>`;
}
