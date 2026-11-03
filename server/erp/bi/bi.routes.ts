/**
 * BI: visão única do negócio no período. Vendas (receita, CMV, margem, ticket, série, top clientes/produtos, curva ABC),
 * estoque (valor, abaixo do mínimo, validade, cobertura), compras, produção, financeiro e CRM. Exportação CSV.
 * Data de venda = data da baixa de estoque do faturamento (movimento SAIDA do pedido).
 */
import { Router } from 'express';
import { prisma } from '../../db.js';
import { ah, badRequest } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { curvaAbc, seriePorDia, pctBp, coberturaDias, csv } from './calculo.js';

export const biRouter = Router();
const DIA = 86_400_000;
const FORA = ['CANCELADO', 'DEVOLVIDO'];

function periodo(q: Record<string, unknown>) {
  const ate = typeof q.ate === 'string' ? new Date(`${q.ate}T23:59:59-03:00`) : new Date();
  const de = typeof q.de === 'string' ? new Date(`${q.de}T00:00:00-03:00`) : new Date(ate.getTime() - 29 * DIA);
  if (Number.isNaN(de.getTime()) || Number.isNaN(ate.getTime()) || de > ate) throw badRequest('Período inválido');
  if (ate.getTime() - de.getTime() > 400 * DIA) throw badRequest('Período máximo de 400 dias');
  return { de, ate, dias: Math.max(1, Math.round((ate.getTime() - de.getTime()) / DIA)) };
}

async function vendas(orgId: string, de: Date, ate: Date) {
  const movs = await prisma.erpMovimento.findMany({ where: { orgId, tipo: 'SAIDA', docTipo: 'pedido_venda', createdAt: { gte: de, lte: ate } }, select: { docId: true, qtdMil: true, custoUnitCents: true, createdAt: true, produtoId: true } });
  const ids = [...new Set(movs.map((m) => m.docId).filter(Boolean) as string[])];
  const peds = await prisma.erpPedidoVenda.findMany({ where: { orgId, id: { in: ids }, statusOperacional: { notIn: FORA } }, include: { itens: true } });
  const P = new Map(peds.map((p) => [p.id, p]));
  const dataPed = new Map<string, Date>();
  const cmvPorProduto = new Map<string, number>(); let cmv = 0;
  for (const m of movs) {
    if (!m.docId || !P.has(m.docId)) continue;
    const c = Math.round((Math.abs(m.qtdMil) * m.custoUnitCents) / 1000);
    cmv += c; cmvPorProduto.set(m.produtoId, (cmvPorProduto.get(m.produtoId) ?? 0) + c);
    if (!dataPed.has(m.docId) || m.createdAt < dataPed.get(m.docId)!) dataPed.set(m.docId, m.createdAt);
  }
  return { peds, cmv, cmvPorProduto, dataPed };
}

biRouter.get('/resumo', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { de, ate, dias } = periodo(req.query);
  const hoje = new Date();
  const { peds, cmv, cmvPorProduto, dataPed } = await vendas(orgId, de, ate);
  const receita = peds.reduce((s, p) => s + p.totalCents, 0);

  // Clientes e produtos
  const porCliente = new Map<string, number>(); const porProduto = new Map<string, { valorCents: number; qtdMil: number }>();
  for (const p of peds) {
    porCliente.set(p.parceiroId, (porCliente.get(p.parceiroId) ?? 0) + p.totalCents);
    for (const i of p.itens) { const x = porProduto.get(i.produtoId) ?? { valorCents: 0, qtdMil: 0 }; x.valorCents += i.totalCents; x.qtdMil += i.qtdMil; porProduto.set(i.produtoId, x); }
  }
  const [parceiros, produtos] = await Promise.all([
    prisma.erpParceiro.findMany({ where: { orgId, id: { in: [...porCliente.keys()] } }, select: { id: true, nome: true, fantasia: true } }),
    prisma.erpProduto.findMany({ where: { orgId }, select: { id: true, sku: true, nome: true, custoMedioCents: true, estoqueMinimoMil: true, ativo: true } }),
  ]);
  const NP = new Map(parceiros.map((p) => [p.id, p.fantasia || p.nome]));
  const PR = new Map(produtos.map((p) => [p.id, p]));
  const abc = curvaAbc([...porProduto].map(([id, v]) => ({ id, sku: PR.get(id)?.sku ?? '', nome: PR.get(id)?.nome ?? '', valorCents: v.valorCents, qtdMil: v.qtdMil, margemCents: v.valorCents - (cmvPorProduto.get(id) ?? 0) })));

  // Estoque
  const saldos = await prisma.erpSaldo.groupBy({ by: ['produtoId'], where: { orgId }, _sum: { fisicoMil: true } });
  const fis = new Map(saldos.map((s) => [s.produtoId, s._sum.fisicoMil ?? 0]));
  const valorEstoque = [...fis].reduce((s, [id, q]) => s + Math.round((q * (PR.get(id)?.custoMedioCents ?? 0)) / 1000), 0);
  const abaixo = produtos.filter((p) => p.ativo && p.estoqueMinimoMil > 0 && (fis.get(p.id) ?? 0) < p.estoqueMinimoMil).map((p) => ({ id: p.id, sku: p.sku, nome: p.nome, saldoMil: fis.get(p.id) ?? 0, minimoMil: p.estoqueMinimoMil }));
  const lotesVencendo = await prisma.erpLote.findMany({ where: { orgId, validade: { gte: hoje, lte: new Date(hoje.getTime() + 30 * DIA) } }, select: { id: true, numero: true, produtoId: true, validade: true } });
  const saldoLote = lotesVencendo.length ? await prisma.erpSaldo.groupBy({ by: ['loteId'], where: { orgId, loteId: { in: lotesVencendo.map((l) => l.id) } }, _sum: { fisicoMil: true } }) : [];
  const SL = new Map(saldoLote.map((s) => [s.loteId, s._sum.fisicoMil ?? 0]));
  const vencendo = lotesVencendo.map((l) => ({ lote: l.numero, sku: PR.get(l.produtoId)?.sku ?? '', validade: l.validade, qtdMil: SL.get(l.id) ?? 0, valorCents: Math.round(((SL.get(l.id) ?? 0) * (PR.get(l.produtoId)?.custoMedioCents ?? 0)) / 1000) })).filter((l) => l.qtdMil > 0).sort((a, b) => a.validade!.getTime() - b.validade!.getTime());

  // Compras, produção, financeiro, CRM
  const [pcs, ops, opsAbertas, receberAberto, pagar7, oportunidades] = await Promise.all([
    prisma.erpPedidoCompra.findMany({ where: { orgId, createdAt: { gte: de, lte: ate }, status: { notIn: ['RASCUNHO', 'CANCELADO'] } }, select: { parceiroId: true, totalCents: true } }),
    prisma.erpOrdemProducao.findMany({ where: { orgId, status: 'ENCERRADA', encerradaEm: { gte: de, lte: ate } }, select: { qtdProduzidaMil: true, qtdRefugoMil: true, custoMaterialCents: true, custoOperacaoCents: true } }),
    prisma.erpOrdemProducao.count({ where: { orgId, status: { in: ['PLANEJADA', 'LIBERADA', 'EM_PRODUCAO'] } } }),
    prisma.erpTitulo.findMany({ where: { orgId, tipo: 'RECEBER', status: { in: ['EM_ABERTO', 'PARCIAL'] } }, select: { valorCents: true, pagoCents: true, vencimento: true } }),
    prisma.erpTitulo.findMany({ where: { orgId, tipo: 'PAGAR', status: { in: ['EM_ABERTO', 'PARCIAL'] }, vencimento: { lte: new Date(hoje.getTime() + 7 * DIA) } }, select: { valorCents: true, pagoCents: true } }),
    prisma.erpOportunidade.findMany({ where: { orgId, OR: [{ status: 'ABERTA' }, { fechadaEm: { gte: de, lte: ate } }] }, select: { status: true, valorCents: true } }),
  ]);
  const porForn = new Map<string, number>(); for (const c of pcs) porForn.set(c.parceiroId, (porForn.get(c.parceiroId) ?? 0) + c.totalCents);
  const forns = await prisma.erpParceiro.findMany({ where: { orgId, id: { in: [...porForn.keys()] } }, select: { id: true, nome: true, fantasia: true } });
  const NF = new Map(forns.map((p) => [p.id, p.fantasia || p.nome]));
  const totalAberto = receberAberto.reduce((s, t) => s + t.valorCents - t.pagoCents, 0);
  const vencido = receberAberto.filter((t) => t.vencimento < hoje).reduce((s, t) => s + t.valorCents - t.pagoCents, 0);
  const produzido = ops.reduce((s, o) => s + o.qtdProduzidaMil, 0); const refugo = ops.reduce((s, o) => s + o.qtdRefugoMil, 0);
  const ganhas = oportunidades.filter((o) => o.status === 'GANHA'); const perdidas = oportunidades.filter((o) => o.status === 'PERDIDA');

  res.json({
    periodo: { de, ate, dias },
    vendas: {
      receitaCents: receita, cmvCents: cmv, margemBrutaCents: receita - cmv, margemBrutaBp: pctBp(receita - cmv, receita), pedidos: peds.length, ticketMedioCents: peds.length ? Math.round(receita / peds.length) : 0,
      serie: seriePorDia(peds.map((p) => ({ data: dataPed.get(p.id)!, valorCents: p.totalCents })), de, ate),
      topClientes: [...porCliente].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, v]) => ({ id, nome: NP.get(id) ?? '—', valorCents: v, participacaoBp: pctBp(v, receita) })),
      curvaAbc: abc.slice(0, 50), contagemAbc: { A: abc.filter((x) => x.classe === 'A').length, B: abc.filter((x) => x.classe === 'B').length, C: abc.filter((x) => x.classe === 'C').length },
    },
    estoque: { valorCents: valorEstoque, coberturaDias: coberturaDias(valorEstoque, cmv, dias), abaixoMinimo: abaixo.slice(0, 30), qtdAbaixoMinimo: abaixo.length, vencendo30Dias: vencendo.slice(0, 30), valorVencendoCents: vencendo.reduce((s, l) => s + l.valorCents, 0) },
    compras: { totalCents: pcs.reduce((s, c) => s + c.totalCents, 0), pedidos: pcs.length, topFornecedores: [...porForn].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, v]) => ({ id, nome: NF.get(id) ?? '—', valorCents: v })) },
    producao: { opsEncerradas: ops.length, opsAbertas, produzidoMil: produzido, refugoBp: pctBp(refugo, produzido + refugo), custoCents: ops.reduce((s, o) => s + o.custoMaterialCents + o.custoOperacaoCents, 0) },
    financeiro: { receberAbertoCents: totalAberto, receberVencidoCents: vencido, inadimplenciaBp: pctBp(vencido, totalAberto), pagarProximos7DiasCents: pagar7.reduce((s, t) => s + t.valorCents - t.pagoCents, 0) },
    crm: { abertas: oportunidades.filter((o) => o.status === 'ABERTA').length, pipelineCents: oportunidades.filter((o) => o.status === 'ABERTA').reduce((s, o) => s + o.valorCents, 0), ganhas: ganhas.length, perdidas: perdidas.length, conversaoBp: pctBp(ganhas.length, ganhas.length + perdidas.length) },
  });
}));

biRouter.get('/exportar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { de, ate } = periodo(req.query);
  const tipo = String(req.query.tipo ?? 'pedidos');
  const { peds, dataPed } = await vendas(orgId, de, ate);
  const br = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  let corpo: string;
  if (tipo === 'produtos') {
    const m = new Map<string, { v: number; q: number }>();
    for (const p of peds) for (const i of p.itens) { const x = m.get(i.produtoId) ?? { v: 0, q: 0 }; x.v += i.totalCents; x.q += i.qtdMil; m.set(i.produtoId, x); }
    const pr = new Map((await prisma.erpProduto.findMany({ where: { orgId, id: { in: [...m.keys()] } }, select: { id: true, sku: true, nome: true } })).map((p) => [p.id, p]));
    corpo = csv(['SKU', 'Produto', 'Quantidade', 'Valor (R$)', 'Classe ABC'], curvaAbc([...m].map(([id, x]) => ({ id, valorCents: x.v, q: x.q }))).map((r) => [pr.get(r.id)?.sku ?? '', pr.get(r.id)?.nome ?? '', (r.q / 1000).toLocaleString('pt-BR'), br(r.valorCents), r.classe]));
  } else if (tipo === 'pedidos') {
    const np = new Map((await prisma.erpParceiro.findMany({ where: { orgId, id: { in: peds.map((p) => p.parceiroId) } }, select: { id: true, nome: true } })).map((p) => [p.id, p.nome]));
    corpo = csv(['Pedido', 'Data', 'Cliente', 'NF', 'Status', 'Total (R$)'], peds.map((p) => [p.numero, dataPed.get(p.id)?.toISOString().slice(0, 10) ?? '', np.get(p.parceiroId) ?? '', p.nfNumero, p.statusOperacional, br(p.totalCents)]));
  } else throw badRequest('Tipo de exportação inválido');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bi-${tipo}.csv"`);
  res.send(corpo);
}));
