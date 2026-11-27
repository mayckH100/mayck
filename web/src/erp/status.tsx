/**
 * v1.56.0 (Fase 1, item A4): cores de status iguais no MCK ERP inteiro, num lugar só.
 *   verde = ok · amarelo = atenção · vermelho = problema · cinza = neutro (sem julgamento)
 * As cores ficam no CSS (variáveis --st-*), usadas também pelos indicadores (Kpi) do Resumo.
 */
import type { ReactNode } from 'react';

export type StatusCor = 'ok' | 'atencao' | 'problema' | 'neutro';
export const ROTULO_STATUS: Record<StatusCor, string> = { ok: 'Em dia', atencao: 'Atenção', problema: 'Problema', neutro: '' };

/** Classe CSS do status (texto + fundo): "st st-ok", "st st-atencao"… */
export const classeStatus = (s: StatusCor) => `st st-${s}`;

/** Tom antigo dos indicadores do Resumo (ok/alerta/perigo/neutro) a partir do status padrão. */
export function tomDoStatus(s: StatusCor): 'ok' | 'alerta' | 'perigo' | 'neutro' {
  return s === 'atencao' ? 'alerta' : s === 'problema' ? 'perigo' : s;
}

/** Selo colorido: <StatusBadge status="problema">Vencido</StatusBadge>. */
export function StatusBadge({ status, children, title }: { status: StatusCor; children?: ReactNode; title?: string }) {
  return <span className={`badge ${classeStatus(status)}`} title={title}>{children ?? ROTULO_STATUS[status]}</span>;
}

// ---- Regras de cor (puras, testadas) ----

/** Inadimplência em %: até 2% ok, até 10% atenção, acima problema. Sem dado = neutro. */
export function statusInadimplencia(pct: number | null | undefined): StatusCor {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return 'neutro';
  return pct <= 2 ? 'ok' : pct <= 10 ? 'atencao' : 'problema';
}

/** Score do cliente (0–1000): 650+ ok, 400–649 atenção, abaixo problema. Cliente sem histórico = neutro. */
export function statusScore(score: number | null | undefined, faixa?: string | null): StatusCor {
  if (faixa === 'NOVO' || score === null || score === undefined) return 'neutro';
  return score >= 650 ? 'ok' : score >= 400 ? 'atencao' : 'problema';
}
export const ROTULO_FAIXA_SCORE: Record<string, string> = { BOM: 'Bom pagador', ATENCAO: 'Atenção', RISCO: 'Risco', NOVO: 'Sem histórico' };

/** Saldo em dinheiro: negativo é problema. */
export const statusSaldo = (cents: number | null | undefined): StatusCor => (cents == null ? 'neutro' : cents < 0 ? 'problema' : 'ok');

/** Conta a receber/pagar: paga = ok; vencida = problema; vence hoje ou nos próximos 3 dias = atenção; cancelada = neutro. */
export function statusTitulo(t: { status: string; vencimento: string | Date }, agora = new Date()): StatusCor {
  if (t.status === 'PAGO') return 'ok';
  if (t.status === 'CANCELADO') return 'neutro';
  const hoje = new Date(agora.toISOString().slice(0, 10)).getTime();
  const venc = new Date(new Date(t.vencimento).toISOString().slice(0, 10)).getTime();
  if (venc < hoje) return 'problema';
  return venc - hoje <= 3 * 86_400_000 ? 'atencao' : 'neutro';
}
