/**
 * v1.44.0 — Origem do lead (puro, testável).
 * Links wa.me com um código no texto ("Olá! [ref:instagram-bio]"): ao chegar a mensagem, o código é lido,
 * gravado como origem da conversa/contato e tirado do texto (a IA e a equipe veem só "Olá!").
 * Na API oficial, o "referral" dos anúncios Click-to-WhatsApp vira a origem "anuncio" com os dados do anúncio.
 */

export const CODIGO_MAX = 40;
/** Origens fixas (não são links cadastrados). */
export const ORIGEM_ANUNCIO = 'anuncio';
export const ORIGEM_SITE = 'site';
export const ORIGENS_FIXAS: Record<string, string> = { [ORIGEM_ANUNCIO]: 'Anúncio (Click-to-WhatsApp)', [ORIGEM_SITE]: 'Chat do site' };

/** "Instagram Bio!" → "instagram-bio". Vazio quando não sobra nada válido. */
export function normalizarCodigo(s: string): string {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, CODIGO_MAX);
}

// [ref:codigo] (com ou sem colchetes, espaços tolerados, maiúsculas ou minúsculas).
const REF_RE = /\[\s*ref\s*:\s*([a-z0-9_-]{1,40})\s*\]|(?:^|\s)ref\s*:\s*([a-z0-9_-]{1,40})(?=\s|$)/i;

/** Lê o código de origem do texto. Devolve o código e o texto sem ele (ou null se não houver código). */
export function lerCodigo(texto: string | null | undefined): { codigo: string; texto: string } | null {
  if (!texto) return null;
  const m = REF_RE.exec(texto);
  if (!m) return null;
  const codigo = normalizarCodigo(m[1] ?? m[2] ?? '');
  if (!codigo) return null;
  const limpo = (texto.slice(0, m.index) + texto.slice(m.index + m[0].length)).replace(/[ \t]{2,}/g, ' ').trim();
  return { codigo, texto: limpo };
}

/** Texto pré-preenchido do link: "Olá! [ref:codigo]". */
export function textoDoLink(texto: string, codigo: string): string {
  const base = (texto || 'Olá!').trim().slice(0, 300);
  return `${base} [ref:${codigo}]`;
}

/** Link wa.me com o texto pré-preenchido. Número só com dígitos (DDI+DDD+número). */
export function linkWaMe(numero: string, texto: string, codigo: string): string | null {
  const d = (numero || '').replace(/\D/g, '');
  if (d.length < 10 || d.length > 15) return null;
  return `https://wa.me/${d}?text=${encodeURIComponent(textoDoLink(texto, codigo))}`;
}

export interface Referral {
  sourceUrl?: string; sourceId?: string; sourceType?: string; headline?: string; body?: string; ctwaClid?: string; mediaType?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Objeto "referral" da mensagem da Cloud API (anúncio Click-to-WhatsApp / post). Puro. */
export function lerReferral(raw: any): Referral | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = (v: unknown, n = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
  const r: Referral = {
    sourceUrl: s(raw.source_url, 500), sourceId: s(raw.source_id, 100), sourceType: s(raw.source_type, 30),
    headline: s(raw.headline, 200), body: s(raw.body, 300), ctwaClid: s(raw.ctwa_clid, 300), mediaType: s(raw.media_type, 30),
  };
  return Object.values(r).some(Boolean) ? r : undefined;
}

/** Nome da origem para a tela. */
export function rotuloOrigem(codigo: string | null | undefined, nomes: Map<string, string>): string {
  if (!codigo) return 'Sem origem';
  return nomes.get(codigo) ?? ORIGENS_FIXAS[codigo] ?? codigo;
}

export interface LinhaOrigem { origem: string | null; rotulo: string; conversas: number; leads: number }

/** Junta conversas e leads (contatos novos) por origem, maior primeiro; "Sem origem" por último. Puro. */
export function agruparOrigens(conversas: (string | null)[], leads: (string | null)[], nomes: Map<string, string>): LinhaOrigem[] {
  const mapa = new Map<string | null, LinhaOrigem>();
  const linha = (o: string | null) => {
    let l = mapa.get(o);
    if (!l) { l = { origem: o, rotulo: rotuloOrigem(o, nomes), conversas: 0, leads: 0 }; mapa.set(o, l); }
    return l;
  };
  for (const o of conversas) linha(o || null).conversas++;
  for (const o of leads) linha(o || null).leads++;
  return [...mapa.values()].sort((a, b) => (a.origem === null ? 1 : 0) - (b.origem === null ? 1 : 0) || b.conversas - a.conversas || b.leads - a.leads || a.rotulo.localeCompare(b.rotulo));
}
