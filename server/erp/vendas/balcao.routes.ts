/**
 * Venda balcão (PDV): uma tela, um clique. Cria o pedido e passa por toda a máquina na mesma transação
 * (aprovar → reservar → separar/conferir → faturar → entregar), dá baixa no estoque (FEFO/FIFO),
 * gera o título a receber e já o liquida na conta escolhida. Cliente opcional: sem cadastro vai como "Consumidor final".
 */
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../db.js';
import { ah, badRequest } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { despacharEmBreve, emitir } from '../shared/events.js';
import { auditar } from '../shared/auditoria.js';
import { baixarReservas, reservarPedido } from '../estoque/servico.js';
import { titulosDoPedido, recalcularTitulo } from '../financeiro/servico.js';
import { aplicar, itemSchema, montarItens, PREFIXO_BALCAO } from './pedidos.routes.js';
import { configDa } from '../produtos/produtos.routes.js';
import { avisarPedidoErp } from './avisoPedido.js';

export const balcaoRouter = Router();
export const DOC_CONSUMIDOR = '00000000000';

const schema = z.object({
  parceiroId: z.string().nullish(), nomeCliente: z.string().trim().max(120).nullish(),
  itens: z.array(itemSchema).min(1, 'Inclua ao menos um item').max(200),
  descontoCents: z.number().int().min(0).max(2_000_000_000).default(0),
  forma: z.enum(['DINHEIRO', 'PIX', 'CARTAO']).default('DINHEIRO'), contaId: z.string().nullish(),
  depositoId: z.string().nullish(), observacoes: z.string().trim().max(1000).nullish(),
});

/** Contas para receber no balcão (cria "Caixa" se a empresa ainda não tem nenhuma). */
balcaoRouter.get('/contas', ah(async (req, res) => {
  const orgId = orgOf(req);
  let contas = await prisma.erpContaFinanceira.findMany({ where: { orgId, ativa: true }, orderBy: [{ tipo: 'asc' }, { nome: 'asc' }] });
  if (!contas.length) contas = [await prisma.erpContaFinanceira.create({ data: { orgId, nome: 'Caixa', tipo: 'CAIXA' } })];
  res.json(contas.map((c) => ({ id: c.id, nome: c.nome, tipo: c.tipo })));
}));

balcaoRouter.post('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = schema.parse(req.body);
  const userId = req.auth?.userId ?? null;
  const cliente = b.parceiroId
    ? await prisma.erpParceiro.findFirst({ where: { id: b.parceiroId, orgId } })
    : await prisma.erpParceiro.upsert({ where: { orgId_documento: { orgId, documento: DOC_CONSUMIDOR } }, update: {}, create: { orgId, documento: DOC_CONSUMIDOR, tipoPessoa: 'PF', nome: 'Consumidor final', ehCliente: true, origem: 'balcao' } });
  if (!cliente) throw badRequest('Cliente não encontrado');
  if (cliente.status === 'BLOQUEADO') throw badRequest('Cliente bloqueado');
  const conta = b.contaId
    ? await prisma.erpContaFinanceira.findFirst({ where: { id: b.contaId, orgId, ativa: true } })
    : await prisma.erpContaFinanceira.findFirst({ where: { orgId, ativa: true }, orderBy: [{ tipo: 'asc' }] }) ?? await prisma.erpContaFinanceira.create({ data: { orgId, nome: 'Caixa', tipo: 'CAIXA' } });
  if (!conta) throw badRequest('Conta para receber inválida');
  const cfg = await configDa(orgId);

  const pedido = await prisma.$transaction(async (tx) => {
    const { itens, tot, maxItemBp } = await montarItens(tx, orgId, { itens: b.itens, tabelaPrecoId: null, descontoCents: b.descontoCents, freteCents: 0 });
    if (tot.totalCents <= 0) throw badRequest('Venda com total zero');
    const descBp = tot.subtotalCents > 0 ? Math.round((tot.descontoCents / tot.subtotalCents) * 10_000) : 0;
    const gestor = req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';
    if (!gestor && cfg.descontoMaxBp > 0 && Math.max(descBp, maxItemBp) > cfg.descontoMaxBp) throw badRequest(`Desconto acima do permitido (${cfg.descontoMaxBp / 100}%): peça a um administrador`);
    const c = await tx.erpConfig.update({ where: { orgId }, data: { proximoPedido: { increment: 1 } } });
    const numero = c.proximoPedido - 1;
    const correlationId = randomUUID();
    const obs = [b.nomeCliente && !b.parceiroId ? `Cliente: ${b.nomeCliente}` : null, b.observacoes, `Venda balcão · ${b.forma}`].filter(Boolean).join('\n');
    let p = await tx.erpPedidoVenda.create({
      data: { orgId, numero, parceiroId: cliente.id, vendedorId: userId, depositoId: b.depositoId ?? null, observacoes: obs, subtotalCents: tot.subtotalCents, descontoCents: tot.descontoCents, freteCents: 0, totalCents: tot.totalCents, descontoMaxItemBp: maxItemBp, validadeOrcamento: new Date(), correlationId, itens: { create: itens } },
      include: { itens: true },
    });
    await emitir(tx, { orgId, tipo: 'vendas.pedido.criado', agregado: 'pedido_venda', agregadoId: p.id, correlationId, payload: { numero, parceiroId: cliente.id, totalCents: p.totalCents } });
    p = await aplicar(tx, p, 'ENVIAR', {});
    p = await aplicar(tx, p, 'APROVAR', {}, { aprovadoEm: new Date(), aprovadoPorId: userId });
    const faltas = await reservarPedido(tx, orgId, p.id, b.depositoId ?? null);
    if (faltas.length) {
      const nomes = new Map(itens.map((i) => [i.produtoId, i.descricao]));
      throw badRequest(`Sem estoque disponível: ${faltas.map((f) => `${nomes.get(f.produtoId) ?? f.produtoId} (faltam ${f.faltaMil / 1000})`).join(', ')}`);
    }
    p = await tx.erpPedidoVenda.findUniqueOrThrow({ where: { id: p.id }, include: { itens: true } });
    p = await aplicar(tx, p, 'RESERVAR', {});
    p = await aplicar(tx, p, 'SEPARAR', {});
    // Balcão: o cliente leva na mão, a separação é a própria venda.
    const ids = p.itens.map((i) => i.id);
    const reservas = await tx.erpReserva.findMany({ where: { pedidoItemId: { in: ids }, status: 'ATIVA' } });
    for (const r of reservas) await tx.erpReserva.update({ where: { id: r.id }, data: { separadoMil: r.qtdMil } });
    for (const i of p.itens) await tx.erpPedidoItem.update({ where: { id: i.id }, data: { separadoMil: i.qtdMil } });
    p = await tx.erpPedidoVenda.findUniqueOrThrow({ where: { id: p.id }, include: { itens: true } });
    p = await aplicar(tx, p, 'CONFERIR', { tudoSeparado: true });
    const nf = `${PREFIXO_BALCAO}${numero}`;
    p = await aplicar(tx, p, 'FATURAR', { nfNumero: nf }, { nfNumero: nf });
    await baixarReservas(tx, { orgId, pedidoId: p.id, motivo: `Venda balcão ${numero}`, userId: userId ?? undefined, correlationId });
    p = await aplicar(tx, p, 'ENTREGAR', {}, { entregueEm: new Date() });
    await titulosDoPedido(tx, orgId, p.id);
    const titulos = await tx.erpTitulo.findMany({ where: { orgId, docTipo: 'pedido_venda', docId: p.id } });
    for (const t of titulos) {
      const bx = await tx.erpBaixa.create({ data: { tituloId: t.id, contaId: conta.id, data: new Date(), valorCents: t.valorCents, jurosCents: 0, descontoCents: 0, forma: b.forma, userId } });
      await tx.erpLancamento.create({ data: { orgId, contaId: conta.id, data: new Date(), valorCents: t.valorCents, descricao: t.descricao, origemTipo: 'baixa', origemId: bx.id, categoriaId: t.categoriaId } });
      await recalcularTitulo(tx, t.id);
    }
    return tx.erpPedidoVenda.findUniqueOrThrow({ where: { id: p.id }, include: { itens: true } });
  });
  despacharEmBreve();
  await auditar(req, 'pedido.balcao', 'erp_pedido_venda', pedido.id, null, { numero: pedido.numero, totalCents: pedido.totalCents, forma: b.forma });
  avisarPedidoErp(pedido, { balcao: true });
  res.status(201).json(pedido);
}));
