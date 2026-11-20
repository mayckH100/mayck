/**
 * Alerta diário do MCK ERP (v1.30.0) — junta os números do banco para o texto (formato.ts):
 * contas a pagar, estoque baixo com sugestão de compra (consumo médio, último fornecedor e custo), produtos parados,
 * lotes vencidos/vencendo, caixa do dia anterior e alterações manuais do dia anterior (AuditLog).
 */
import { prisma } from '../../db.js';
import { janelaDoDia } from '../relatorios/relatorio.js';
import { resumoDaSessao, resumoFechado } from '../vendas/caixa.routes.js';
import type { OpcoesAlerta } from './opcoes.js';
import {
  sugestaoCompra, brl, qtd,
  type Alteracao, type ContaPagar, type DadosAlerta, type ItemEstoqueBaixo, type ItemParado, type LoteValidade, type SessaoCaixa,
} from './formato.js';

const DIA = 86_400_000;
export const NOME_NATUREZA: Record<string, string> = { AGUA: 'Água', LUZ: 'Luz', INTERNET: 'Internet', TELEFONE: 'Telefone', ALUGUEL: 'Aluguel', IMPOSTO: 'Imposto', OUTRA_CONTA: 'Conta' };

export interface ConfigAlerta { alertaDiasAntes: number; alertaPagar: boolean; alertaEstoqueMinimo: boolean; alertaSemSaidaDias: number }

/** Ações do AuditLog que entram em "Alterações de ontem". */
export const ACOES_ALTERACAO: Record<string, { nome: string; tipo: Alteracao['tipo'] }> = {
  'erp.produto.preco': { nome: 'Preço de venda alterado', tipo: 'preco' },
  'erp.produto.custo': { nome: 'Custo alterado', tipo: 'custo' },
  'erp.produto.custo_xml': { nome: 'Custo da nota fiscal alterado (com senha)', tipo: 'custo' },
  'erp.produto.custos_adicionais': { nome: 'Custos extras alterados', tipo: 'custo' },
  'erp.estoque.ajuste_saida': { nome: 'Ajuste manual de estoque (saída)', tipo: 'estoque' },
  'erp.estoque.entrada': { nome: 'Entrada manual de estoque', tipo: 'estoque' },
  'erp.inventario.aprovar': { nome: 'Inventário aprovado (ajustou o estoque)', tipo: 'estoque' },
  'erp.baixa.estornar': { nome: 'Estorno de recebimento/pagamento', tipo: 'outro' },
  'erp.pedido.cancelar': { nome: 'Pedido de venda cancelado', tipo: 'outro' },
  'erp.titulo.cancelar': { nome: 'Conta cancelada', tipo: 'outro' },
};

const hhmm = (d: Date, tz: string) => d.toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
const ddmmHora = (d: Date, tz: string) => `${d.toLocaleDateString('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' })} ${hhmm(d, tz)}`;
export const diaAnterior = (iso: string) => new Date(new Date(`${iso}T12:00:00Z`).getTime() - DIA).toISOString().slice(0, 10);

async function nomesUsuarios(ids: (string | null | undefined)[]) {
  const u = [...new Set(ids.filter((x): x is string => !!x))];
  if (!u.length) return new Map<string, string>();
  return new Map((await prisma.user.findMany({ where: { id: { in: u } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
}

async function contasPagar(orgId: string, diasAntes: number, hoje: Date): Promise<ContaPagar[]> {
  const ate = new Date(hoje.getTime() + (diasAntes + 1) * DIA - 1);
  const ts = await prisma.erpTitulo.findMany({ where: { orgId, tipo: 'PAGAR', status: { in: ['EM_ABERTO', 'PARCIAL'] }, vencimento: { lte: ate } }, orderBy: { vencimento: 'asc' }, take: 200 });
  if (!ts.length) return [];
  const [ps, tipos] = await Promise.all([
    prisma.erpParceiro.findMany({ where: { orgId, id: { in: ts.map((t) => t.parceiroId).filter(Boolean) as string[] } }, select: { id: true, nome: true, fantasia: true } }),
    prisma.erpTipoConta.findMany({ where: { orgId, id: { in: ts.map((t) => t.tipoContaId).filter(Boolean) as string[] } }, select: { id: true, nome: true } }),
  ]);
  const P = new Map(ps.map((p) => [p.id, p.fantasia || p.nome]));
  const T = new Map<string, string>(tipos.map((t) => [t.id, t.nome]));
  return ts.map((t) => {
    const empresa = !!t.natureza && t.natureza !== 'FORNECEDOR';
    const quem = empresa ? (t.tipoContaId && T.get(t.tipoContaId)) || NOME_NATUREZA[t.natureza!] || 'Conta' : (t.parceiroId ? P.get(t.parceiroId) : null) ?? 'Fornecedor';
    return { quem, descricao: t.descricao, abertoCents: t.valorCents - t.pagoCents, vencimento: t.vencimento, empresa };
  });
}

type ProdutoBase = { id: string; sku: string; nome: string; unidade: string; estoqueMinimoMil: number; custoMedioCents: number; createdAt: Date; fornecedorPadraoId: string | null; leadTimeDias: number; loteMinimoMil: number };

/** Fornecedor e custo de referência por produto: cadastro do produto → último pedido de compra → última entrada (lote). */
export async function fornecedorECusto(orgId: string, produtos: ProdutoBase[]) {
  const ids = produtos.map((p) => p.id);
  const [itensPc, entradas] = await Promise.all([
    prisma.erpPedidoCompraItem.findMany({ where: { produtoId: { in: ids }, pedido: { orgId, status: { not: 'CANCELADO' } } }, orderBy: { pedido: { createdAt: 'desc' } }, take: 1000, select: { produtoId: true, precoUnitCents: true, pedido: { select: { parceiroId: true } } } }),
    prisma.erpMovimento.findMany({ where: { orgId, produtoId: { in: ids }, tipo: 'ENTRADA', qtdMil: { gt: 0 } }, orderBy: { createdAt: 'desc' }, take: 1000, select: { produtoId: true, loteId: true, custoUnitCents: true } }),
  ]);
  const ultPc = new Map<string, (typeof itensPc)[number]>();
  for (const i of itensPc) if (!ultPc.has(i.produtoId)) ultPc.set(i.produtoId, i);
  const ultEnt = new Map<string, (typeof entradas)[number]>();
  for (const m of entradas) if (!ultEnt.has(m.produtoId)) ultEnt.set(m.produtoId, m);
  const lotes = await prisma.erpLote.findMany({ where: { orgId, id: { in: [...ultEnt.values()].map((m) => m.loteId) }, fornecedorId: { not: null } }, select: { id: true, fornecedorId: true } });
  const L = new Map(lotes.map((l) => [l.id, l.fornecedorId!]));
  const fornId = new Map<string, string | null>();
  for (const p of produtos) {
    const e = ultEnt.get(p.id);
    fornId.set(p.id, p.fornecedorPadraoId || ultPc.get(p.id)?.pedido.parceiroId || (e ? L.get(e.loteId) ?? null : null));
  }
  const parceiros = await prisma.erpParceiro.findMany({ where: { orgId, id: { in: [...new Set([...fornId.values()].filter((x): x is string => !!x))] } }, select: { id: true, nome: true, fantasia: true } });
  const N = new Map(parceiros.map((p) => [p.id, p.fantasia || p.nome]));
  const out = new Map<string, { fornecedorId: string | null; fornecedorNome: string | null; custoUnitCents: number; custoOrigem: ItemEstoqueBaixo['custoOrigem'] }>();
  for (const p of produtos) {
    const f = fornId.get(p.id) ?? null;
    const pc = ultPc.get(p.id); const e = ultEnt.get(p.id);
    const [custo, origem]: [number, ItemEstoqueBaixo['custoOrigem']] = pc && pc.precoUnitCents > 0 ? [pc.precoUnitCents, 'compra'] : e && e.custoUnitCents > 0 ? [e.custoUnitCents, 'entrada'] : p.custoMedioCents > 0 ? [p.custoMedioCents, 'medio'] : [0, null];
    out.set(p.id, { fornecedorId: f && N.has(f) ? f : null, fornecedorNome: f ? N.get(f) ?? null : null, custoUnitCents: custo, custoOrigem: origem });
  }
  return out;
}

async function secoesEstoque(orgId: string, cfg: ConfigAlerta, op: OpcoesAlerta, hoje: Date, now: Date) {
  const res: { estoqueBaixo: ItemEstoqueBaixo[] | null; parados: DadosAlerta['parados']; validade: DadosAlerta['validade'] } = { estoqueBaixo: null, parados: null, validade: null };
  if (!cfg.alertaEstoqueMinimo && !(cfg.alertaSemSaidaDias > 0) && !op.validade) return res;
  const produtos = await prisma.erpProduto.findMany({ where: { orgId, ativo: true, tipo: { not: 'SERVICO' } }, select: { id: true, sku: true, nome: true, unidade: true, estoqueMinimoMil: true, custoMedioCents: true, createdAt: true, fornecedorPadraoId: true, leadTimeDias: true, loteMinimoMil: true } });
  const PM = new Map(produtos.map((p) => [p.id, p]));
  const saldos = await prisma.erpSaldo.groupBy({ by: ['produtoId'], where: { orgId }, _sum: { fisicoMil: true } });
  const fis = new Map(saldos.map((s) => [s.produtoId, s._sum.fisicoMil ?? 0]));

  if (cfg.alertaEstoqueMinimo) {
    const abaixo = produtos.filter((p) => p.estoqueMinimoMil > 0 && (fis.get(p.id) ?? 0) < p.estoqueMinimoMil);
    if (abaixo.length) {
      const desde = new Date(now.getTime() - op.consumoDias * DIA);
      const cons = await prisma.erpMovimento.groupBy({ by: ['produtoId'], where: { orgId, produtoId: { in: abaixo.map((p) => p.id) }, tipo: { in: ['SAIDA', 'CONSUMO'] }, createdAt: { gte: desde } }, _sum: { qtdMil: true } });
      const C = new Map(cons.map((c) => [c.produtoId, Math.abs(c._sum.qtdMil ?? 0)]));
      const FC = await fornecedorECusto(orgId, abaixo);
      res.estoqueBaixo = abaixo.map((p) => {
        const saldoMil = fis.get(p.id) ?? 0;
        const sugestao = sugestaoCompra({ saldoMil, minimoMil: p.estoqueMinimoMil, consumoMil: C.get(p.id) ?? 0, consumoDias: op.consumoDias, coberturaDias: op.coberturaDias, leadTimeDias: p.leadTimeDias, loteMinimoMil: p.loteMinimoMil });
        return { produtoId: p.id, sku: p.sku, nome: p.nome, unidade: p.unidade, saldoMil, minimoMil: p.estoqueMinimoMil, sugestao, consumoDias: op.consumoDias, coberturaDias: op.coberturaDias, ...FC.get(p.id)! };
      }).sort((a, b) => (a.saldoMil <= 0 ? 0 : 1) - (b.saldoMil <= 0 ? 0 : 1) || a.saldoMil / a.minimoMil - b.saldoMil / b.minimoMil);
    }
  }

  if (cfg.alertaSemSaidaDias > 0) {
    const desde = new Date(now.getTime() - cfg.alertaSemSaidaDias * DIA);
    const comSaldo = produtos.filter((p) => (fis.get(p.id) ?? 0) > 0 && p.createdAt < desde);
    if (comSaldo.length) {
      const ult = await prisma.erpMovimento.groupBy({ by: ['produtoId'], where: { orgId, produtoId: { in: comSaldo.map((p) => p.id) }, tipo: { in: ['SAIDA', 'CONSUMO'] } }, _max: { createdAt: true } });
      const U = new Map(ult.map((u) => [u.produtoId, u._max.createdAt]));
      const itens: ItemParado[] = comSaldo.filter((p) => { const u = U.get(p.id); return !u || u < desde; }).map((p) => {
        const u = U.get(p.id) ?? null; const saldoMil = fis.get(p.id) ?? 0;
        return { sku: p.sku, nome: p.nome, unidade: p.unidade, saldoMil, ultimaSaida: u, diasParado: Math.floor((now.getTime() - (u ?? p.createdAt).getTime()) / DIA), valorCents: Math.round((saldoMil * p.custoMedioCents) / 1000) };
      }).sort((a, b) => b.valorCents - a.valorCents);
      if (itens.length) res.parados = { dias: cfg.alertaSemSaidaDias, itens };
    }
  }

  if (op.validade) {
    const porLote = await prisma.erpSaldo.groupBy({ by: ['loteId'], where: { orgId, fisicoMil: { gt: 0 } }, _sum: { fisicoMil: true } });
    const S = new Map(porLote.map((s) => [s.loteId, s._sum.fisicoMil ?? 0]));
    const ate = new Date(hoje.getTime() + (op.validadeDias + 1) * DIA - 1);
    const lotes = S.size ? await prisma.erpLote.findMany({ where: { orgId, id: { in: [...S.keys()] }, validade: { not: null, lte: ate } }, orderBy: { validade: 'asc' }, take: 300 }) : [];
    const ls: LoteValidade[] = lotes.filter((l) => PM.has(l.produtoId) && (S.get(l.id) ?? 0) > 0).map((l) => {
      const p = PM.get(l.produtoId)!; const saldoMil = S.get(l.id) ?? 0;
      const v = new Date(`${l.validade!.toISOString().slice(0, 10)}T00:00:00Z`);
      return { sku: p.sku, nome: p.nome, unidade: p.unidade, lote: l.numero, validade: l.validade!, dias: Math.round((v.getTime() - hoje.getTime()) / DIA), saldoMil, valorCents: Math.round((saldoMil * p.custoMedioCents) / 1000) };
    });
    if (ls.length) res.validade = { dias: op.validadeDias, lotes: ls };
  }
  return res;
}

async function caixaDoDia(orgId: string, ini: Date, fim: Date, tz: string): Promise<SessaoCaixa[]> {
  const ss = await prisma.erpCaixaSessao.findMany({
    where: { orgId, OR: [{ abertoEm: { gte: ini, lt: fim } }, { fechadoEm: { gte: ini, lt: fim } }, { status: 'ABERTO', abertoEm: { lt: fim } }] },
    orderBy: { abertoEm: 'asc' }, take: 20,
  });
  if (!ss.length) return [];
  const [movs, contas] = await Promise.all([
    prisma.erpCaixaMovimento.findMany({ where: { sessaoId: { in: ss.map((s) => s.id) } }, orderBy: { em: 'asc' } }),
    prisma.erpContaFinanceira.findMany({ where: { id: { in: [...new Set(ss.map((s) => s.contaFinanceiraId))] } }, select: { id: true, nome: true } }),
  ]);
  const U = await nomesUsuarios([...ss.flatMap((s) => [s.abertoPorUserId, s.fechadoPorUserId]), ...movs.map((m) => m.userId)]);
  const CN = new Map(contas.map((c) => [c.id, c.nome]));
  const out: SessaoCaixa[] = [];
  for (const s of ss) {
    const r = s.status === 'ABERTO' ? await resumoDaSessao(prisma, s) : resumoFechado(s);
    out.push({
      conta: CN.get(s.contaFinanceiraId) ?? 'Caixa', status: s.status, abertoPor: (s.abertoPorUserId && U.get(s.abertoPorUserId)) || '—', abertoEm: ddmmHora(s.abertoEm, tz),
      aberturaCents: s.valorAberturaCents, porForma: r.porForma, totalVendasCents: r.totalVendasCents, qtdVendas: r.qtdVendas,
      sangriasCents: r.sangriasCents, suprimentosCents: r.suprimentosCents,
      movimentos: movs.filter((m) => m.sessaoId === s.id).map((m) => ({ tipo: m.tipo, valorCents: m.valorCents, motivo: m.motivo, quem: (m.userId && U.get(m.userId)) || '—', hora: ddmmHora(m.em, tz) })),
      fechadoPor: s.fechadoPorUserId ? U.get(s.fechadoPorUserId) ?? '—' : null, fechadoEm: s.fechadoEm ? ddmmHora(s.fechadoEm, tz) : null,
      contadoCents: s.valorContadoCents, esperadoCents: s.valorEsperadoCents, diferencaCents: s.diferencaCents, observacao: s.observacaoFechamento,
    });
  }
  return out;
}

async function alteracoesDoDia(orgId: string, ini: Date, fim: Date, tz: string): Promise<Alteracao[]> {
  const logs = await prisma.auditLog.findMany({ where: { orgId, createdAt: { gte: ini, lt: fim }, action: { in: Object.keys(ACOES_ALTERACAO) } }, orderBy: { createdAt: 'asc' }, take: 200 });
  if (!logs.length) return [];
  const metas = logs.map((l) => { try { return JSON.parse(l.meta) as { antes?: any; depois?: any }; } catch { return {}; } });
  // Item afetado: produto direto (produto.*), pelo saldo (ajuste) ou pelo produtoId gravado (entrada).
  const saldoIds = logs.filter((l) => l.entity === 'erp_saldo' && l.entityId).map((l) => l.entityId!);
  const saldos = saldoIds.length ? await prisma.erpSaldo.findMany({ where: { orgId, id: { in: saldoIds } }, select: { id: true, produtoId: true } }) : [];
  const SP = new Map(saldos.map((s) => [s.id, s.produtoId]));
  const prodIds = logs.map((l, i) => (l.entity === 'erp_produto' ? l.entityId : l.entity === 'erp_saldo' ? SP.get(l.entityId ?? '') ?? metas[i].depois?.produtoId : null)).filter((x): x is string => !!x);
  const prods = prodIds.length ? await prisma.erpProduto.findMany({ where: { orgId, id: { in: [...new Set(prodIds)] } }, select: { id: true, sku: true, nome: true, unidade: true } }) : [];
  const PR = new Map(prods.map((p) => [p.id, p]));
  const U = await nomesUsuarios(logs.map((l) => l.userId));
  return logs.map((l, i) => {
    const a = ACOES_ALTERACAO[l.action]; const m = metas[i];
    const pid = l.entity === 'erp_produto' ? l.entityId : l.entity === 'erp_saldo' ? SP.get(l.entityId ?? '') ?? m.depois?.produtoId : null;
    const p = pid ? PR.get(pid) : undefined;
    let detalhe = '';
    if (l.action === 'erp.produto.preco') detalhe = `${brl(m.antes?.precoBaseCents ?? 0)} → ${brl(m.depois?.precoBaseCents ?? 0)}`;
    else if (l.action === 'erp.produto.custo' || l.action === 'erp.produto.custo_xml') detalhe = `${brl(m.antes?.custoMedioCents ?? 0)} → ${brl(m.depois?.custoMedioCents ?? 0)}`;
    else if (l.action === 'erp.estoque.ajuste_saida' || l.action === 'erp.estoque.entrada') {
      const q = Number(m.depois?.qtdMil ?? 0);
      detalhe = `${q > 0 ? '+' : ''}${qtd(q)}${p ? ` ${p.unidade}` : ''}${m.depois?.motivo ? ` · motivo: ${String(m.depois.motivo).slice(0, 80)}` : ''}`;
    }
    if (m.depois?.origem && typeof m.depois.origem === 'string' && /planilha/i.test(m.depois.origem)) detalhe += detalhe ? ' · por planilha' : 'por planilha';
    return { hora: hhmm(l.createdAt, tz), dia: l.createdAt.toISOString().slice(0, 10), quem: (l.userId && U.get(l.userId)) || '', acao: a.nome, item: p ? `${p.sku} ${p.nome}` : '', detalhe, tipo: a.tipo };
  });
}

/** Junta todos os dados do alerta de `hojeIso` (fuso da empresa). */
export async function coletarDados(orgId: string, cfg: ConfigAlerta, op: OpcoesAlerta, hojeIso: string, now = new Date()): Promise<DadosAlerta> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true, timezone: true } });
  const tz = org?.timezone || 'America/Sao_Paulo';
  const hoje = new Date(`${hojeIso}T00:00:00Z`);
  const ontemIso = diaAnterior(hojeIso);
  const { ini, fim } = janelaDoDia(ontemIso, tz);
  const [pagar, est, caixa, alteracoes] = await Promise.all([
    cfg.alertaPagar ? contasPagar(orgId, cfg.alertaDiasAntes, hoje) : Promise.resolve(null),
    secoesEstoque(orgId, cfg, op, hoje, now),
    op.caixa ? caixaDoDia(orgId, ini, fim, tz) : Promise.resolve(null),
    op.alteracoes ? alteracoesDoDia(orgId, ini, fim, tz) : Promise.resolve(null),
  ]);
  return { empresa: org?.name ?? '', hojeIso, ontemIso, pagar, ...est, caixa, alteracoes };
}
