/**
 * Compras: solicitação (com aprovação) → cotação com vários fornecedores (mapa e vencedoras) → pedido de compra
 * com alçada → recebimento pela NF-e de entrada (confronto de quantidade e preço em nfe.routes).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { ah, badRequest, notFound } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { transicionar, eventosPermitidos } from '../shared/statemachine.js';
import { emitir, despacharEmBreve } from '../shared/events.js';
import { vincular } from '../shared/trace.js';
import { auditar } from '../shared/auditoria.js';
import { configDa } from '../produtos/produtos.routes.js';
import { maquinaSolicitacao, maquinaCompra, vencedoras, type StatusSolicitacao, type EventoSolicitacao, type StatusCompra, type EventoCompra } from './compra.machine.js';

type Tx = Prisma.TransactionClient;
export const comprasRouter = Router();
const gestorDe = (req: { auth?: { role?: string | null } }) => req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';
const js = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };

export async function proximoNumero(tx: Tx, orgId: string, campo: 'proximaSolicitacao' | 'proximaCotacao' | 'proximoPedidoCompra' | 'proximaOp') {
  await configDa(orgId, tx);
  const c = await tx.erpConfig.update({ where: { orgId }, data: { [campo]: { increment: 1 } } });
  return (c[campo] as number) - 1;
}
async function produtosDe(orgId: string, ids: string[]) {
  const ps = await prisma.erpProduto.findMany({ where: { orgId, id: { in: [...new Set(ids)] } }, select: { id: true, sku: true, nome: true, unidade: true, custoMedioCents: true } });
  return new Map(ps.map((p) => [p.id, p]));
}
async function parceirosDe(orgId: string, ids: string[]) {
  const ps = await prisma.erpParceiro.findMany({ where: { orgId, id: { in: [...new Set(ids)] } }, select: { id: true, nome: true, fantasia: true, documento: true, email: true, telefone: true } });
  return new Map(ps.map((p) => [p.id, p]));
}
const itensSchema = z.array(z.object({ produtoId: z.string(), qtdMil: z.number().int().min(1).max(2_000_000_000) })).min(1, 'Inclua ao menos um item').max(500);
async function validarProdutos(orgId: string, ids: string[]) {
  const n = await prisma.erpProduto.count({ where: { orgId, id: { in: [...new Set(ids)] }, tipo: { not: 'SERVICO' } } });
  if (n !== new Set(ids).size) throw badRequest('Produto inválido na lista');
}

// ---------------- Solicitações ----------------
comprasRouter.get('/solicitacoes', ah(async (req, res) => {
  const orgId = orgOf(req);
  const l = await prisma.erpSolicitacaoCompra.findMany({ where: { orgId, ...(typeof req.query.status === 'string' ? { status: req.query.status } : {}) }, include: { itens: true }, orderBy: { numero: 'desc' }, take: 200 });
  const P = await produtosDe(orgId, l.flatMap((s) => s.itens.map((i) => i.produtoId)));
  res.json(l.map((s) => ({ ...s, itens: s.itens.map((i) => ({ ...i, produto: P.get(i.produtoId) })), acoes: eventosPermitidos(maquinaSolicitacao, s.status as StatusSolicitacao) })));
}));

comprasRouter.post('/solicitacoes', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ justificativa: z.string().trim().max(1000).nullish(), centroCustoId: z.string().nullish(), necessidadeEm: z.coerce.date().nullish(), itens: itensSchema, enviar: z.boolean().default(false) }).parse(req.body);
  await validarProdutos(orgId, b.itens.map((i) => i.produtoId));
  const s = await prisma.$transaction(async (tx) => tx.erpSolicitacaoCompra.create({ data: { orgId, numero: await proximoNumero(tx, orgId, 'proximaSolicitacao'), solicitanteId: req.auth?.userId ?? null, justificativa: b.justificativa ?? null, centroCustoId: b.centroCustoId ?? null, necessidadeEm: b.necessidadeEm ?? null, status: b.enviar ? 'EM_APROVACAO' : 'RASCUNHO', itens: { create: b.itens } } }));
  await auditar(req, 'solicitacao_compra.criar', 'erp_solicitacao_compra', s.id, null, { numero: s.numero });
  res.status(201).json(s);
}));

comprasRouter.post('/solicitacoes/:id/acao', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { evento, motivo } = z.object({ evento: z.enum(['ENVIAR', 'APROVAR', 'REPROVAR', 'ATENDER', 'CANCELAR', 'REABRIR']), motivo: z.string().trim().max(300).optional() }).parse(req.body);
  const s = await prisma.erpSolicitacaoCompra.findFirst({ where: { id: req.params.id, orgId }, include: { itens: true } });
  if (!s) throw notFound('Solicitação');
  const r = transicionar(maquinaSolicitacao, s.status as StatusSolicitacao, evento as EventoSolicitacao, { itens: s.itens.length, motivo, gestor: gestorDe(req) });
  if (!r.ok) throw badRequest(r.erro);
  const novo = await prisma.$transaction(async (tx) => {
    const n = await tx.erpSolicitacaoCompra.update({ where: { id: s.id }, data: { status: r.para, motivo: motivo ?? s.motivo, ...(evento === 'APROVAR' ? { aprovadoPorId: req.auth?.userId ?? null } : {}) } });
    for (const tipo of r.emite) await emitir(tx, { orgId, tipo, agregado: 'solicitacao_compra', agregadoId: s.id, payload: { numero: s.numero } });
    return n;
  });
  despacharEmBreve();
  await auditar(req, `solicitacao_compra.${evento.toLowerCase()}`, 'erp_solicitacao_compra', s.id, { status: s.status }, { status: r.para });
  res.json(novo);
}));

// ---------------- Cotações ----------------
comprasRouter.get('/cotacoes', ah(async (req, res) => {
  const orgId = orgOf(req);
  res.json(await prisma.erpCotacao.findMany({ where: { orgId }, orderBy: { numero: 'desc' }, take: 200, include: { _count: { select: { itens: true, respostas: true } } } }));
}));

comprasRouter.get('/cotacoes/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await prisma.erpCotacao.findFirst({ where: { id: req.params.id, orgId }, include: { itens: true, respostas: true } });
  if (!c) throw notFound('Cotação');
  const forn = js<string[]>(c.fornecedores, []);
  const [P, F] = await Promise.all([produtosDe(orgId, c.itens.map((i) => i.produtoId)), parceirosDe(orgId, [...forn, ...c.respostas.map((r) => r.parceiroId)])]);
  const melhor = vencedoras(c.respostas);
  res.json({
    ...c, fornecedores: forn.map((id) => F.get(id)).filter(Boolean),
    itens: c.itens.map((i) => ({ ...i, produto: P.get(i.produtoId), melhorParceiroId: melhor.get(i.id)?.parceiroId ?? null })),
    respostas: c.respostas.map((r) => ({ ...r, parceiro: F.get(r.parceiroId) })),
  });
}));

comprasRouter.post('/cotacoes', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ solicitacaoId: z.string().nullish(), itens: itensSchema.optional(), fornecedores: z.array(z.string()).min(1, 'Convide ao menos um fornecedor').max(30), prazoResposta: z.coerce.date().nullish() }).parse(req.body);
  let itens: { produtoId: string; qtdMil: number; solicitacaoItemId?: string }[] = b.itens ?? [];
  if (b.solicitacaoId) {
    const s = await prisma.erpSolicitacaoCompra.findFirst({ where: { id: b.solicitacaoId, orgId }, include: { itens: true } });
    if (!s) throw notFound('Solicitação');
    if (s.status !== 'APROVADA') throw badRequest('Só solicitação aprovada vira cotação');
    itens = s.itens.filter((i) => i.qtdMil > i.atendidoMil).map((i) => ({ produtoId: i.produtoId, qtdMil: i.qtdMil - i.atendidoMil, solicitacaoItemId: i.id }));
  }
  if (!itens.length) throw badRequest('Cotação sem itens');
  await validarProdutos(orgId, itens.map((i) => i.produtoId));
  const nF = await prisma.erpParceiro.count({ where: { orgId, id: { in: b.fornecedores } } });
  if (nF !== new Set(b.fornecedores).size) throw badRequest('Fornecedor inválido');
  const c = await prisma.$transaction(async (tx) => {
    const c = await tx.erpCotacao.create({ data: { orgId, numero: await proximoNumero(tx, orgId, 'proximaCotacao'), solicitacaoId: b.solicitacaoId ?? null, prazoResposta: b.prazoResposta ?? null, fornecedores: JSON.stringify([...new Set(b.fornecedores)]), itens: { create: itens } } });
    if (b.solicitacaoId) await vincular(tx, orgId, { tipo: 'solicitacao_compra', id: b.solicitacaoId }, { tipo: 'cotacao', id: c.id }, 'cotou');
    return c;
  });
  await auditar(req, 'cotacao.criar', 'erp_cotacao', c.id, null, { numero: c.numero });
  res.status(201).json(c);
}));

/** Lança a proposta de um fornecedor (recebida por e-mail/WhatsApp/telefone). */
comprasRouter.put('/cotacoes/:id/respostas', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ parceiroId: z.string(), condicao: z.string().trim().max(100).nullish(), respostas: z.array(z.object({ itemId: z.string(), precoUnitCents: z.number().int().min(0).max(2_000_000_000), prazoEntregaDias: z.number().int().min(0).max(365).default(0) })).min(1) }).parse(req.body);
  const c = await prisma.erpCotacao.findFirst({ where: { id: req.params.id, orgId }, include: { itens: true } });
  if (!c) throw notFound('Cotação');
  if (c.status !== 'ABERTA') throw badRequest('Cotação encerrada');
  if (!js<string[]>(c.fornecedores, []).includes(b.parceiroId)) throw badRequest('Fornecedor não foi convidado para esta cotação');
  const ids = new Set(c.itens.map((i) => i.id));
  await prisma.$transaction(b.respostas.filter((r) => ids.has(r.itemId)).map((r) => prisma.erpCotacaoResposta.upsert({
    where: { itemId_parceiroId: { itemId: r.itemId, parceiroId: b.parceiroId } },
    create: { cotacaoId: c.id, itemId: r.itemId, parceiroId: b.parceiroId, precoUnitCents: r.precoUnitCents, prazoEntregaDias: r.prazoEntregaDias, condicao: b.condicao ?? null },
    update: { precoUnitCents: r.precoUnitCents, prazoEntregaDias: r.prazoEntregaDias, condicao: b.condicao ?? null },
  })));
  res.json({ ok: true });
}));

/** Encerra: escolhe vencedora por item (a melhor do mapa, ou a escolha do comprador) e gera um pedido de compra por fornecedor. */
comprasRouter.post('/cotacoes/:id/encerrar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ escolhas: z.record(z.string()).default({}) }).parse(req.body);
  const c = await prisma.erpCotacao.findFirst({ where: { id: req.params.id, orgId }, include: { itens: true, respostas: true } });
  if (!c) throw notFound('Cotação');
  if (c.status !== 'ABERTA') throw badRequest('Cotação já encerrada');
  const melhor = vencedoras(c.respostas);
  const P = await produtosDe(orgId, c.itens.map((i) => i.produtoId));
  const porForn = new Map<string, { item: (typeof c.itens)[number]; resp: (typeof c.respostas)[number] }[]>();
  for (const item of c.itens) {
    const escolhido = b.escolhas[item.id];
    const resp = escolhido ? c.respostas.find((r) => r.itemId === item.id && r.parceiroId === escolhido && r.precoUnitCents > 0) : melhor.get(item.id);
    if (!resp) throw badRequest(`Item ${P.get(item.produtoId)?.sku}: sem proposta válida`);
    porForn.set(resp.parceiroId, [...(porForn.get(resp.parceiroId) ?? []), { item, resp }]);
  }
  const pedidos = await prisma.$transaction(async (tx) => {
    const out: { id: string; numero: number }[] = [];
    for (const [parceiroId, linhas] of porForn) {
      const prazo = Math.max(...linhas.map((l) => l.resp.prazoEntregaDias));
      const itens = linhas.map(({ item, resp }) => ({ produtoId: item.produtoId, descricao: P.get(item.produtoId)?.nome ?? '', qtdMil: item.qtdMil, precoUnitCents: resp.precoUnitCents, totalCents: Math.round((item.qtdMil * resp.precoUnitCents) / 1000), solicitacaoItemId: item.solicitacaoItemId }));
      const pc = await tx.erpPedidoCompra.create({ data: { orgId, numero: await proximoNumero(tx, orgId, 'proximoPedidoCompra'), parceiroId, cotacaoId: c.id, condicao: linhas[0].resp.condicao, previsaoEntrega: new Date(Date.now() + prazo * 86_400_000), totalCents: itens.reduce((a, i) => a + i.totalCents, 0), itens: { create: itens } } });
      await vincular(tx, orgId, { tipo: 'cotacao', id: c.id }, { tipo: 'pedido_compra', id: pc.id }, 'gerou');
      for (const l of linhas) await tx.erpCotacaoResposta.update({ where: { id: l.resp.id }, data: { vencedora: true } });
      out.push(pc);
    }
    for (const item of c.itens) if (item.solicitacaoItemId) await tx.erpSolicitacaoItem.update({ where: { id: item.solicitacaoItemId }, data: { atendidoMil: { increment: item.qtdMil } } });
    if (c.solicitacaoId) {
      const s = await tx.erpSolicitacaoCompra.findUniqueOrThrow({ where: { id: c.solicitacaoId }, include: { itens: true } });
      if (s.status === 'APROVADA' && s.itens.every((i) => i.atendidoMil >= i.qtdMil)) await tx.erpSolicitacaoCompra.update({ where: { id: s.id }, data: { status: 'ATENDIDA' } });
    }
    await tx.erpCotacao.update({ where: { id: c.id }, data: { status: 'ENCERRADA' } });
    return out;
  });
  await auditar(req, 'cotacao.encerrar', 'erp_cotacao', c.id, null, { pedidos: pedidos.map((p) => p.numero) });
  res.json({ pedidos });
}));

// ---------------- Pedidos de compra ----------------
const pcItens = z.array(z.object({ produtoId: z.string(), qtdMil: z.number().int().min(1).max(2_000_000_000), precoUnitCents: z.number().int().min(0).max(2_000_000_000), solicitacaoItemId: z.string().nullish() })).min(1, 'Inclua ao menos um item').max(500);
const pcSchema = z.object({ parceiroId: z.string(), itens: pcItens, freteCents: z.number().int().min(0).default(0), previsaoEntrega: z.coerce.date().nullish(), condicao: z.string().trim().max(100).nullish(), observacoes: z.string().trim().max(3000).nullish(), centroCustoId: z.string().nullish() });

async function montarItens(orgId: string, itens: z.infer<typeof pcItens>) {
  await validarProdutos(orgId, itens.map((i) => i.produtoId));
  const P = await produtosDe(orgId, itens.map((i) => i.produtoId));
  return itens.map((i) => ({ produtoId: i.produtoId, descricao: P.get(i.produtoId)!.nome, qtdMil: i.qtdMil, precoUnitCents: i.precoUnitCents, totalCents: Math.round((i.qtdMil * i.precoUnitCents) / 1000), solicitacaoItemId: i.solicitacaoItemId ?? null }));
}

comprasRouter.get('/pedidos', ah(async (req, res) => {
  const orgId = orgOf(req);
  const abertos = req.query.abertos === '1';
  const l = await prisma.erpPedidoCompra.findMany({
    where: { orgId, ...(typeof req.query.parceiroId === 'string' ? { parceiroId: req.query.parceiroId } : {}), ...(abertos ? { status: { in: ['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL'] } } : typeof req.query.status === 'string' ? { status: req.query.status } : {}) },
    orderBy: { numero: 'desc' }, take: 300,
  });
  const F = await parceirosDe(orgId, l.map((p) => p.parceiroId));
  res.json(l.map((p) => ({ ...p, parceiro: F.get(p.parceiroId) })));
}));

comprasRouter.get('/pedidos/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const p = await prisma.erpPedidoCompra.findFirst({ where: { id: req.params.id, orgId }, include: { itens: true } });
  if (!p) throw notFound('Pedido de compra');
  const [P, F, cfg, nfes] = await Promise.all([produtosDe(orgId, p.itens.map((i) => i.produtoId)), parceirosDe(orgId, [p.parceiroId]), configDa(orgId), prisma.erpNfeEntrada.findMany({ where: { orgId, pedidoCompraId: p.id }, select: { id: true, numero: true, serie: true, status: true, valorTotalCents: true } })]);
  res.json({ ...p, parceiro: F.get(p.parceiroId), itens: p.itens.map((i) => ({ ...i, produto: P.get(i.produtoId) })), nfes, acoes: eventosPermitidos(maquinaCompra, p.status as StatusCompra).filter((e) => !['RECEBER', 'RECEBER_PARCIAL'].includes(e)), precisaGestor: p.totalCents > cfg.alcadaCompraCents });
}));

comprasRouter.post('/pedidos', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = pcSchema.parse(req.body);
  if (!(await prisma.erpParceiro.findFirst({ where: { id: b.parceiroId, orgId } }))) throw badRequest('Fornecedor inválido');
  const itens = await montarItens(orgId, b.itens);
  const p = await prisma.$transaction(async (tx) => tx.erpPedidoCompra.create({ data: { orgId, numero: await proximoNumero(tx, orgId, 'proximoPedidoCompra'), parceiroId: b.parceiroId, freteCents: b.freteCents, previsaoEntrega: b.previsaoEntrega ?? null, condicao: b.condicao ?? null, observacoes: b.observacoes ?? null, centroCustoId: b.centroCustoId ?? null, totalCents: itens.reduce((a, i) => a + i.totalCents, 0) + b.freteCents, itens: { create: itens } } }));
  await prisma.erpParceiro.updateMany({ where: { id: b.parceiroId, ehFornecedor: false }, data: { ehFornecedor: true } });
  await auditar(req, 'pedido_compra.criar', 'erp_pedido_compra', p.id, null, { numero: p.numero, totalCents: p.totalCents });
  res.status(201).json(p);
}));

comprasRouter.put('/pedidos/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = pcSchema.omit({ parceiroId: true }).parse(req.body);
  const antes = await prisma.erpPedidoCompra.findFirst({ where: { id: req.params.id, orgId } });
  if (!antes) throw notFound('Pedido de compra');
  if (antes.status !== 'RASCUNHO') throw badRequest('Só pedido em rascunho pode ser editado');
  const itens = await montarItens(orgId, b.itens);
  const p = await prisma.$transaction(async (tx) => {
    await tx.erpPedidoCompraItem.deleteMany({ where: { pedidoId: antes.id } });
    return tx.erpPedidoCompra.update({ where: { id: antes.id }, data: { freteCents: b.freteCents, previsaoEntrega: b.previsaoEntrega ?? null, condicao: b.condicao ?? null, observacoes: b.observacoes ?? null, totalCents: itens.reduce((a, i) => a + i.totalCents, 0) + b.freteCents, itens: { create: itens } } });
  });
  await auditar(req, 'pedido_compra.editar', 'erp_pedido_compra', p.id, { totalCents: antes.totalCents }, { totalCents: p.totalCents });
  res.json(p);
}));

/** ENVIAR já aprova sozinho quando o total está dentro da alçada; acima, espera OWNER/ADMIN. */
comprasRouter.post('/pedidos/:id/acao', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { evento, motivo } = z.object({ evento: z.enum(['ENVIAR', 'APROVAR', 'REPROVAR', 'ENVIAR_FORNECEDOR', 'CANCELAR']), motivo: z.string().trim().max(300).optional() }).parse(req.body);
  const p = await prisma.erpPedidoCompra.findFirst({ where: { id: req.params.id, orgId }, include: { itens: true } });
  if (!p) throw notFound('Pedido de compra');
  if (evento === 'CANCELAR' && p.itens.some((i) => i.recebidoMil > 0)) throw badRequest('Pedido já tem recebimento: não pode ser cancelado');
  const cfg = await configDa(orgId);
  const ctx = { itens: p.itens.length, totalCents: p.totalCents, gestor: gestorDe(req), alcadaCents: cfg.alcadaCompraCents, motivo };
  const novo = await prisma.$transaction(async (tx) => {
    let status = p.status as StatusCompra;
    const passo = async (ev: EventoCompra) => {
      const r = transicionar(maquinaCompra, status, ev, ctx);
      if (!r.ok) throw badRequest(r.erro);
      await tx.erpPedidoCompra.update({ where: { id: p.id }, data: { status: r.para, ...(ev === 'APROVAR' ? { aprovadoPorId: req.auth?.userId ?? null } : {}), ...(ev === 'REPROVAR' || ev === 'CANCELAR' ? { motivo: motivo ?? null } : {}) } });
      for (const tipo of r.emite) await emitir(tx, { orgId, tipo, agregado: 'pedido_compra', agregadoId: p.id, payload: { numero: p.numero, parceiroId: p.parceiroId, totalCents: p.totalCents } });
      status = r.para;
    };
    await passo(evento as EventoCompra);
    if (evento === 'ENVIAR' && p.totalCents <= cfg.alcadaCompraCents) await passo('APROVAR');
    return tx.erpPedidoCompra.findUniqueOrThrow({ where: { id: p.id } });
  });
  despacharEmBreve();
  await auditar(req, `pedido_compra.${evento.toLowerCase()}`, 'erp_pedido_compra', p.id, { status: p.status }, { status: novo.status });
  res.json(novo);
}));
