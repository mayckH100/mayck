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

/**
 * Ordem de compra (OC), ciclo completo (v1.36.0). Os valores antigos foram mantidos (dados existentes continuam
 * válidos) e ganharam rótulos novos; as etapas de recebimento são novas:
 *   RASCUNHO (OC em negociação) → EM_APROVACAO (aguardando aprovação do gestor) → APROVADO (OC aprovada)
 *   → ENVIADO (OC emitida · aguardando entrega) [RECEBIDO_PARCIAL = recebida em parte · aguardando o restante]
 *   → AGUARDANDO_NF (mercadoria chegou · aguardando entrada da NF)
 *   → AGUARDANDO_QUALIDADE (opcional: produto/pedido/empresa exige) → EM_CONFERENCIA → LIBERADA_ESTOQUE
 *   → RECEBIDO (em estoque · finalizado). CANCELADO só antes do recebimento, com motivo.
 * A NF-e lançada (Estoque › NF-e) dá entrada no estoque e leva a OC a RECEBIDO/RECEBIDO_PARCIAL de qualquer etapa de
 * recebimento, menos AGUARDANDO_QUALIDADE (precisa liberar antes).
 */
export type StatusCompra = 'RASCUNHO' | 'EM_APROVACAO' | 'APROVADO' | 'ENVIADO' | 'RECEBIDO_PARCIAL' | 'AGUARDANDO_NF' | 'AGUARDANDO_QUALIDADE' | 'EM_CONFERENCIA' | 'LIBERADA_ESTOQUE' | 'RECEBIDO' | 'CANCELADO';
export type EventoCompra =
  | 'ENVIAR' | 'APROVAR' | 'REPROVAR' | 'ENVIAR_FORNECEDOR' | 'REGISTRAR_ENTREGA' | 'NF_ENTRADA' | 'NF_ENTRADA_QUALIDADE'
  | 'LIBERAR_QUALIDADE' | 'REPROVAR_QUALIDADE' | 'CONCLUIR_CONFERENCIA' | 'FINALIZAR' | 'RECEBER_PARCIAL' | 'RECEBER' | 'CANCELAR';
export interface CtxCompra { itens: number; totalCents: number; gestor: boolean; alcadaCents: number; motivo?: string | null; /** aprovação automática do sistema ao enviar (dentro da alçada) */ auto?: boolean; /** há NF-e vinculada ainda não lançada */ nfPendente?: boolean }

/** Etapas em que a OC aceita NF-e / recebimento. */
export const STATUS_RECEBIMENTO: StatusCompra[] = ['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL', 'AGUARDANDO_NF', 'AGUARDANDO_QUALIDADE', 'EM_CONFERENCIA', 'LIBERADA_ESTOQUE'];
/** Etapas em que a mercadoria ainda não chegou (o prazo de entrega corre). */
export const STATUS_AGUARDANDO_ENTREGA: StatusCompra[] = ['RASCUNHO', 'EM_APROVACAO', 'APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL'];
/** OC aberta (não finalizada nem cancelada). */
export const STATUS_COMPRA_ABERTA: StatusCompra[] = ['RASCUNHO', 'EM_APROVACAO', 'APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL', 'AGUARDANDO_NF', 'AGUARDANDO_QUALIDADE', 'EM_CONFERENCIA', 'LIBERADA_ESTOQUE'];
const RECEBE: StatusCompra[] = ['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL', 'AGUARDANDO_NF', 'EM_CONFERENCIA', 'LIBERADA_ESTOQUE'];

export const ROTULO_STATUS_COMPRA: Record<StatusCompra, string> = {
  RASCUNHO: 'OC em negociação', EM_APROVACAO: 'Aguardando aprovação do gestor', APROVADO: 'OC aprovada', ENVIADO: 'OC emitida · aguardando entrega',
  RECEBIDO_PARCIAL: 'Recebida em parte · aguardando o restante', AGUARDANDO_NF: 'Aguardando entrada da NF', AGUARDANDO_QUALIDADE: 'Aguardando liberação da qualidade',
  EM_CONFERENCIA: 'Em conferência', LIBERADA_ESTOQUE: 'Liberada para estoque', RECEBIDO: 'Em estoque (finalizada)', CANCELADO: 'Cancelada',
};
export const ROTULO_EVENTO_COMPRA: Record<EventoCompra, string> = {
  ENVIAR: 'Enviar para aprovação', APROVAR: 'Aprovar', REPROVAR: 'Reprovar', ENVIAR_FORNECEDOR: 'Emitir OC', REGISTRAR_ENTREGA: 'Mercadoria chegou',
  NF_ENTRADA: 'NF registrada', NF_ENTRADA_QUALIDADE: 'NF registrada', LIBERAR_QUALIDADE: 'Liberar qualidade', REPROVAR_QUALIDADE: 'Reprovar na qualidade',
  CONCLUIR_CONFERENCIA: 'Concluir conferência', FINALIZAR: 'Finalizar (entrada no estoque feita)', RECEBER_PARCIAL: 'Recebimento parcial', RECEBER: 'Recebimento total', CANCELAR: 'Cancelar',
};
/** Etapas na ordem do fluxo (para as colunas/filtros da tela). */
export const ETAPAS_COMPRA: StatusCompra[] = ['RASCUNHO', 'EM_APROVACAO', 'APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL', 'AGUARDANDO_NF', 'AGUARDANDO_QUALIDADE', 'EM_CONFERENCIA', 'LIBERADA_ESTOQUE', 'RECEBIDO', 'CANCELADO'];

const soGestor = (c: CtxCompra, acao: string) => (c.gestor ? null : `Só o gestor (proprietário ou administrador) pode ${acao}`);

export const maquinaCompra: Maquina<StatusCompra, EventoCompra, CtxCompra> = {
  nome: 'Pedido de compra', inicial: 'RASCUNHO', finais: ['RECEBIDO', 'CANCELADO'],
  transicoes: [
    { de: 'RASCUNHO', evento: 'ENVIAR', para: 'EM_APROVACAO', guarda: (c) => (c.itens > 0 && c.totalCents > 0 ? null : 'Pedido sem itens ou com total zero') },
    // Aprovação manual: só gestor. Automática (sistema, ao enviar): só dentro da alçada.
    { de: 'EM_APROVACAO', evento: 'APROVAR', para: 'APROVADO', guarda: (c) => (c.gestor || (c.auto && c.totalCents <= c.alcadaCents) ? null : 'Acima da alçada: só proprietário ou administrador aprova'), emite: ['compras.pedido.aprovado'] },
    { de: 'EM_APROVACAO', evento: 'REPROVAR', para: 'RASCUNHO', guarda: (c) => soGestor(c, 'reprovar') ?? (c.motivo ? null : 'Informe o motivo da reprovação') },
    { de: 'APROVADO', evento: 'ENVIAR_FORNECEDOR', para: 'ENVIADO', emite: ['compras.pedido.enviado'] },
    { de: ['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL'], evento: 'REGISTRAR_ENTREGA', para: 'AGUARDANDO_NF' },
    { de: ['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL', 'AGUARDANDO_NF'], evento: 'NF_ENTRADA', para: 'EM_CONFERENCIA' },
    { de: ['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL', 'AGUARDANDO_NF'], evento: 'NF_ENTRADA_QUALIDADE', para: 'AGUARDANDO_QUALIDADE' },
    { de: 'AGUARDANDO_QUALIDADE', evento: 'LIBERAR_QUALIDADE', para: 'EM_CONFERENCIA' },
    { de: 'AGUARDANDO_QUALIDADE', evento: 'REPROVAR_QUALIDADE', para: 'ENVIADO', guarda: (c) => (c.motivo ? null : 'Informe o motivo da reprovação (ex.: devolvido ao fornecedor)') },
    { de: 'EM_CONFERENCIA', evento: 'CONCLUIR_CONFERENCIA', para: 'LIBERADA_ESTOQUE' },
    { de: 'LIBERADA_ESTOQUE', evento: 'FINALIZAR', para: 'RECEBIDO', guarda: (c) => (c.nfPendente ? 'Há NF-e vinculada ainda não lançada: lance a nota em Estoque › NF-e (ela dá a entrada e finaliza)' : null), emite: ['compras.pedido.recebido'] },
    { de: RECEBE, evento: 'RECEBER_PARCIAL', para: 'RECEBIDO_PARCIAL' },
    { de: RECEBE, evento: 'RECEBER', para: 'RECEBIDO', emite: ['compras.pedido.recebido'] },
    { de: ['RASCUNHO', 'EM_APROVACAO', 'APROVADO', 'ENVIADO'], evento: 'CANCELAR', para: 'CANCELADO', guarda: (c) => (c.motivo ? null : 'Informe o motivo do cancelamento'), emite: ['compras.pedido.cancelado'] },
  ],
};

/** Eventos que a tela mostra como botão (os de recebimento vêm da NF-e; NF_ENTRADA_QUALIDADE é escolhido pelo servidor). */
export const EVENTOS_TELA: EventoCompra[] = ['ENVIAR', 'APROVAR', 'REPROVAR', 'ENVIAR_FORNECEDOR', 'REGISTRAR_ENTREGA', 'NF_ENTRADA', 'LIBERAR_QUALIDADE', 'REPROVAR_QUALIDADE', 'CONCLUIR_CONFERENCIA', 'FINALIZAR', 'CANCELAR'];

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
