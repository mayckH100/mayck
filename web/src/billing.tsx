import type { SubStatus, SubscriptionView } from './auth';

export type PlanProduct = 'MCKBOT' | 'MCKMENSAGEM' | 'COMBO';
export type Cycle = 'MENSAL' | 'ANUAL';
export const PLAN_PRODUCTS: PlanProduct[] = ['MCKBOT', 'MCKMENSAGEM', 'COMBO'];
export const PRODUCTS = ['MCKBOT', 'MCKMENSAGEM'] as const;
export const CYCLES: Cycle[] = ['MENSAL', 'ANUAL'];
export const STATUSES: SubStatus[] = ['ATIVA', 'TRIAL', 'VENCIDA', 'BLOQUEADA'];

export const PRODUCT_LABEL: Record<PlanProduct, string> = { MCKBOT: 'MCKBOT', MCKMENSAGEM: 'MCKMENSAGEM', COMBO: 'Combo MCKBOT + MCKMENSAGEM' };
export const CYCLE_LABEL: Record<string, string> = { MENSAL: 'Mensal', ANUAL: 'Anual' };
export const STATUS_LABEL: Record<SubStatus, string> = { ATIVA: 'Ativa', TRIAL: 'Em teste', VENCIDA: 'Vencida', BLOQUEADA: 'Bloqueada' };
export const STATUS_CLS: Record<SubStatus, string> = { ATIVA: 'green', TRIAL: 'blue', VENCIDA: 'amber', BLOQUEADA: 'red' };
export const KIND_LABEL: Record<string, string> = { MP: 'Pagamento Mercado Pago', MANUAL: 'Ajuste manual', TRIAL: 'Início do teste', BLOCK: 'Bloqueio', UNBLOCK: 'Desbloqueio' };
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
