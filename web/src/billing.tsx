import type { SubStatus, SubscriptionView } from './auth';

export type PlanProduct = 'MCKBOT' | 'MCKMENSAGEM' | 'COMBO';
export type Cycle = 'MENSAL' | 'ANUAL';
export const PLAN_PRODUCTS: PlanProduct[] = ['MCKBOT', 'MCKMENSAGEM', 'COMBO'];
export const PRODUCTS = ['MCKBOT', 'MCKMENSAGEM'] as const;
export const CYCLES: Cycle[] = ['MENSAL', 'ANUAL'];
export const STATUSES: SubStatus[] = ['ATIVA', 'TRIAL', 'VENCIDA', 'BLOQUEADA'];

/** Nomes padrão (fallback). Os exibidos vêm do Master (v1.25.0): /billing/status → plans, /public/plans → label. */
export const PRODUCT_LABEL: Record<PlanProduct, string> = { MCKBOT: 'MCKBOT', MCKMENSAGEM: 'MCKMENSAGEM', COMBO: 'Plano Completo: MCK ERP + MCKBOT + MCK Mensagens' };
export type PlanModule = 'MCKBOT' | 'MCKMENSAGEM' | 'ERP';
export const PLAN_MODULES: PlanModule[] = ['MCKBOT', 'MCKMENSAGEM', 'ERP'];
export const MODULE_LABEL: Record<PlanModule, string> = { MCKBOT: 'MCKBOT', MCKMENSAGEM: 'MCK Mensagens', ERP: 'MCK ERP' };
/** Plano como o Master configurou (v1.25.0). apps = assinaturas que ele renova. */
/** v1.27.0: promoção de entrada do Plano Completo (vem do servidor; o preço cobrado é sempre calculado lá). */
export interface IntroOfferInfo { plan: PlanProduct; cycle: 'MENSAL'; priceCents: number; months: number; regularPriceCents: number; newCustomersOnly: boolean; text: string; eligible?: boolean; monthsUsed?: number; monthsLeft?: number }
export interface PlanInfo { id: PlanProduct; name: string; desc: string; features: string[]; modules: PlanModule[]; apps: ('MCKBOT' | 'MCKMENSAGEM')[]; visible: boolean; introOffer?: IntroOfferInfo }
/** Menor valor cobrável (igual ao servidor): ciclo com preço abaixo disso não está à venda. */
export const MIN_CHARGE_CENTS = 100;
export const CYCLE_LABEL: Record<string, string> = { MENSAL: 'Mensal', ANUAL: 'Anual' };
export const STATUS_LABEL: Record<SubStatus, string> = { ATIVA: 'Ativa', TRIAL: 'Em teste', VENCIDA: 'Vencida', BLOQUEADA: 'Bloqueada' };
export const STATUS_CLS: Record<SubStatus, string> = { ATIVA: 'green', TRIAL: 'blue', VENCIDA: 'amber', BLOQUEADA: 'red' };
export const KIND_LABEL: Record<string, string> = { MP: 'Pagamento Mercado Pago', MANUAL: 'Ajuste manual', TRIAL: 'Início do teste', BLOCK: 'Bloqueio', UNBLOCK: 'Desbloqueio', MP_ESTORNO: 'Estorno Mercado Pago', INDICACAO: 'Indique e ganhe: +30 dias', INDICACAO_ESTORNO: 'Indique e ganhe: crédito estornado' };
export const SOURCE_LABEL: Record<string, string> = { MP: 'Mercado Pago', MANUAL: 'Manual', TRIAL: 'Período de teste' };

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** Centavos → "R$ 39,90". */
export const fmtBRL = (cents?: number | null) => (cents === null || cents === undefined ? '—' : BRL.format(cents / 100));
/** "39,90" / "39.90" / "R$ 1.234,56" → 3990 (ou null se inválido). */
export function parseBRL(v: string): number | null {
  let s = v.replace(/[^\d,.-]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
export const centsToInput = (c?: number | null) => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));
/** Data curta pt-BR (dd/mm/aaaa) no fuso de Brasília. */
export const fmtDay = (d?: string | Date | null) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—');
/** "2026-10" → "out/26". */
export function fmtMonth(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 15)).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace('. de ', '/').replace(' de ', '/').replace('.', '');
}
export function daysLeft(validUntil: string) {
  return Math.ceil((new Date(validUntil).getTime() - Date.now()) / 86_400_000);
}
/** Data no formato do <input type="date"> (aaaa-mm-dd), no fuso de Brasília. */
export const toDateInput = (d: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));

export function SubBadge({ status }: { status: SubStatus }) {
  return <span className={`badge ${STATUS_CLS[status] ?? ''}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export const subOf = (subs: SubscriptionView[] | undefined, p: string) => subs?.find((s) => s.product === p);

// ---------- Cupom de desconto ----------
export interface CouponQuote { originalCents: number; discountCents: number; finalCents: number }
export interface AppliedCoupon {
  coupon: { code: string; type: 'PERCENT' | 'FIXED'; value: number; product: string; cycles: string; validUntil: string | null; firstPaymentOnly?: boolean };
  quotes: Partial<Record<PlanProduct, Partial<Record<Cycle, CouponQuote>>>>;
}
const COUPON_KEY = 'mck_cupom';
export const normalizeCoupon = (v: string | null | undefined) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
/** Guarda o ?cupom= do link do parceiro (sobrevive ao cadastro/login até a tela de assinatura). */
export function rememberCouponFromUrl(search = typeof window !== 'undefined' ? window.location.search : '') {
  try {
    const c = normalizeCoupon(new URLSearchParams(search).get('cupom'));
    if (/^[A-Z0-9_-]{3,30}$/.test(c)) localStorage.setItem(COUPON_KEY, c);
  } catch { /* sem localStorage */ }
}
export const storedCoupon = () => { try { return localStorage.getItem(COUPON_KEY) || ''; } catch { return ''; } };
export const clearStoredCoupon = () => { try { localStorage.removeItem(COUPON_KEY); } catch { /* ignore */ } };
export const couponLabel = (c: AppliedCoupon['coupon']) => (c.type === 'PERCENT' ? `${c.value}% de desconto` : `${fmtBRL(c.value)} de desconto`);

// ---------- Indique e ganhe ----------
const REFERRAL_KEY = 'mck_indica';
const REFERRAL_TTL_MS = 60 * 24 * 60 * 60 * 1000; // o link vale por 60 dias neste navegador
export const normalizeReferral = (v: string | null | undefined) => String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
/** Guarda o ?indica= do link de indicação (sobrevive até o cadastro, mesmo se a pessoa navegar antes). */
export function rememberReferralFromUrl(search = typeof window !== 'undefined' ? window.location.search : '') {
  try {
    const c = normalizeReferral(new URLSearchParams(search).get('indica'));
    if (/^[A-Z0-9]{6,12}$/.test(c)) localStorage.setItem(REFERRAL_KEY, JSON.stringify({ c, at: Date.now() }));
  } catch { /* sem localStorage */ }
}
export function storedReferral(): string {
  try {
    const v = JSON.parse(localStorage.getItem(REFERRAL_KEY) || 'null');
    if (v && typeof v.c === 'string' && Date.now() - Number(v.at) < REFERRAL_TTL_MS) return v.c;
  } catch { /* ignore */ }
  return '';
}
