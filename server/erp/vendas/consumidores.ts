/** Reações a eventos de vendas: linha do tempo do cliente e oportunidade ganha quando o pedido é aprovado. */
import { consumir } from '../shared/events.js';

const ROTULO: Record<string, string> = {
  'vendas.pedido.criado': 'Orçamento criado',
  'vendas.pedido.bloqueado': 'Pedido aguardando aprovação',
  'vendas.pedido.aprovado': 'Pedido aprovado',
  'vendas.pedido.faturado': 'Pedido faturado',
  'vendas.pedido.expedido': 'Pedido expedido',
  'vendas.pedido.entregue': 'Pedido entregue',
  'vendas.pedido.entrega_parcial': 'Entrega parcial',
  'vendas.pedido.devolvido': 'Pedido devolvido',
  'vendas.pedido.cancelado': 'Pedido cancelado',
};
const brl = (c?: number) => (typeof c === 'number' ? ` (R$ ${(c / 100).toFixed(2).replace('.', ',')})` : '');

export function registrarConsumidoresVendas() {
  for (const tipo of Object.keys(ROTULO)) {
    consumir(tipo, 'vendas.timeline', async (ev, tx) => {
      const p = ev.payload as { parceiroId?: string; numero?: number; totalCents?: number; motivo?: string | null };
      if (!p.parceiroId) return;
      await tx.erpInteracao.create({ data: { orgId: ev.orgId, parceiroId: p.parceiroId, tipo: 'SISTEMA', assunto: `${ROTULO[tipo]} nº ${p.numero ?? ''}`, conteudo: `${brl(p.totalCents).trim()}${p.motivo ? ` — ${p.motivo}` : ''}` || undefined } });
    });
  }
  // Pedido aprovado fecha a oportunidade de origem como GANHA (se ainda aberta).
  consumir('vendas.pedido.aprovado', 'crm.ganhar-oportunidade', async (ev, tx) => {
    const ped = await tx.erpPedidoVenda.findUnique({ where: { id: ev.agregadoId }, select: { oportunidadeId: true, totalCents: true } });
    if (!ped?.oportunidadeId) return;
    await tx.erpOportunidade.updateMany({ where: { id: ped.oportunidadeId, orgId: ev.orgId, status: 'ABERTA' }, data: { status: 'GANHA', fechadaEm: new Date(), probabilidade: 100, valorCents: ped.totalCents } });
  });
}
