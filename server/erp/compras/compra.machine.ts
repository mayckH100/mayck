/** Máquinas de estado de Compras: solicitação e pedido de compra (com alçada de aprovação). */
import type { Maquina } from '../shared/statemachine.js';

export type StatusSolicitacao = 'RASCUNHO' | 'EM_APROVACAO' | 'APROVADA' | 'REPROVADA' | 'ATENDIDA' | 'CANCELADA';
export type EventoSolicitacao = 'ENVIAR' | 'APROVAR' | 'REPROVAR' | 'ATENDER' | 'CANCELAR' | 'REABRIR';
export const maquinaSolicitacao: Maquina<StatusSolicitacao, EventoSolicitacao, { itens: number; motivo?: string | null; gestor: boolean }> = {
  nome: 'Solicitação de compra', inicial: 'RASCUNHO', finais: ['ATENDIDA', 'CANCELADA'],
  transicoes: [
    { de: 'RASCUNHO', evento: 'ENVIAR', para: 'EM_APROVACAO', guarda: (c) => (c.itens ? null : 'Solicitação sem itens') },
    { de: 'EM_APROVACAO', evento: 'APROVAR', para: 'APROVADA', guarda: (c) => (c.gestor ? null : 'Só proprietário ou administrador aprova'), emite: ['compras.solicitacao.aprovada'] },
    { de: 'EM_APROVACAO', evento: 'REPROVAR', para: 'REPROVADA', guarda: (c) => (!c.gestor ? 'Só proprietário ou administrador reprova' : c.motivo ? null : 'Informe o motivo') },
    { de: 'REPROVADA', evento: 'REABRIR', para: 'RASCUNHO' },
    { de: 'APROVADA', evento: 'ATENDER', para: 'ATENDIDA' },
    { de: ['RASCUNHO', 'EM_APROVACAO', 'APROVADA', 'REPROVADA'], evento: 'CANCELAR', para: 'CANCELADA', guarda: (c) => (c.motivo ? null : 'Informe o motivo') },
  ],
};

export type StatusCompra = 'RASCUNHO' | 'EM_APROVACAO' | 'APROVADO' | 'ENVIADO' | 'RECEBIDO_PARCIAL' | 'RECEBIDO' | 'CANCELADO';
export type EventoCompra = 'ENVIAR' | 'APROVAR' | 'REPROVAR' | 'ENVIAR_FORNECEDOR' | 'RECEBER_PARCIAL' | 'RECEBER' | 'CANCELAR';
export interface CtxCompra { itens: number; totalCents: number; gestor: boolean; alcadaCents: number; motivo?: string | null }

export const maquinaCompra: Maquina<StatusCompra, EventoCompra, CtxCompra> = {
  nome: 'Pedido de compra', inicial: 'RASCUNHO', finais: ['RECEBIDO', 'CANCELADO'],
  transicoes: [
    { de: 'RASCUNHO', evento: 'ENVIAR', para: 'EM_APROVACAO', guarda: (c) => (c.itens > 0 && c.totalCents > 0 ? null : 'Pedido sem itens ou com total zero') },
    { de: 'EM_APROVACAO', evento: 'APROVAR', para: 'APROVADO', guarda: (c) => (c.gestor || c.totalCents <= c.alcadaCents ? null : 'Acima da alçada: só proprietário ou administrador aprova'), emite: ['compras.pedido.aprovado'] },
    { de: 'EM_APROVACAO', evento: 'REPROVAR', para: 'RASCUNHO', guarda: (c) => (c.motivo ? null : 'Informe o motivo da reprovação') },
    { de: 'APROVADO', evento: 'ENVIAR_FORNECEDOR', para: 'ENVIADO', emite: ['compras.pedido.enviado'] },
    { de: ['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL'], evento: 'RECEBER_PARCIAL', para: 'RECEBIDO_PARCIAL' },
    { de: ['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL'], evento: 'RECEBER', para: 'RECEBIDO', emite: ['compras.pedido.recebido'] },
    { de: ['RASCUNHO', 'EM_APROVACAO', 'APROVADO', 'ENVIADO'], evento: 'CANCELAR', para: 'CANCELADO', guarda: (c) => (c.motivo ? null : 'Informe o motivo do cancelamento'), emite: ['compras.pedido.cancelado'] },
  ],
};

/** Mapa de cotação: melhor proposta por item (menor preço; empate → menor prazo). */
export function vencedoras<R extends { itemId: string; parceiroId: string; precoUnitCents: number; prazoEntregaDias: number }>(respostas: R[]) {
  const melhor = new Map<string, R>();
  for (const r of respostas) {
    if (r.precoUnitCents <= 0) continue;
    const m = melhor.get(r.itemId);
    if (!m || r.precoUnitCents < m.precoUnitCents || (r.precoUnitCents === m.precoUnitCents && r.prazoEntregaDias < m.prazoEntregaDias)) melhor.set(r.itemId, r);
  }
  return melhor;
}

/**
 * Confronto do recebimento (NF-e × pedido de compra): quantidade acima do pendente e preço fora da tolerância.
 * Preços por unidade interna, em centavos.
 */
export function divergenciasRecebimento(
  linhas: { produtoId: string; sku: string; qtdMil: number; custoUnitCents: number }[],
  pedido: { produtoId: string; qtdMil: number; recebidoMil: number; precoUnitCents: number }[],
  toleranciaBp: number,
) {
  const div: string[] = [];
  const pend = new Map<string, { qtd: number; preco: number }>();
  for (const i of pedido) { const p = pend.get(i.produtoId); pend.set(i.produtoId, { qtd: (p?.qtd ?? 0) + Math.max(0, i.qtdMil - i.recebidoMil), preco: i.precoUnitCents }); }
  const recebido = new Map<string, number>();
  for (const l of linhas) recebido.set(l.produtoId, (recebido.get(l.produtoId) ?? 0) + l.qtdMil);
  for (const l of linhas) {
    const p = pend.get(l.produtoId);
    if (!p) { div.push(`${l.sku}: não está no pedido de compra`); continue; }
    if (p.preco > 0 && Math.abs(l.custoUnitCents - p.preco) * 10_000 > p.preco * toleranciaBp) div.push(`${l.sku}: preço ${(l.custoUnitCents / 100).toFixed(2)} × pedido ${(p.preco / 100).toFixed(2)}`);
  }
  for (const [produtoId, q] of recebido) {
    const p = pend.get(produtoId); const sku = linhas.find((l) => l.produtoId === produtoId)!.sku;
    if (p && q > p.qtd) div.push(`${sku}: recebendo ${q / 1000} e o pendente é ${p.qtd / 1000}`);
  }
  return [...new Set(div)];
}
