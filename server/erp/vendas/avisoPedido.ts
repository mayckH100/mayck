import { prisma } from '../../db.js';
import { appLink, brl, notifyStaffEventInBackground, orderAlertText, userName } from '../../whatsapp/staffAlerts.js';

const qtd = (mil: number) => (mil / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/**
 * Pedido/venda criado no MCK ERP → aviso "🛒 Novo pedido" para os Números de aviso (WhatsApp) do Perfil.
 * Em segundo plano, nunca lança. Não avisa quando o próprio Proprietário criou (ver staffAlerts.ts).
 */
export function avisarPedidoErp(p: { id: string; orgId: string; numero: number; parceiroId: string; vendedorId: string | null; totalCents: number }, opts: { balcao?: boolean } = {}) {
  notifyStaffEventInBackground({
    orgId: p.orgId, event: 'order', key: `erp:${p.id}`, createdByUserId: p.vendedorId, manual: true,
    emailUrl: appLink(`/erp/pedidos/${p.id}`),
    text: async () => {
      const [parceiro, itens] = await Promise.all([
        prisma.erpParceiro.findUnique({ where: { id: p.parceiroId }, select: { nome: true, fantasia: true, telefone: true } }).catch(() => null),
        prisma.erpPedidoItem.findMany({ where: { pedidoId: p.id }, orderBy: { posicao: 'asc' }, select: { descricao: true, qtdMil: true } }).catch(() => []),
      ]);
      const nome = parceiro ? parceiro.fantasia || parceiro.nome : null;
      return orderAlertText({
        title: opts.balcao ? `🛒 Nova venda balcão nº ${p.numero} (MCK ERP)` : `🛒 Novo pedido nº ${p.numero} (MCK ERP)`,
        who: nome ? (parceiro?.telefone ? `${nome} (${parceiro.telefone})` : nome) : null,
        items: itens.map((i) => `${qtd(i.qtdMil)}x ${i.descricao}`).join(', '),
        total: brl(p.totalCents),
        by: (await userName(p.vendedorId)) ?? 'equipe',
        url: appLink(`/erp/pedidos/${p.id}`),
      });
    },
  });
}
