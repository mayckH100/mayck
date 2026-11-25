/**
 * v1.52.0 — Promoção do 1º mês (ex.: Black Friday MCK, aprovada pelo Mayck em 24/11/2026).
 *
 * Regra:
 *  - vale só no ciclo MENSAL, só no PRIMEIRO pagamento confirmado da empresa (empresa que nunca pagou nenhum plano);
 *  - preço especial por plano (centavos), menor que o preço normal; do 2º mês em diante, o preço normal;
 *  - vale para checkout aberto até `ate` (data/hora com fuso). Depois disso some sozinha do site, do app e do checkout;
 *    pagamento de checkout aberto dentro do prazo é honrado (como o cupom);
 *  - o uso só conta com pagamento confirmado (a elegibilidade é conferida de novo no aviso do Mercado Pago);
 *  - não acumula com cupom nem com a promoção de entrada antiga: vale o menor preço;
 *  - `faixa` = texto da faixa no topo do site (vazio = usa o nome). Desligada por padrão.
 *
 * Configuração: PlatformSettings.promoJson (Painel Master › Configurações). Este arquivo é puro (sem banco).
 */
import type { Cycle, PlanProduct } from './service.js';

const PLANOS: PlanProduct[] = ['MCKBOT', 'MCKMENSAGEM', 'COMBO'];
const MIN_CENTS = 100;
export const PROMO_CYCLE: Cycle = 'MENSAL';

export interface PromoPrimeiroMes {
  enabled: boolean;
  /** Código mostrado ao cliente (aplicado automaticamente), ex.: BLACKFRIDAY. */
  codigo: string;
  /** Nome curto, ex.: "Black Friday MCK". */
  nome: string;
  /** Fim da promoção (ISO 8601). null = sem promoção. */
  ate: string | null;
  /** Preço do 1º mês por plano, em centavos. Plano ausente = sem promoção nesse plano. */
  precos: Partial<Record<PlanProduct, number>>;
  /** Texto da faixa no topo do site. */
  faixa: string;
}

export const DEFAULT_PROMO: PromoPrimeiroMes = { enabled: false, codigo: '', nome: '', ate: null, precos: {}, faixa: '' };

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Lê o JSON salvo, completando com o padrão. Nunca lança. */
export function parsePromo(json: string | null | undefined): PromoPrimeiroMes {
  let raw: any = {};
  try { raw = json ? JSON.parse(json) : {}; } catch { raw = {}; }
  if (!raw || typeof raw !== 'object') raw = {};
  const precos: Partial<Record<PlanProduct, number>> = {};
  for (const p of PLANOS) {
    const v = raw.precos?.[p];
    if (Number.isInteger(v) && v >= MIN_CENTS) precos[p] = v;
  }
  const ate = typeof raw.ate === 'string' && !Number.isNaN(Date.parse(raw.ate)) ? new Date(raw.ate).toISOString() : null;
  return {
    enabled: raw.enabled === true,
    codigo: str(raw.codigo, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, ''),
    nome: str(raw.nome, 60),
    ate,
    precos,
    faixa: str(raw.faixa, 200),
  };
}

export type PromoInput = Partial<PromoPrimeiroMes>;

/** Erro legível (vai para o Master como 400) ou null. */
export function validatePromoInput(input: PromoInput): string | null {
  if (input.ate !== undefined && input.ate !== null && Number.isNaN(Date.parse(input.ate))) return 'Data de fim da promoção inválida.';
  if (input.precos) {
    for (const [k, v] of Object.entries(input.precos)) {
      if (!PLANOS.includes(k as PlanProduct)) return 'Plano inválido na promoção.';
      if (v !== undefined && v !== null && (!Number.isInteger(v) || v < MIN_CENTS)) return 'O preço do 1º mês precisa ser de pelo menos R$ 1,00.';
    }
  }
  if (input.enabled && !(input.ate ?? null)) return 'Informe até quando a promoção vale.';
  return null;
}

export const applyPromoInput = (cur: PromoPrimeiroMes, input: PromoInput): PromoPrimeiroMes => parsePromo(JSON.stringify({ ...cur, ...input, precos: input.precos ?? cur.precos }));

/** A promoção está valendo agora? */
export const promoAtiva = (p: PromoPrimeiroMes, now = new Date()) => p.enabled && !!p.ate && now.getTime() <= Date.parse(p.ate) && Object.keys(p.precos).length > 0;

/** Preço do 1º mês deste plano/ciclo (sem olhar a empresa), ou null. */
export function promoPreco(p: PromoPrimeiroMes, product: PlanProduct, cycle: Cycle, fullCents: number, now = new Date()): number | null {
  if (!promoAtiva(p, now) || cycle !== PROMO_CYCLE) return null;
  const v = p.precos[product];
  if (!v || v >= fullCents || fullCents < MIN_CENTS) return null;
  return v;
}

/** "R$ 22" / "R$ 22,90" (espaço normal, igual no site, no app e na IA). */
export const brl0 = (cents: number) => `R$ ${(cents / 100).toLocaleString('pt-BR', cents % 100 === 0 ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "30/11 às 23:59" no horário de Brasília. */
export function ateTexto(ate: string): string {
  const d = new Date(ate);
  const dia = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
  const hora = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  return `${dia} às ${hora}`;
}

/** Texto do plano: "Black Friday MCK: R$ 22 no 1º mês, depois R$ 47/mês (assinando até 30/11 às 23:59)". */
export function promoTextoPlano(p: PromoPrimeiroMes, priceCents: number, fullCents: number) {
  return `${p.nome || 'Promoção'}: ${brl0(priceCents)} no 1º mês, depois ${brl0(fullCents)}/mês (assinando até ${p.ate ? ateTexto(p.ate) : ''}, horário de Brasília)`;
}

/** Oferta no formato que o app e o site já entendem (mesmo formato da promoção de entrada da v1.27.0). */
export function promoOferta(p: PromoPrimeiroMes, product: PlanProduct, fullCents: number, now = new Date()) {
  const v = promoPreco(p, product, PROMO_CYCLE, fullCents, now);
  if (v === null) return null;
  return {
    plan: product, cycle: PROMO_CYCLE, priceCents: v, months: 1, regularPriceCents: fullCents, newCustomersOnly: true,
    text: promoTextoPlano(p, v, fullCents), label: p.nome || 'Promoção', code: p.codigo || null, until: p.ate,
  };
}

/** Faixa pública do site (null quando não está valendo). */
export function publicPromo(p: PromoPrimeiroMes, prices: Record<PlanProduct, Record<Cycle, number>>, now = new Date()) {
  if (!promoAtiva(p, now)) return null;
  const planos = PLANOS.map((id) => ({ id, de: prices[id].MENSAL, por: promoPreco(p, id, PROMO_CYCLE, prices[id].MENSAL, now) }))
    .filter((x): x is { id: PlanProduct; de: number; por: number } => x.por !== null);
  if (!planos.length) return null;
  return { codigo: p.codigo || null, nome: p.nome || 'Promoção', ate: p.ate, faixa: p.faixa || p.nome, planos };
}
