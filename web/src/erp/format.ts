/** Utilidades de formatação do ERP. */
export const brl = (cents?: number | null) => ((cents ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const toCents = (s: string) => Math.round(Number(String(s).replace(/\./g, '').replace(',', '.')) * 100) || 0;
export const fromCents = (c?: number | null) => ((c ?? 0) / 100).toFixed(2).replace('.', ',');
export function fmtDoc(d?: string | null) {
  if (!d) return '—';
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d;
}

/** Quantidade em milésimos ↔ texto (até 3 casas). */
export const qtd = (mil?: number | null) => ((mil ?? 0) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
export const toMil = (s: string) => Math.round(Number(String(s).replace(/\./g, '').replace(',', '.')) * 1000) || 0;
export const STATUS_PEDIDO: Record<string, string> = {
  RASCUNHO: 'Orçamento', EM_APROVACAO: 'Em aprovação', BLOQUEADO: 'Aguardando aprovação', APROVADO: 'Aprovado', AGUARDANDO_SUPRIMENTO: 'Aguardando estoque',
  RESERVADO: 'Reservado', EM_SEPARACAO: 'Em separação', SEPARADO: 'Separado', FATURADO: 'Faturado', EM_TRANSPORTE: 'Em transporte',
  ENTREGUE: 'Entregue', ENTREGA_PARCIAL: 'Entrega parcial', DEVOLVIDO: 'Devolvido', CANCELADO: 'Cancelado',
};
