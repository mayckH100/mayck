/**
 * Produção/MRP: estrutura (BOM) e roteiro, custo padrão, ordem de produção (liberação com reserva, apontamento com
 * consumo por backflush, lote interno e genealogia componente → produto), e MRP que sugere OPs e compras.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, badRequest, notFound } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { transicionar, eventosPermitidos } from '../shared/statemachine.js';
import { emitir, despacharEmBreve } from '../shared/events.js';
import { vincular } from '../shared/trace.js';
import { auditar } from '../shared/auditoria.js';
import { configDa } from '../produtos/produtos.routes.js';
import { proximoNumero } from '../compras/compras.routes.js';
import { entrada } from '../estoque/servico.js';
import { numeroLoteInterno } from '../estoque/nfe-xml.js';
import { maquinaOp, type StatusOp, type EventoOp } from './op.machine.js';
import { criaCiclo, custoPadrao, necessidadeComponente, calcularMrp } from './mrp.js';
import { reservarComponente, liberarReservasOp, consumirComponente } from './servico.js';

export const producaoRouter = Router();
const custoOpUn = (ops: { segundosPorUn: number; custoHoraCents: number }[]) => ops.reduce((a, o) => a + (o.segundosPorUn * o.custoHoraCents) / 3600, 0);

// ---------------- Estrutura e roteiro ----------------
producaoRouter.get('/estruturas/:produtoId', ah(async (req, res) => {
  const orgId = orgOf(req);
  const p = await prisma.erpProduto.findFirst({ where: { id: req.params.produtoId, orgId } });
  if (!p) throw notFound('Produto');
  const [estrutura, ops, usadoEm] = await Promise.all([
    prisma.erpEstruturaItem.findMany({ where: { orgId } }),
    prisma.erpOperacao.findMany({ where: { orgId, produtoId: p.id }, orderBy: { sequencia: 'asc' } }),
    prisma.erpEstruturaItem.findMany({ where: { orgId, componenteId: p.id } }),
  ]);
  const ids = [...new Set([...estrutura.map((e) => e.componenteId), ...estrutura.map((e) => e.produtoId)])];
  const prods = await prisma.erpProduto.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, sku: true, nome: true, unidade: true, custoMedioCents: true } });
  const P = new Map(prods.map((x) => [x.id, x]));
  const todasOps = await prisma.erpOperacao.findMany({ where: { orgId } });
  const custoOp = new Map<string, number>();
  for (const o of todasOps) custoOp.set(o.produtoId, (custoOp.get(o.produtoId) ?? 0) + custoOpUn([o]));
  res.json({
    produto: p,
    itens: estrutura.filter((e) => e.produtoId === p.id).sort((a, b) => a.posicao - b.posicao).map((e) => ({ ...e, componente: P.get(e.componenteId) })),
    operacoes: ops,
    usadoEm: usadoEm.map((e) => P.get(e.produtoId)).filter(Boolean),
    custoPadraoCents: custoPadrao(p.id, estrutura, new Map<string, number>([...prods.map((x) => [x.id, x.custoMedioCents] as [string, number]), [p.id, p.custoMedioCents]]), custoOp),
  });
}));

producaoRouter.put('/estruturas/:produtoId', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({
    itens: z.array(z.object({ componenteId: z.string(), qtdMil: z.number().int().min(1).max(2_000_000_000), perdaBp: z.number().int().min(0).max(5000).default(0) })).max(300),
    operacoes: z.array(z.object({ descricao: z.string().trim().min(1).max(120), centroTrabalho: z.string().trim().min(1).max(60), segundosPorUn: z.number().int().min(0).max(864_000), setupMinutos: z.number().int().min(0).max(10_000).default(0), custoHoraCents: z.number().int().min(0).max(100_000_000).default(0) })).max(100).default([]),
  }).parse(req.body);
  const p = await prisma.erpProduto.findFirst({ where: { id: req.params.produtoId, orgId } });
  if (!p) throw notFound('Produto');
  if (new Set(b.itens.map((i) => i.componenteId)).size !== b.itens.length) throw badRequest('Componente repetido na estrutura');
  const comps = await prisma.erpProduto.findMany({ where: { orgId, id: { in: b.itens.map((i) => i.componenteId) } } });
  if (comps.length !== b.itens.length) throw badRequest('Componente inválido');
  if (comps.some((c) => c.tipo === 'SERVICO')) throw badRequest('Serviço não entra na estrutura');
  const outras = (await prisma.erpEstruturaItem.findMany({ where: { orgId, produtoId: { not: p.id } } }));
  for (const i of b.itens) if (criaCiclo([...outras, ...b.itens.map((x) => ({ ...x, produtoId: p.id, perdaBp: x.perdaBp }))].filter((x) => !(x.produtoId === p.id && x.componenteId === i.componenteId)), p.id, i.componenteId)) {
    throw badRequest(`${comps.find((c) => c.id === i.componenteId)?.sku}: a estrutura ficaria circular`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.erpEstruturaItem.deleteMany({ where: { orgId, produtoId: p.id } });
    await tx.erpOperacao.deleteMany({ where: { orgId, produtoId: p.id } });
    if (b.itens.length) await tx.erpEstruturaItem.createMany({ data: b.itens.map((i, n) => ({ orgId, produtoId: p.id, componenteId: i.componenteId, qtdMil: i.qtdMil, perdaBp: i.perdaBp, posicao: n })) });
    if (b.operacoes.length) await tx.erpOperacao.createMany({ data: b.operacoes.map((o, n) => ({ orgId, produtoId: p.id, sequencia: (n + 1) * 10, ...o })) });
    if (b.itens.length && p.tipo !== 'PRODUZIDO') await tx.erpProduto.update({ where: { id: p.id }, data: { tipo: 'PRODUZIDO' } });
  });
  await auditar(req, 'estrutura.salvar', 'erp_produto', p.id, null, { componentes: b.itens.length, operacoes: b.operacoes.length });
  res.json({ ok: true });
}));

// ---------------- Ordens de produção ----------------
async function detalheOp(orgId: string, id: string) {
  const op = await prisma.erpOrdemProducao.findFirst({ where: { id, orgId }, include: { componentes: true, apontamentos: { orderBy: { createdAt: 'desc' } } } });
  if (!op) throw notFound('Ordem de produção');
  const prods = await prisma.erpProduto.findMany({ where: { id: { in: [op.produtoId, ...op.componentes.map((c) => c.produtoId)] } }, select: { id: true, sku: true, nome: true, unidade: true, controlaLote: true, controlaValidade: true } });
  const P = new Map(prods.map((x) => [x.id, x]));
  const lotes = await prisma.erpLote.findMany({ where: { id: { in: op.apontamentos.map((a) => a.loteId).filter(Boolean) as string[] } }, select: { id: true, numero: true } });
  const L = new Map(lotes.map((l) => [l.id, l.numero]));
  return { ...op, produto: P.get(op.produtoId), componentes: op.componentes.map((c) => ({ ...c, produto: P.get(c.produtoId) })), apontamentos: op.apontamentos.map((a) => ({ ...a, lote: a.loteId ? L.get(a.loteId) : null })), acoes: eventosPermitidos(maquinaOp, op.status as StatusOp).filter((e) => e !== 'APONTAR') };
}

producaoRouter.get('/ops', ah(async (req, res) => {
  const orgId = orgOf(req);
  const l = await prisma.erpOrdemProducao.findMany({ where: { orgId, ...(typeof req.query.status === 'string' ? { status: req.query.status } : {}) }, orderBy: { numero: 'desc' }, take: 300 });
  const prods = await prisma.erpProduto.findMany({ where: { id: { in: l.map((o) => o.produtoId) } }, select: { id: true, sku: true, nome: true, unidade: true } });
  const P = new Map(prods.map((x) => [x.id, x]));
  res.json(l.map((o) => ({ ...o, produto: P.get(o.produtoId) })));
}));
producaoRouter.get('/ops/:id', ah(async (req, res) => res.json(await detalheOp(orgOf(req), req.params.id))));

export async function criarOp(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], orgId: string, d: { produtoId: string; qtdPlanejadaMil: number; origem?: string; pedidoVendaId?: string | null; depositoId?: string | null; inicioPrevisto?: Date | null; fimPrevisto?: Date | null }) {
  const p = await tx.erpProduto.findFirst({ where: { id: d.produtoId, orgId } });
  if (!p) throw badRequest('Produto inválido');
  const estrutura = await tx.erpEstruturaItem.findMany({ where: { orgId, produtoId: p.id }, orderBy: { posicao: 'asc' } });
  if (!estrutura.length) throw badRequest(`${p.sku} não tem estrutura: cadastre os componentes antes`);
  return tx.erpOrdemProducao.create({ data: {
    orgId, numero: await proximoNumero(tx, orgId, 'proximaOp'), produtoId: p.id, qtdPlanejadaMil: d.qtdPlanejadaMil, origem: d.origem ?? 'MANUAL', pedidoVendaId: d.pedidoVendaId ?? null, depositoId: d.depositoId ?? null,
    inicioPrevisto: d.inicioPrevisto ?? null, fimPrevisto: d.fimPrevisto ?? (p.leadTimeDias ? new Date(Date.now() + p.leadTimeDias * 86_400_000) : null),
    componentes: { create: estrutura.map((e) => ({ produtoId: e.componenteId, qtdPrevistaMil: necessidadeComponente(d.qtdPlanejadaMil, e) })) },
  } });
}

producaoRouter.post('/ops', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ produtoId: z.string(), qtdPlanejadaMil: z.number().int().min(1).max(2_000_000_000), pedidoVendaId: z.string().nullish(), depositoId: z.string().nullish(), inicioPrevisto: z.coerce.date().nullish(), fimPrevisto: z.coerce.date().nullish() }).parse(req.body);
  const op = await prisma.$transaction(async (tx) => {
    const op = await criarOp(tx, orgId, { ...b, origem: b.pedidoVendaId ? 'PEDIDO' : 'MANUAL' });
    if (b.pedidoVendaId) await vincular(tx, orgId, { tipo: 'pedido_venda', id: b.pedidoVendaId }, { tipo: 'op', id: op.id }, 'gerou');
    return op;
  });
  await auditar(req, 'op.criar', 'erp_ordem_producao', op.id, null, { numero: op.numero });
  res.status(201).json(op);
}));

producaoRouter.post('/ops/:id/acao', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { evento, motivo } = z.object({ evento: z.enum(['LIBERAR', 'INICIAR', 'ENCERRAR', 'CANCELAR', 'ESTORNAR_LIBERACAO']), motivo: z.string().trim().max(300).optional() }).parse(req.body);
  const op = await prisma.erpOrdemProducao.findFirst({ where: { id: req.params.id, orgId }, include: { componentes: true } });
  if (!op) throw notFound('Ordem de produção');
  const faltas: string[] = [];
  await prisma.$transaction(async (tx) => {
    if (evento === 'LIBERAR') {
      for (const c of op.componentes) {
        const f = await reservarComponente(tx, orgId, c, op.depositoId);
        if (f > 0) faltas.push(`${(await tx.erpProduto.findUniqueOrThrow({ where: { id: c.produtoId } })).sku}: faltam ${f / 1000}`);
      }
    }
    const r = transicionar(maquinaOp, op.status as StatusOp, evento as EventoOp, { componentes: op.componentes.length, faltas: faltas.length, produzidoMil: op.qtdProduzidaMil, motivo });
    if (!r.ok) throw badRequest(faltas.length ? `Componentes em falta: ${faltas.join('; ')}` : r.erro, faltas.length ? { faltas } : undefined);
    if (['CANCELAR', 'ESTORNAR_LIBERACAO', 'ENCERRAR'].includes(evento)) await liberarReservasOp(tx, op.componentes.map((c) => c.id));
    await tx.erpOrdemProducao.update({ where: { id: op.id }, data: { status: r.para, ...(motivo ? { motivo } : {}) } });
    for (const tipo of r.emite) await emitir(tx, { orgId, tipo, agregado: 'op', agregadoId: op.id, payload: { numero: op.numero, produtoId: op.produtoId, produzidoMil: op.qtdProduzidaMil } });
  });
  despacharEmBreve();
  await auditar(req, `op.${evento.toLowerCase()}`, 'erp_ordem_producao', op.id, { status: op.status }, null);
  res.json(await detalheOp(orgId, op.id));
}));

/**
 * Apontamento: consome os componentes na proporção do que foi produzido (boa + refugo), dá entrada do produto
 * com lote interno ao custo real (materiais + operações) e grava a genealogia lote componente → lote produzido.
 */
producaoRouter.post('/ops/:id/apontar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ qtdBoaMil: z.number().int().min(0).max(2_000_000_000), qtdRefugoMil: z.number().int().min(0).max(2_000_000_000).default(0), enderecoId: z.string(), validade: z.coerce.date().nullish(), encerrar: z.boolean().default(false) }).parse(req.body);
  if (b.qtdBoaMil + b.qtdRefugoMil <= 0) throw badRequest('Informe a quantidade produzida');
  const op = await prisma.erpOrdemProducao.findFirst({ where: { id: req.params.id, orgId }, include: { componentes: true, apontamentos: true } });
  if (!op) throw notFound('Ordem de produção');
  const r0 = transicionar(maquinaOp, op.status as StatusOp, 'APONTAR', { componentes: op.componentes.length, faltas: 0, produzidoMil: op.qtdProduzidaMil });
  if (!r0.ok) throw badRequest(op.status === 'PLANEJADA' ? 'Libere a OP antes de apontar' : r0.erro);
  const cfg = await configDa(orgId);
  const produto = await prisma.erpProduto.findUniqueOrThrow({ where: { id: op.produtoId } });
  const estrutura = await prisma.erpEstruturaItem.findMany({ where: { orgId, produtoId: op.produtoId } });
  const ops = await prisma.erpOperacao.findMany({ where: { orgId, produtoId: op.produtoId } });
  await prisma.$transaction(async (tx) => {
    const totalApos = op.qtdProduzidaMil + op.qtdRefugoMil + b.qtdBoaMil + b.qtdRefugoMil;
    const motivo = `OP ${op.numero}`;
    let custoMat = 0; const lotesUsados: string[] = [];
    for (const c of op.componentes) {
      const e = estrutura.find((x) => x.componenteId === c.produtoId);
      const devido = e ? necessidadeComponente(totalApos, e) : Math.round((c.qtdPrevistaMil * totalApos) / op.qtdPlanejadaMil);
      const q = devido - c.qtdConsumidaMil;
      if (q <= 0) continue;
      const r = await consumirComponente(tx, { orgId, opId: op.id, compId: c.id, produtoId: c.produtoId, qtdMil: q, userId: req.auth?.userId, motivo });
      custoMat += r.custoCents; lotesUsados.push(...r.lotes);
    }
    const setup = op.apontamentos.length ? 0 : ops.reduce((a, o) => a + (o.setupMinutos * o.custoHoraCents) / 60, 0);
    const custoOperacao = Math.round(setup + (custoOpUn(ops) * (b.qtdBoaMil + b.qtdRefugoMil)) / 1000);
    const custoUnit = b.qtdBoaMil > 0 ? Math.round(((custoMat + custoOperacao) * 1000) / b.qtdBoaMil) : 0;
    let loteId: string | null = null;
    if (b.qtdBoaMil > 0) {
      let numero: string | null = null;
      if (produto.controlaLote) {
        const c = await tx.erpConfig.update({ where: { orgId }, data: { proximoLoteInterno: { increment: 1 } } });
        numero = numeroLoteInterno(cfg.formatoLote, c.proximoLoteInterno - 1, produto.sku);
      }
      const r = await entrada(tx, { orgId, produtoId: produto.id, enderecoId: b.enderecoId, qtdMil: b.qtdBoaMil, custoUnitCents: custoUnit, tipo: 'PRODUCAO', docTipo: 'op', docId: op.id, motivo, userId: req.auth?.userId, lote: { numero, validade: b.validade ?? null, fabricacao: new Date() } });
      loteId = r.lote.id;
      if (produto.controlaLote) {
        await tx.erpLote.update({ where: { id: r.lote.id }, data: { origemTipo: 'op', origemId: op.id } });
        await vincular(tx, orgId, { tipo: 'op', id: op.id }, { tipo: 'lote', id: r.lote.id }, 'produziu');
      }
      for (const l of new Set(lotesUsados)) await vincular(tx, orgId, { tipo: 'lote', id: l }, { tipo: 'lote', id: r.lote.id }, 'compoe');
    }
    await tx.erpOpApontamento.create({ data: { opId: op.id, qtdBoaMil: b.qtdBoaMil, qtdRefugoMil: b.qtdRefugoMil, loteId, custoUnitCents: custoUnit, userId: req.auth?.userId ?? null } });
    await tx.erpOrdemProducao.update({ where: { id: op.id }, data: { status: 'EM_PRODUCAO', qtdProduzidaMil: { increment: b.qtdBoaMil }, qtdRefugoMil: { increment: b.qtdRefugoMil }, custoMaterialCents: { increment: custoMat }, custoOperacaoCents: { increment: custoOperacao } } });
    await emitir(tx, { orgId, tipo: 'producao.op.apontada', agregado: 'op', agregadoId: op.id, payload: { numero: op.numero, boaMil: b.qtdBoaMil, refugoMil: b.qtdRefugoMil } });
    if (b.encerrar) {
      const comps = await tx.erpOpComponente.findMany({ where: { opId: op.id } });
      await liberarReservasOp(tx, comps.map((c) => c.id));
      const prod = op.qtdProduzidaMil + b.qtdBoaMil;
      const r = transicionar(maquinaOp, 'EM_PRODUCAO', 'ENCERRAR', { componentes: comps.length, faltas: 0, produzidoMil: prod });
      if (!r.ok) throw badRequest(r.erro);
      await tx.erpOrdemProducao.update({ where: { id: op.id }, data: { status: 'ENCERRADA' } });
      await emitir(tx, { orgId, tipo: 'producao.op.encerrada', agregado: 'op', agregadoId: op.id, payload: { numero: op.numero, produtoId: op.produtoId, produzidoMil: prod } });
    }
  });
  despacharEmBreve();
  await auditar(req, 'op.apontar', 'erp_ordem_producao', op.id, null, { boa: b.qtdBoaMil, refugo: b.qtdRefugoMil });
  res.json(await detalheOp(orgId, op.id));
}));

// ---------------- MRP ----------------
async function entradaMrp(orgId: string) {
  const [produtos, estrutura, saldos, pedidos, pcs, opsAbertas] = await Promise.all([
    prisma.erpProduto.findMany({ where: { orgId, ativo: true, tipo: { not: 'SERVICO' } } }),
    prisma.erpEstruturaItem.findMany({ where: { orgId } }),
    prisma.erpSaldo.findMany({ where: { orgId } }),
    prisma.erpPedidoVenda.findMany({ where: { orgId, statusOperacional: { in: ['APROVADO', 'AGUARDANDO_SUPRIMENTO', 'EM_APROVACAO', 'BLOQUEADO'] } }, include: { itens: true } }),
    prisma.erpPedidoCompra.findMany({ where: { orgId, status: { in: ['RASCUNHO', 'EM_APROVACAO', 'APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL'] } }, include: { itens: true } }),
    prisma.erpOrdemProducao.findMany({ where: { orgId, status: { in: ['PLANEJADA', 'LIBERADA', 'EM_PRODUCAO'] } }, include: { componentes: true } }),
  ]);
  const soma = (m: Map<string, number>, k: string, v: number) => { if (v > 0) m.set(k, (m.get(k) ?? 0) + v); };
  const disponivelMil = new Map<string, number>(); for (const s of saldos) soma(disponivelMil, s.produtoId, s.fisicoMil - s.reservadoMil - s.quarentenaMil);
  const demandaMil = new Map<string, number>(); for (const p of pedidos) for (const i of p.itens) soma(demandaMil, i.produtoId, i.qtdMil - i.reservadoMil);
  const programadoMil = new Map<string, number>();
  for (const pc of pcs) for (const i of pc.itens) soma(programadoMil, i.produtoId, i.qtdMil - i.recebidoMil);
  for (const o of opsAbertas) soma(programadoMil, o.produtoId, o.qtdPlanejadaMil - o.qtdProduzidaMil - o.qtdRefugoMil);
  const dependenteMil = new Map<string, number>(); for (const o of opsAbertas) for (const c of o.componentes) soma(dependenteMil, c.produtoId, c.qtdPrevistaMil - c.qtdConsumidaMil - c.qtdReservadaMil);
  // solicitações de compra em andamento também contam como "a receber"
  const sols = await prisma.erpSolicitacaoCompra.findMany({ where: { orgId, status: { in: ['RASCUNHO', 'EM_APROVACAO', 'APROVADA'] } }, include: { itens: true } });
  for (const s of sols) for (const i of s.itens) soma(programadoMil, i.produtoId, i.qtdMil - i.atendidoMil);
  return { produtos, estrutura, disponivelMil, demandaMil, dependenteMil, programadoMil };
}

producaoRouter.get('/mrp', ah(async (req, res) => {
  const orgId = orgOf(req);
  const e = await entradaMrp(orgId);
  const sug = calcularMrp(e);
  const forn = await prisma.erpParceiro.findMany({ where: { orgId, id: { in: sug.map((s) => s.fornecedorPadraoId).filter(Boolean) as string[] } }, select: { id: true, nome: true, fantasia: true } });
  const F = new Map(forn.map((f) => [f.id, f.fantasia || f.nome]));
  res.json(sug.map((s) => ({ ...s, fornecedor: s.fornecedorPadraoId ? F.get(s.fornecedorPadraoId) ?? null : null, unidade: e.produtos.find((p) => p.id === s.produtoId)?.unidade })));
}));

/** Aplica sugestões escolhidas: OPs planejadas e uma solicitação de compra (origem MRP) já enviada para aprovação. */
producaoRouter.post('/mrp/aplicar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ itens: z.array(z.object({ produtoId: z.string(), acao: z.enum(['PRODUZIR', 'COMPRAR']), qtdMil: z.number().int().min(1).max(2_000_000_000) })).min(1).max(500) }).parse(req.body);
  const out = await prisma.$transaction(async (tx) => {
    const ops: { id: string; numero: number }[] = [];
    for (const i of b.itens.filter((x) => x.acao === 'PRODUZIR')) ops.push(await criarOp(tx, orgId, { produtoId: i.produtoId, qtdPlanejadaMil: i.qtdMil, origem: 'MRP' }));
    const compras = b.itens.filter((x) => x.acao === 'COMPRAR');
    let solicitacao: { id: string; numero: number } | null = null;
    if (compras.length) {
      const n = await tx.erpProduto.count({ where: { orgId, id: { in: compras.map((c) => c.produtoId) } } });
      if (n !== new Set(compras.map((c) => c.produtoId)).size) throw badRequest('Produto inválido');
      solicitacao = await tx.erpSolicitacaoCompra.create({ data: { orgId, numero: await proximoNumero(tx, orgId, 'proximaSolicitacao'), solicitanteId: req.auth?.userId ?? null, origem: 'MRP', justificativa: 'Sugestão do MRP', status: 'EM_APROVACAO', itens: { create: compras.map((c) => ({ produtoId: c.produtoId, qtdMil: c.qtdMil })) } } });
    }
    return { ops: ops.map((o) => ({ id: o.id, numero: o.numero })), solicitacao: solicitacao && { id: solicitacao.id, numero: solicitacao.numero } };
  });
  await auditar(req, 'mrp.aplicar', 'erp_mrp', orgId, null, { ops: out.ops.length, solicitacao: out.solicitacao?.numero ?? null });
  res.json(out);
}));
