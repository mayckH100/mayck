/**
 * Vendas/OMS: orçamento → pedido, aprovação por alçada e crédito, reserva automática (FEFO/FIFO),
 * separação com conferência por QR, faturamento, expedição e entrega. Toda mudança de status passa pela máquina.
 */
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { ah, badRequest, forbidden, notFound } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { transicionar, eventosPermitidos } from '../shared/statemachine.js';
import { emitir, despacharEmBreve } from '../shared/events.js';
import { vincular } from '../shared/trace.js';
import { auditar } from '../shared/auditoria.js';
import { maquinaPedido, financeiroApos, COM_RESERVA, type StatusPedido, type EventoPedido, type CtxPedido } from './pedido.machine.js';
import { totalizar, totalItem, motivosBloqueio, precoPorVolume } from './calculo.js';
import { reservarPedido, liberarReservas, baixarReservas, conferir, LOTE_UNICO } from '../estoque/servico.js';
import { configDa } from '../produtos/produtos.routes.js';
import { avisarPedidoErp } from './avisoPedido.js';

type Tx = Prisma.TransactionClient;
export const pedidosRouter = Router();

/** Venda balcão (PDV) sai faturada com a "nota" BALCAO-<nº>: é assim que a lista separa balcão de pedido. */
export const PREFIXO_BALCAO = 'BALCAO-';
export const ehBalcao = (p: { nfNumero?: string | null }) => !!p.nfNumero?.startsWith(PREFIXO_BALCAO);

export const itemSchema = z.object({ produtoId: z.string(), qtdMil: z.number().int().min(1).max(2_000_000_000), precoUnitCents: z.number().int().min(0).max(2_000_000_000).optional(), descontoBp: z.number().int().min(0).max(10_000).default(0) });
const pedidoSchema = z.object({
  parceiroId: z.string(), oportunidadeId: z.string().nullish(), tabelaPrecoId: z.string().nullish(), condicaoPagamentoId: z.string().nullish(),
  depositoId: z.string().nullish(), filialId: z.string().nullish(), centroCustoId: z.string().nullish(),
  descontoCents: z.number().int().min(0).max(2_000_000_000).default(0), freteCents: z.number().int().min(0).max(2_000_000_000).default(0),
  previsaoEntrega: z.coerce.date().nullish(), observacoes: z.string().trim().max(5000).nullish(),
  itens: z.array(itemSchema).min(1, 'Inclua ao menos um item').max(500),
});

/** Monta os itens com preço da tabela (faixa de volume) quando o preço não veio, e totaliza. */
export async function montarItens(tx: Tx, orgId: string, b: Pick<z.infer<typeof pedidoSchema>, 'itens' | 'tabelaPrecoId' | 'descontoCents' | 'freteCents'>) {
  const ids = [...new Set(b.itens.map((i) => i.produtoId))];
  const produtos = await tx.erpProduto.findMany({ where: { orgId, id: { in: ids }, ativo: true } });
  if (produtos.length !== ids.length) throw badRequest('Produto inválido ou inativo no pedido');
  const P = new Map(produtos.map((p) => [p.id, p]));
  const faixas = b.tabelaPrecoId ? await tx.erpTabelaPrecoItem.findMany({ where: { tabelaId: b.tabelaPrecoId, tabela: { orgId, ativa: true } } }) : [];
  const itens = b.itens.map((i, posicao) => {
    const p = P.get(i.produtoId)!;
    const preco = i.precoUnitCents ?? precoPorVolume(faixas.filter((f) => f.produtoId === p.id), i.qtdMil, p.precoBaseCents);
    return { produtoId: p.id, descricao: `${p.sku} · ${p.nome}`, qtdMil: i.qtdMil, precoUnitCents: preco, descontoBp: i.descontoBp, totalCents: totalItem({ qtdMil: i.qtdMil, precoUnitCents: preco, descontoBp: i.descontoBp }), posicao };
  });
  return { itens, tot: totalizar(itens, b.descontoCents, b.freteCents), maxItemBp: Math.max(0, ...itens.map((i) => i.descontoBp)) };
}

pedidosRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const f = z.object({ status: z.string().optional(), origem: z.enum(['balcao', 'pedido']).optional().catch(undefined), parceiroId: z.string().optional(), q: z.string().max(60).optional() }).parse(req.query);
  const num = f.q && /^\d+$/.test(f.q) ? Number(f.q) : null;
  const origem = f.origem === 'balcao' ? { nfNumero: { startsWith: PREFIXO_BALCAO } } : f.origem === 'pedido' ? { OR: [{ nfNumero: null }, { NOT: { nfNumero: { startsWith: PREFIXO_BALCAO } } }] } : {};
  const items = await prisma.erpPedidoVenda.findMany({
    where: { orgId, ...(f.status ? { statusOperacional: { in: f.status.split(',') } } : {}), ...origem, ...(f.parceiroId ? { parceiroId: f.parceiroId } : {}), ...(num ? { numero: num } : {}) },
    orderBy: { numero: 'desc' }, take: 300,
  });
  const parceiros = await prisma.erpParceiro.findMany({ where: { id: { in: [...new Set(items.map((i) => i.parceiroId))] } }, select: { id: true, nome: true, fantasia: true } });
  const M = new Map(parceiros.map((p) => [p.id, p]));
  res.json(items.map((i) => ({ ...i, parceiro: M.get(i.parceiroId), balcao: ehBalcao(i) })));
}));

pedidosRouter.get('/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const p = await prisma.erpPedidoVenda.findFirst({ where: { id: req.params.id, orgId }, include: { itens: { orderBy: { posicao: 'asc' } } } });
  if (!p) throw notFound('Pedido');
  const [parceiro, reservas] = await Promise.all([
    prisma.erpParceiro.findUnique({ where: { id: p.parceiroId }, select: { id: true, nome: true, fantasia: true, documento: true, limiteCreditoCents: true, status: true } }),
    prisma.erpReserva.findMany({ where: { pedidoItemId: { in: p.itens.map((i) => i.id) }, status: { in: ['ATIVA', 'BAIXADA'] } } }),
  ]);
  const [lotes, ends] = await Promise.all([
    prisma.erpLote.findMany({ where: { id: { in: reservas.map((r) => r.loteId) } } }),
    prisma.erpEnderecoEstoque.findMany({ where: { id: { in: reservas.map((r) => r.enderecoId) } }, select: { id: true, codigo: true } }),
  ]);
  const L = new Map(lotes.map((l) => [l.id, l])); const E = new Map(ends.map((e) => [e.id, e.codigo]));
  // Lista de separação: ordenada por endereço para o operador andar uma vez só pelo depósito.
  const separacao = reservas.map((r) => ({ reservaId: r.id, itemId: r.pedidoItemId, endereco: E.get(r.enderecoId), lote: L.get(r.loteId)?.numero === LOTE_UNICO ? null : L.get(r.loteId)?.numero, validade: L.get(r.loteId)?.validade, qtdMil: r.qtdMil, separadoMil: r.separadoMil, status: r.status, descricao: p.itens.find((i) => i.id === r.pedidoItemId)?.descricao }))
    .sort((a, b) => (a.endereco ?? '').localeCompare(b.endereco ?? ''));
  res.json({ ...p, parceiro, separacao, acoes: eventosPermitidos(maquinaPedido, p.statusOperacional as StatusPedido) });
}));

pedidosRouter.post('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = pedidoSchema.parse(req.body);
  const parceiro = await prisma.erpParceiro.findFirst({ where: { id: b.parceiroId, orgId, ehCliente: true } });
  if (!parceiro) throw notFound('Cliente');
  const op = b.oportunidadeId ? await prisma.erpOportunidade.findFirst({ where: { id: b.oportunidadeId, orgId, parceiroId: parceiro.id } }) : null;
  if (b.oportunidadeId && !op) throw badRequest('Oportunidade não pertence a este cliente');
  const cfg = await configDa(orgId);
  const pedido = await prisma.$transaction(async (tx) => {
    const { itens, tot, maxItemBp } = await montarItens(tx, orgId, b);
    const { proximoPedido: numero } = await tx.erpConfig.update({ where: { orgId }, data: { proximoPedido: { increment: 1 } } }).then((c) => ({ proximoPedido: c.proximoPedido - 1 }));
    const correlationId = op?.correlationId ?? randomUUID(); // herda o rastreio da oportunidade
    const p = await tx.erpPedidoVenda.create({
      data: {
        orgId, numero, parceiroId: parceiro.id, oportunidadeId: op?.id ?? null, vendedorId: req.auth?.userId ?? null,
        tabelaPrecoId: b.tabelaPrecoId ?? null, condicaoPagamentoId: b.condicaoPagamentoId ?? null, depositoId: b.depositoId ?? null,
        filialId: b.filialId ?? parceiro.filialId ?? null, centroCustoId: b.centroCustoId ?? null, previsaoEntrega: b.previsaoEntrega ?? null, observacoes: b.observacoes ?? null,
        subtotalCents: tot.subtotalCents, descontoCents: tot.descontoCents, freteCents: b.freteCents, totalCents: tot.totalCents, descontoMaxItemBp: maxItemBp,
        validadeOrcamento: new Date(Date.now() + cfg.validadeOrcamentoDias * 86_400_000), correlationId, itens: { create: itens },
      },
    });
    if (op) await vincular(tx, orgId, { tipo: 'oportunidade', id: op.id }, { tipo: 'pedido_venda', id: p.id }, 'converteu');
    await vincular(tx, orgId, { tipo: 'parceiro', id: parceiro.id }, { tipo: 'pedido_venda', id: p.id }, 'comprou');
    await emitir(tx, { orgId, tipo: 'vendas.pedido.criado', agregado: 'pedido_venda', agregadoId: p.id, correlationId, payload: { numero, parceiroId: parceiro.id, totalCents: p.totalCents } });
    return p;
  });
  despacharEmBreve();
  await auditar(req, 'pedido.criar', 'erp_pedido_venda', pedido.id, null, { numero: pedido.numero, totalCents: pedido.totalCents });
  avisarPedidoErp(pedido);
  res.status(201).json(pedido);
}));

/** Edita o orçamento (só em RASCUNHO). */
pedidosRouter.put('/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const antes = await prisma.erpPedidoVenda.findFirst({ where: { id: req.params.id, orgId } });
  if (!antes) throw notFound('Pedido');
  if (antes.statusOperacional !== 'RASCUNHO') throw badRequest('Só dá para editar o pedido em rascunho. Reprove-o para voltar a rascunho.');
  const b = pedidoSchema.parse({ ...req.body, parceiroId: antes.parceiroId });
  const p = await prisma.$transaction(async (tx) => {
    const { itens, tot, maxItemBp } = await montarItens(tx, orgId, b);
    await tx.erpPedidoItem.deleteMany({ where: { pedidoId: antes.id } });
    return tx.erpPedidoVenda.update({
      where: { id: antes.id },
      data: { tabelaPrecoId: b.tabelaPrecoId ?? null, condicaoPagamentoId: b.condicaoPagamentoId ?? null, depositoId: b.depositoId ?? null, previsaoEntrega: b.previsaoEntrega ?? null, observacoes: b.observacoes ?? null, subtotalCents: tot.subtotalCents, descontoCents: tot.descontoCents, freteCents: b.freteCents, totalCents: tot.totalCents, descontoMaxItemBp: maxItemBp, itens: { create: itens } },
    });
  });
  await auditar(req, 'pedido.editar', 'erp_pedido_venda', p.id, { totalCents: antes.totalCents }, { totalCents: p.totalCents });
  res.json(p);
}));

type Pedido = Prisma.ErpPedidoVendaGetPayload<{ include: { itens: true } }>;

/** Aplica uma transição: valida na máquina, grava status (operacional + financeiro) e emite os eventos. */
export async function aplicar(tx: Tx, p: Pedido, evento: EventoPedido, ctx: Partial<CtxPedido>, extra: Prisma.ErpPedidoVendaUpdateInput = {}) {
  const r = transicionar(maquinaPedido, p.statusOperacional as StatusPedido, evento, { itens: p.itens.length, totalCents: p.totalCents, ...ctx });
  if (!r.ok) throw badRequest(r.erro);
  const novo = await tx.erpPedidoVenda.update({ where: { id: p.id }, data: { statusOperacional: r.para, statusFinanceiro: financeiroApos(r.para, p.statusFinanceiro), ...extra }, include: { itens: true } });
  for (const tipo of r.emite) await emitir(tx, { orgId: p.orgId, tipo, agregado: 'pedido_venda', agregadoId: p.id, correlationId: p.correlationId, payload: { numero: p.numero, parceiroId: p.parceiroId, totalCents: p.totalCents, de: r.de, para: r.para, motivo: ctx.motivo ?? null } });
  return novo;
}

/** Depois de aprovado: tenta reservar tudo; o que faltar deixa o pedido aguardando suprimento (gera necessidade para Compras/MRP). */
export async function reservarOuAguardar(tx: Tx, p: Pedido) {
  const faltas = await reservarPedido(tx, p.orgId, p.id, p.depositoId);
  const atual = await tx.erpPedidoVenda.findUniqueOrThrow({ where: { id: p.id }, include: { itens: true } });
  if (!faltas.length) return aplicar(tx, atual, 'RESERVAR', {});
  if (atual.statusOperacional === 'AGUARDANDO_SUPRIMENTO') {
    await emitir(tx, { orgId: p.orgId, tipo: 'estoque.necessidade', agregado: 'pedido_venda', agregadoId: p.id, correlationId: p.correlationId, payload: { numero: p.numero, faltas } });
    return atual;
  }
  const r = transicionar(maquinaPedido, atual.statusOperacional as StatusPedido, 'FALTAR', { itens: atual.itens.length, totalCents: atual.totalCents });
  if (!r.ok) throw badRequest(r.erro);
  const novo = await tx.erpPedidoVenda.update({ where: { id: p.id }, data: { statusOperacional: r.para }, include: { itens: true } });
  await emitir(tx, { orgId: p.orgId, tipo: 'estoque.necessidade', agregado: 'pedido_venda', agregadoId: p.id, correlationId: p.correlationId, payload: { numero: p.numero, parceiroId: p.parceiroId, faltas } });
  return novo;
}

const acaoSchema = z.object({
  evento: z.enum(['ENVIAR', 'APROVAR', 'REPROVAR', 'RESERVAR', 'SEPARAR', 'CONFERIR', 'FATURAR', 'EXPEDIR', 'ENTREGAR', 'ENTREGAR_PARCIAL', 'DEVOLVER', 'CANCELAR']),
  motivo: z.string().trim().max(300).optional(), nfNumero: z.string().trim().max(20).optional(),
  transportadora: z.string().trim().max(100).optional(), rastreio: z.string().trim().max(60).optional(),
});

pedidosRouter.post('/:id/acao', ah(async (req, res) => {
  const orgId = orgOf(req);
  const a = acaoSchema.parse(req.body);
  const gestor = req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';
  const p = await prisma.erpPedidoVenda.findFirst({ where: { id: req.params.id, orgId }, include: { itens: true } });
  if (!p) throw notFound('Pedido');
  const antes = p.statusOperacional;

  const final = await prisma.$transaction(async (tx) => {
    switch (a.evento) {
      case 'ENVIAR': {
        let x = await aplicar(tx, p, 'ENVIAR', {});
        const [cfg, cliente, aberto] = await Promise.all([
          configDa(orgId, tx),
          tx.erpParceiro.findUniqueOrThrow({ where: { id: p.parceiroId } }),
          tx.erpPedidoVenda.aggregate({ where: { orgId, parceiroId: p.parceiroId, id: { not: p.id }, statusFinanceiro: { in: ['PROVISIONADO', 'EM_ABERTO', 'PARCIAL', 'VENCIDO', 'INADIMPLENTE'] } }, _sum: { totalCents: true } }),
        ]);
        const descontoEfetivoBp = p.subtotalCents > 0 ? Math.round((p.descontoCents / p.subtotalCents) * 10_000) : 0;
        const motivos = motivosBloqueio({ descontoEfetivoBp, totalCents: p.totalCents }, cfg, { status: cliente.status, limiteCreditoCents: cliente.limiteCreditoCents, emAbertoCents: aberto._sum.totalCents ?? 0 });
        if (motivos.length) return aplicar(tx, x, 'BLOQUEAR', { motivo: motivos.join('; ') }, { motivoBloqueio: motivos.join('; ') });
        x = await aplicar(tx, x, 'APROVAR', {}, { aprovadoEm: new Date(), motivoBloqueio: null });
        return reservarOuAguardar(tx, x);
      }
      case 'APROVAR': {
        if (!gestor) throw forbidden('Só proprietário ou administrador aprova pedido bloqueado');
        const x = await aplicar(tx, p, 'APROVAR', {}, { aprovadoEm: new Date(), aprovadoPorId: req.auth?.userId ?? null });
        return reservarOuAguardar(tx, x);
      }
      case 'REPROVAR': return aplicar(tx, p, 'REPROVAR', { motivo: a.motivo }, { motivoBloqueio: a.motivo });
      case 'RESERVAR': return reservarOuAguardar(tx, p);
      case 'SEPARAR': return aplicar(tx, p, 'SEPARAR', {});
      case 'CONFERIR': {
        const servicos = new Set((await tx.erpProduto.findMany({ where: { id: { in: p.itens.map((i) => i.produtoId) }, tipo: 'SERVICO' }, select: { id: true } })).map((x) => x.id));
        return aplicar(tx, p, 'CONFERIR', { tudoSeparado: p.itens.every((i) => servicos.has(i.produtoId) || i.separadoMil >= i.qtdMil) });
      }
      case 'FATURAR': {
        const x = await aplicar(tx, p, 'FATURAR', { nfNumero: a.nfNumero }, { nfNumero: a.nfNumero });
        await baixarReservas(tx, { orgId, pedidoId: p.id, motivo: `Pedido ${p.numero} · NF ${a.nfNumero}`, userId: req.auth?.userId, correlationId: p.correlationId });
        return x;
      }
      case 'EXPEDIR': return aplicar(tx, p, 'EXPEDIR', {}, { transportadora: a.transportadora ?? null, rastreio: a.rastreio ?? null });
      case 'ENTREGAR': return aplicar(tx, p, 'ENTREGAR', {}, { entregueEm: new Date() });
      case 'ENTREGAR_PARCIAL': return aplicar(tx, p, 'ENTREGAR_PARCIAL', { motivo: a.motivo }, { observacoes: [p.observacoes, `Entrega parcial: ${a.motivo}`].filter(Boolean).join('\n') });
      case 'DEVOLVER': return aplicar(tx, p, 'DEVOLVER', { motivo: a.motivo }, { motivoCancelamento: a.motivo });
      case 'CANCELAR': {
        const x = await aplicar(tx, p, 'CANCELAR', { motivo: a.motivo }, { motivoCancelamento: a.motivo });
        if (COM_RESERVA.includes(antes as StatusPedido) || p.itens.some((i) => i.reservadoMil > 0)) await liberarReservas(tx, p.id);
        return x;
      }
    }
  });
  despacharEmBreve();
  await auditar(req, `pedido.${a.evento.toLowerCase()}`, 'erp_pedido_venda', p.id, { status: antes }, { status: final.statusOperacional, motivo: a.motivo ?? final.motivoBloqueio ?? null });
  res.json({ ...final, acoes: eventosPermitidos(maquinaPedido, final.statusOperacional as StatusPedido) });
}));

/** Conferência por leitura de QR/código de barras durante a separação. */
pedidosRouter.post('/:id/conferencia', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ codigo: z.string().trim().min(1).max(60), qtdMil: z.number().int().min(1).max(2_000_000_000) }).parse(req.body);
  const p = await prisma.erpPedidoVenda.findFirst({ where: { id: req.params.id, orgId } });
  if (!p) throw notFound('Pedido');
  if (p.statusOperacional !== 'EM_SEPARACAO') throw badRequest('Libere a separação antes de conferir');
  res.json(await prisma.$transaction((tx) => conferir(tx, orgId, p.id, b.codigo, b.qtdMil)));
}));
