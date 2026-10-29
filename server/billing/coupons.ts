import { prisma } from '../db.js';
import { CYCLES, PLAN_PRODUCTS, getSettings, type Cycle, type PlanProduct, type Prices } from './service.js';

/**
 * Cupons de desconto (parcerias com influenciadores e empresas).
 *
 * Regras:
 *  - código sempre MAIÚSCULO (A-Z, 0-9, "-" e "_", 3 a 30 caracteres) e único;
 *  - tipo PERCENT (1 a 99%) ou FIXED (centavos);
 *  - produto: ALL ou um plano exato (MCKBOT, MCKMENSAGEM, COMBO); ciclos: ALL, MENSAL ou ANUAL;
 *  - o valor final nunca fica abaixo de MIN_FINAL_CENTS (o Mercado Pago não cobra R$ 0);
 *  - o preço com desconto é SEMPRE calculado no servidor; o uso só conta com pagamento confirmado.
 */
export const COUPON_TYPES = ['PERCENT', 'FIXED'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];
export const COUPON_PRODUCTS = ['ALL', ...PLAN_PRODUCTS] as const;
export type CouponProduct = (typeof COUPON_PRODUCTS)[number];
export const COUPON_CYCLES = ['ALL', ...CYCLES] as const;
export type CouponCycles = (typeof COUPON_CYCLES)[number];
export const MIN_FINAL_CENTS = 100;
export const CODE_RE = /^[A-Z0-9_-]{3,30}$/;

export interface CouponRule { type: string; value: number; product: string; cycles: string }
export interface CouponState extends CouponRule { active: boolean; validUntil: Date | null; maxUses: number | null }
export interface Quote { originalCents: number; discountCents: number; finalCents: number }

export const normalizeCode = (code: unknown) => String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');

/** O cupom vale para este plano/ciclo? (não olha validade nem limite) */
export function couponMatches(c: Pick<CouponRule, 'product' | 'cycles'>, product: PlanProduct, cycle: Cycle) {
  return (c.product === 'ALL' || c.product === product) && (c.cycles === 'ALL' || c.cycles === cycle);
}

/** Desconto em centavos para um preço (sem limitar pelo mínimo). */
export function rawDiscount(c: Pick<CouponRule, 'type' | 'value'>, priceCents: number) {
  if (c.type === 'PERCENT') return Math.round((priceCents * c.value) / 100);
  if (c.type === 'FIXED') return c.value;
  return 0;
}

/** Preço original, desconto e final. null se o desconto deixaria o plano abaixo do mínimo cobrável. */
export function quote(c: Pick<CouponRule, 'type' | 'value'>, priceCents: number): Quote | null {
  const d = rawDiscount(c, priceCents);
  if (d <= 0 || priceCents - d < MIN_FINAL_CENTS) return null;
  return { originalCents: priceCents, discountCents: d, finalCents: priceCents - d };
}

export type CouponProblem = 'inexistente' | 'inativo' | 'expirado' | 'esgotado' | 'produto' | 'valor';
export const PROBLEM_TEXT: Record<CouponProblem, string> = {
  inexistente: 'Cupom não encontrado. Confira o código.',
  inativo: 'Este cupom não está ativo.',
  expirado: 'Este cupom expirou.',
  esgotado: 'Este cupom atingiu o limite de usos.',
  produto: 'Este cupom não vale para o plano escolhido.',
  valor: 'O desconto deste cupom é maior que o valor do plano escolhido.',
};

/** Validade geral do cupom (ativo, dentro da data, abaixo do limite). */
export function couponAvailability(c: CouponState, usesConfirmed: number, now = new Date()): CouponProblem | null {
  if (!c.active) return 'inativo';
  if (c.validUntil && c.validUntil.getTime() < now.getTime()) return 'expirado';
  if (c.maxUses !== null && c.maxUses !== undefined && usesConfirmed >= c.maxUses) return 'esgotado';
  return null;
}

/** Cotação para todos os planos/ciclos aos quais o cupom se aplica. */
export function quotesFor(c: CouponRule, prices: Prices) {
  const out: Partial<Record<PlanProduct, Partial<Record<Cycle, Quote>>>> = {};
  for (const p of PLAN_PRODUCTS) for (const cy of CYCLES) {
    if (!couponMatches(c, p, cy)) continue;
    const q = quote(c, prices[p][cy]);
    if (q) (out[p] ??= {})[cy] = q;
  }
  return out;
}

export const confirmedUses = (couponId: string) => prisma.couponRedemption.count({ where: { couponId, status: 'CONFIRMADO' } });

export class CouponError extends Error { constructor(public problem: CouponProblem) { super(PROBLEM_TEXT[problem]); } }

/** Busca e valida o cupom (sem plano específico). Lança CouponError. */
export async function loadValidCoupon(code: unknown) {
  const norm = normalizeCode(code);
  if (!CODE_RE.test(norm)) throw new CouponError('inexistente');
  const c = await prisma.coupon.findUnique({ where: { code: norm } });
  if (!c) throw new CouponError('inexistente');
  const problem = couponAvailability(c, await confirmedUses(c.id));
  if (problem) throw new CouponError(problem);
  return c;
}

/** Valida o cupom para um plano/ciclo e devolve o preço final calculado no servidor. */
export async function priceWithCoupon(code: unknown, product: PlanProduct, cycle: Cycle) {
  const c = await loadValidCoupon(code);
  if (!couponMatches(c, product, cycle)) throw new CouponError('produto');
  const { prices } = await getSettings();
  const q = quote(c, prices[product][cycle]);
  if (!q) throw new CouponError('valor');
  return { coupon: c, quote: q };
}

/** Dados do cupom que podem ir para o cliente (sem parceiro, sem contagem de usos). */
export const publicCouponView = (c: { code: string; type: string; value: number; product: string; cycles: string; validUntil: Date | null }) => ({
  code: c.code, type: c.type, value: c.value, product: c.product, cycles: c.cycles, validUntil: c.validUntil ? c.validUntil.toISOString() : null,
});
