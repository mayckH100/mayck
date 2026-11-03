/**
 * Máquina de estados do pedido de venda (região operacional). A região financeira anda junto:
 * APROVADO → PROVISIONADO; FATURADO → EM_ABERTO (o resto chega com o módulo Financeiro, Etapa 4).
 */
import type { Maquina } from '../shared/statemachine.js';

export type StatusPedido = 'RASCUNHO' | 'EM_APROVACAO' | 'BLOQUEADO' | 'APROVADO' | 'AGUARDANDO_SUPRIMENTO' | 'RESERVADO' | 'EM_SEPARACAO' | 'SEPARADO' | 'FATURADO' | 'EM_TRANSPORTE' | 'ENTREGUE' | 'ENTREGA_PARCIAL' | 'DEVOLVIDO' | 'CANCELADO';
export type EventoPedido = 'ENVIAR' | 'BLOQUEAR' | 'APROVAR' | 'REPROVAR' | 'RESERVAR' | 'FALTAR' | 'SEPARAR' | 'CONFERIR' | 'FATURAR' | 'EXPEDIR' | 'ENTREGAR' | 'ENTREGAR_PARCIAL' | 'DEVOLVER' | 'CANCELAR' | 'REABRIR';

export interface CtxPedido { itens: number; totalCents: number; tudoSeparado?: boolean; nfNumero?: string | null; motivo?: string | null }

const ANTES_FATURAR: StatusPedido[] = ['RASCUNHO', 'EM_APROVACAO', 'BLOQUEADO', 'APROVADO', 'AGUARDANDO_SUPRIMENTO', 'RESERVADO', 'EM_SEPARACAO', 'SEPARADO'];

export const maquinaPedido: Maquina<StatusPedido, EventoPedido, CtxPedido> = {
  nome: 'Pedido',
  inicial: 'RASCUNHO',
  finais: ['ENTREGUE', 'DEVOLVIDO', 'CANCELADO'],
  transicoes: [
    { de: 'RASCUNHO', evento: 'ENVIAR', para: 'EM_APROVACAO', guarda: (c) => (c.itens > 0 && c.totalCents > 0 ? null : 'Pedido sem itens ou com total zero') },
    { de: 'EM_APROVACAO', evento: 'BLOQUEAR', para: 'BLOQUEADO', emite: ['vendas.pedido.bloqueado'] },
    { de: ['EM_APROVACAO', 'BLOQUEADO'], evento: 'APROVAR', para: 'APROVADO', emite: ['vendas.pedido.aprovado'] },
    { de: ['EM_APROVACAO', 'BLOQUEADO'], evento: 'REPROVAR', para: 'RASCUNHO', guarda: (c) => (c.motivo ? null : 'Informe o motivo da reprovação') },
    { de: ['APROVADO', 'AGUARDANDO_SUPRIMENTO'], evento: 'RESERVAR', para: 'RESERVADO', emite: ['estoque.reservado'] },
    { de: ['APROVADO', 'AGUARDANDO_SUPRIMENTO'], evento: 'FALTAR', para: 'AGUARDANDO_SUPRIMENTO', emite: ['estoque.necessidade'] },
    { de: 'RESERVADO', evento: 'SEPARAR', para: 'EM_SEPARACAO' },
    { de: 'EM_SEPARACAO', evento: 'CONFERIR', para: 'SEPARADO', guarda: (c) => (c.tudoSeparado ? null : 'Ainda há itens sem conferência') },
    { de: 'SEPARADO', evento: 'FATURAR', para: 'FATURADO', guarda: (c) => (c.nfNumero ? null : 'Informe o número da nota fiscal'), emite: ['vendas.pedido.faturado'] },
    { de: 'FATURADO', evento: 'EXPEDIR', para: 'EM_TRANSPORTE', emite: ['vendas.pedido.expedido'] },
    { de: 'EM_TRANSPORTE', evento: 'ENTREGAR', para: 'ENTREGUE', emite: ['vendas.pedido.entregue'] },
    { de: 'EM_TRANSPORTE', evento: 'ENTREGAR_PARCIAL', para: 'ENTREGA_PARCIAL', guarda: (c) => (c.motivo ? null : 'Descreva o que faltou'), emite: ['vendas.pedido.entrega_parcial'] },
    { de: ['EM_TRANSPORTE', 'ENTREGA_PARCIAL'], evento: 'DEVOLVER', para: 'DEVOLVIDO', guarda: (c) => (c.motivo ? null : 'Informe o motivo da devolução'), emite: ['vendas.pedido.devolvido'] },
    { de: 'ENTREGA_PARCIAL', evento: 'ENTREGAR', para: 'ENTREGUE', emite: ['vendas.pedido.entregue'] },
    { de: ANTES_FATURAR, evento: 'CANCELAR', para: 'CANCELADO', guarda: (c) => (c.motivo ? null : 'Informe o motivo do cancelamento'), emite: ['vendas.pedido.cancelado'] },
  ],
};

/** Status financeiro derivado da transição operacional. */
export function financeiroApos(para: StatusPedido, atual: string) {
  if (para === 'APROVADO' && atual === 'SEM_TITULO') return 'PROVISIONADO';
  if (para === 'FATURADO') return 'EM_ABERTO';
  if (para === 'CANCELADO' || para === 'RASCUNHO') return 'SEM_TITULO';
  return atual;
}

/** Concluído = entregue e liquidado (liquidação chega com o Financeiro). */
export const concluido = (p: { statusOperacional: string; statusFinanceiro: string }) => p.statusOperacional === 'ENTREGUE' && p.statusFinanceiro === 'LIQUIDADO';

/** Estados em que a reserva de estoque está presa ao pedido. */
export const COM_RESERVA: StatusPedido[] = ['RESERVADO', 'EM_SEPARACAO', 'SEPARADO', 'AGUARDANDO_SUPRIMENTO'];
