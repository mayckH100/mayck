/**
 * Relatório do dia para o proprietário: vendas, recebimentos e pagamentos por forma, saídas de estoque com CMV
 * e as alterações sensíveis (custo, estornos, cancelamentos). Baixável em CSV e enviado sozinho no fim do dia.
 */
import { prisma } from '../../db.js';
import { planoCompletoAtivo } from '../../billing/service.js';
import { agoraLocal } from '../alertas/alertas.js';

const SENSIVEIS = ['produto.custo', 'produto.custo_xml', 'produto.custos_adicionais', 'baixa.estornar', 'pedido.cancelar', 'pedido.devolver', 'estoque.ajuste_saida', 'titulo.cancelar', 'nfe_saida.cancelar'].map((a) => `erp.${a}`);
const NOME_ACAO: Record<string, string> = { 'erp.produto.custo': 'Custo alterado', 'erp.produto.custo_xml': 'Custo da nota alterado (com senha)', 'erp.produto.custos_adicionais': 'Custos extras alterados', 'erp.baixa.estornar': 'Estorno de baixa', 'erp.pedido.cancelar': 'Pedido cancelado', 'erp.pedido.devolver': 'Pedido devolvido', 'erp.estoque.ajuste_saida': 'Ajuste de estoque (saída)', 'erp.titulo.cancelar': 'Título cancelado', 'erp.nfe_saida.cancelar': 'NF-e cancelada' };
const r = (c: number) => `R$ ${(c / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d),)/g, '.')}`;

/** Início e fim do dia local (fuso da empresa) em UTC. */
export function janelaDoDia(dia: string, tz: string) {
  const base = new Date(`${dia}T12:00:00Z`);
  const local = new Date(base.toLocaleString('en-US', { timeZone: tz }));
  const offsetMs = local.getTime() - base.getTime();
  const ini = new Date(new Date(`${dia}T00:00:00Z`).getTime() - offsetMs);
  return { ini, fim: new Date(ini.getTime() + 86_400_000) };
}

export async function montarRelatorio(orgId: string, dia: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true, name: true } });
  const tz = org?.timezone || 'America/Sao_Paulo';
  const { ini, fim } = janelaDoDia(dia, tz);
  const periodo = { gte: ini, lt: fim };
  const [pedidos, baixas, saidas, logs] = await Promise.all([
    prisma.erpPedidoVenda.findMany({ where: { orgId, createdAt: periodo, statusOperacional: { not: 'CANCELADO' } }, select: { numero: true, totalCents: true, observacoes: true, statusOperacional: true } }),
    prisma.erpBaixa.findMany({ where: { data: periodo, estornada: false, titulo: { orgId } }, select: { valorCents: true, forma: true, titulo: { select: { tipo: true } } } }),
    prisma.erpMovimento.findMany({ where: { orgId, createdAt: periodo, tipo: { in: ['SAIDA', 'CONSUMO'] } }, select: { qtdMil: true, custoUnitCents: true } }),
    prisma.auditLog.findMany({ where: { orgId, createdAt: periodo, action: { in: SENSIVEIS } }, orderBy: { createdAt: 'asc' }, take: 200 }),
  ]);
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.userId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const balcao = pedidos.filter((p) => p.observacoes?.includes('Venda balcão'));
  const porForma: Record<string, { receber: number; pagar: number }> = {};
  for (const b of baixas) { const f = (porForma[b.forma] ??= { receber: 0, pagar: 0 }); if (b.titulo.tipo === 'RECEBER') f.receber += b.valorCents; else f.pagar += b.valorCents; }
  const cmv = saidas.reduce((a, m) => a + Math.round((Math.abs(m.qtdMil) * m.custoUnitCents) / 1000), 0);
  const alteracoes = logs.map((l) => {
    let meta: any = {}; try { meta = JSON.parse(l.meta); } catch { /* */ }
    const antes = meta.before ?? meta.antes ?? null; const depois = meta.after ?? meta.depois ?? null;
    return { hora: l.createdAt.toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }), acao: NOME_ACAO[l.action] ?? l.action, quem: (l.userId && users.get(l.userId)) || '', entidade: l.entity ?? '', antes: antes ? JSON.stringify(antes) : '', depois: depois ? JSON.stringify(depois) : '' };
  });
  return {
    dia, empresa: org?.name ?? '',
    vendas: { pedidos: pedidos.length, totalCents: pedidos.reduce((a, p) => a + p.totalCents, 0), balcao: balcao.length, balcaoCents: balcao.reduce((a, p) => a + p.totalCents, 0) },
    recebidoCents: baixas.filter((b) => b.titulo.tipo === 'RECEBER').reduce((a, b) => a + b.valorCents, 0),
    pagoCents: baixas.filter((b) => b.titulo.tipo === 'PAGAR').reduce((a, b) => a + b.valorCents, 0),
    porForma, cmvCents: cmv, alteracoes,
  };
}
export type Relatorio = Awaited<ReturnType<typeof montarRelatorio>>;

export function relatorioTexto(x: Relatorio) {
  const [a, m, d] = x.dia.split('-');
  return [
    `Relatório do dia ${d}/${m}/${a}${x.empresa ? ` · ${x.empresa}` : ''}`,
    `Vendas: ${x.vendas.pedidos} pedido(s), ${r(x.vendas.totalCents)}${x.vendas.balcao ? ` (balcão: ${x.vendas.balcao}, ${r(x.vendas.balcaoCents)})` : ''}`,
    `Recebido: ${r(x.recebidoCents)} · Pago: ${r(x.pagoCents)}`,
    ...Object.entries(x.porForma).map(([f, v]) => `  ${f}: recebido ${r(v.receber)}${v.pagar ? `, pago ${r(v.pagar)}` : ''}`),
    `CMV (custo do que saiu): ${r(x.cmvCents)}`,
    x.alteracoes.length ? `Alterações sensíveis: ${x.alteracoes.length}` : 'Nenhuma alteração sensível.',
    ...x.alteracoes.slice(0, 15).map((l) => `  ${l.hora} ${l.quem}: ${l.acao}${l.depois ? ` → ${l.depois}` : ''}`.slice(0, 200)),
  ].join('\n');
}

export function relatorioCsv(x: Relatorio) {
  const c = (v: string | number) => { const s = String(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const L: (string | number)[][] = [['Relatório do dia', x.dia], ['Empresa', x.empresa], [],
    ['Pedidos', x.vendas.pedidos], ['Total vendido', r(x.vendas.totalCents)], ['Vendas balcão', x.vendas.balcao], ['Total balcão', r(x.vendas.balcaoCents)],
    ['Recebido', r(x.recebidoCents)], ['Pago', r(x.pagoCents)], ['CMV', r(x.cmvCents)], [], ['Forma', 'Recebido', 'Pago'],
    ...Object.entries(x.porForma).map(([f, v]) => [f, r(v.receber), r(v.pagar)]), [], ['Hora', 'Quem', 'Alteração', 'Registro', 'Antes', 'Depois'],
    ...x.alteracoes.map((l) => [l.hora, l.quem, l.acao, l.entidade, l.antes, l.depois])];
  return '\uFEFF' + L.map((l) => l.map(c).join(';')).join('\r\n') + '\r\n';
}

/** Tick do agendador: a partir das 22h (fuso da empresa), manda o relatório do dia ao proprietário uma vez. */
export async function tickRelatorioDiario(now = new Date(), horaEnvio = 22) {
  const { notificarProprietario } = await import('../alertas/alertas.js');
  const cfgs = await prisma.erpConfig.findMany({ select: { orgId: true, relatorioUltimoDia: true } });
  for (const c of cfgs) {
    const org = await prisma.organization.findUnique({ where: { id: c.orgId }, select: { timezone: true } });
    const { dia, hora } = agoraLocal(org?.timezone || 'America/Sao_Paulo', now);
    if (hora < horaEnvio || c.relatorioUltimoDia === dia) continue;
    if (!(await planoCompletoAtivo(c.orgId, now))) continue; // ERP só no Plano Completo
    const claim = await prisma.erpConfig.updateMany({ where: { orgId: c.orgId, OR: [{ relatorioUltimoDia: null }, { relatorioUltimoDia: { not: dia } }] }, data: { relatorioUltimoDia: dia } });
    if (!claim.count) continue;
    try {
      const x = await montarRelatorio(c.orgId, dia);
      if (!x.vendas.pedidos && !x.recebidoCents && !x.pagoCents && !x.alteracoes.length) continue; // dia sem movimento: não incomoda
      await notificarProprietario(c.orgId, `Relatório do dia ${dia.split('-').reverse().join('/')}`, relatorioTexto(x), [{ filename: `relatorio-${dia}.csv`, content: Buffer.from(relatorioCsv(x), 'utf8'), contentType: 'text/csv' }]);
    } catch (e) { console.error('[erp-relatorio]', c.orgId, (e as Error).message); }
  }
}
