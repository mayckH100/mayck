/**
 * Venda balcão (PDV): uma tela, um clique. Cria o pedido e passa por toda a máquina na mesma transação
 * (aprovar → reservar → separar/conferir → faturar → entregar), dá baixa no estoque (FEFO/FIFO),
 * gera o título a receber e já o liquida na conta escolhida. Cliente opcional: sem cadastro vai como "Consumidor final".
 * Exige caixa aberto (409 "Abra o caixa antes de vender"): a venda e o recebimento ficam ligados à sessão do caixa,
 * e o dinheiro entra na conta do caixa aberto (Pix/cartão seguem a conta escolhida).
 */
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { ah, badRequest, notFound } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { despacharEmBreve, emitir } from '../shared/events.js';
import { auditar } from '../shared/auditoria.js';
import { baixarReservas, reservarPedido, saldosParaSaida } from '../estoque/servico.js';
import { resolverCodigo } from '../estoque/leitura.js';
import { disponivel, planejarAlocacao } from '../estoque/saldo.js';
import { classificarLeitura } from '../leitura/codigo.js';
import { titulosDoPedido, recalcularTitulo } from '../financeiro/servico.js';
import { aplicar, itemSchema, montarItens, PREFIXO_BALCAO } from './pedidos.routes.js';
import { configDa } from '../produtos/produtos.routes.js';
import { avisarPedidoErp } from './avisoPedido.js';
import { sessaoParaVenda, travarSessaoParaVenda } from './caixa.routes.js';

export const balcaoRouter = Router();
export const DOC_CONSUMIDOR = '00000000000';

const schema = z.object({
  parceiroId: z.string().nullish(), nomeCliente: z.string().trim().max(120).nullish(),
  itens: z.array(itemSchema).min(1, 'Inclua ao menos um item').max(200),
  descontoCents: z.number().int().min(0).max(2_000_000_000).default(0),
  forma: z.enum(['DINHEIRO', 'PIX', 'CARTAO']).default('DINHEIRO'), contaId: z.string().nullish(),
  depositoId: z.string().nullish(), observacoes: z.string().trim().max(1000).nullish(),
  caixaSessaoId: z.string().nullish(),
});

/** Contas para receber no balcão (cria "Caixa" se a empresa ainda não tem nenhuma). */
balcaoRouter.get('/contas', ah(async (req, res) => {
  const orgId = orgOf(req);
  let contas = await prisma.erpContaFinanceira.findMany({ where: { orgId, ativa: true }, orderBy: [{ tipo: 'asc' }, { nome: 'asc' }] });
  if (!contas.length) contas = [await prisma.erpContaFinanceira.create({ data: { orgId, nome: 'Caixa', tipo: 'CAIXA' } })];
  res.json(contas.map((c) => ({ id: c.id, nome: c.nome, tipo: c.tipo })));
}));

/**
 * v1.34.0 — leitura no balcão: código de barras do produto, etiqueta do lote (GS1-128 ou QR), código ou lote digitado.
 * Devolve o produto com preço e saldo e, quando a etiqueta traz o lote, o lote (a baixa sai dele). Sem lote na leitura,
 * mostra qual lote sairia pela regra do produto (FEFO: vence primeiro; FIFO: mais antigo) — só informativo.
 */
balcaoRouter.get('/ler', ah(async (req, res) => {
  const orgId = orgOf(req);
  const codigo = typeof req.query.codigo === 'string' ? req.query.codigo.slice(0, 300) : '';
  if (!codigo.trim()) throw badRequest('Leia ou digite um código');
  const c = classificarLeitura(codigo);
  if (c.tipo === 'pedido' || c.tipo === 'chave_nfe') throw badRequest(c.tipo === 'pedido' ? `Este código é do pedido nº ${c.numero}, não de um produto. Use "Localizar pedido".` : 'Este código é a chave de uma nota fiscal, não de um produto. Use "Localizar pedido".');
  const r = await resolverCodigo(prisma, orgId, codigo);
  if (!r) throw notFound(`Produto para o código ${codigo.trim().slice(0, 40)}`);
  const p = r.produto;
  if (!p.ativo) throw badRequest(`O produto ${p.nome} está inativo`);
  const saldos = p.tipo === 'SERVICO' ? [] : await saldosParaSaida(prisma, orgId, p.id);
  const disp = saldos.filter((s) => s.lote.status === 'LIBERADO').reduce((a, s) => a + disponivel(s), 0);
  const hoje = new Date();
  let lote = null as null | { id: string; numero: string; validade: Date | null; disponivelMil: number; status: string; vencido: boolean };
  let aviso: string | null = null;
  if (r.lote) {
    const doLote = saldos.filter((s) => s.loteId === r.lote!.id);
    const vencido = !!(r.lote.validade && r.lote.validade.getTime() < hoje.getTime());
    lote = { id: r.lote.id, numero: r.lote.numero, validade: r.lote.validade, status: r.lote.status, vencido, disponivelMil: r.lote.status === 'LIBERADO' && !vencido ? doLote.reduce((a, s) => a + disponivel(s), 0) : 0 };
    if (vencido) aviso = `Lote ${r.lote.numero} VENCIDO: não pode ser vendido. Separe o produto.`;
    else if (r.lote.status !== 'LIBERADO') aviso = `Lote ${r.lote.numero} ${r.lote.status === 'QUARENTENA' ? 'em quarentena' : 'bloqueado'}: não pode ser vendido.`;
    else if (lote.disponivelMil <= 0) aviso = `Lote ${r.lote.numero} sem saldo no sistema. Confira a etiqueta ou dê entrada no estoque.`;
  }
  const plano = !r.lote && p.tipo !== 'SERVICO' ? planejarAlocacao(saldos, 1000, p.regraSaida, hoje) : null;
  const sug = plano?.alocacoes[0] ? saldos.find((s) => s.id === plano.alocacoes[0].saldoId) : null;
  if (!r.lote && p.tipo !== 'SERVICO' && disp <= 0) aviso = `${p.nome} sem estoque disponível no sistema.`;
  res.json({
    tipo: r.tipo,
    produto: { id: p.id, sku: p.sku, nome: p.nome, unidade: p.unidade, tipo: p.tipo, precoBaseCents: p.precoBaseCents, codigoBarras: p.codigoBarras, regraSaida: p.regraSaida, controlaLote: p.controlaLote, saldo: { disponivelMil: disp } },
    lote, sugestao: sug ? { loteId: sug.loteId, numero: sug.lote.numero, validade: sug.lote.validade, regra: p.regraSaida } : null, aviso,
  });
}));

export type VendaBalcaoInput = z.infer<typeof schema>;
export const vendaBalcaoSchema = schema;
type Ctx = { orgId: string; userId: string | null; gestor: boolean };

/** Fora da transação: cliente (ou consumidor final), sessão do caixa, conta que recebe e configuração. */
export async function prepararVendaBalcao(ctx: Ctx, b: VendaBalcaoInput) {
  const { orgId, userId } = ctx;
  const cliente = b.parceiroId
    ? await prisma.erpParceiro.findFirst({ where: { id: b.parceiroId, orgId } })
    : await prisma.erpParceiro.upsert({ where: { orgId_documento: { orgId, documento: DOC_CONSUMIDOR } }, update: {}, create: { orgId, documento: DOC_CONSUMIDOR, tipoPessoa: 'PF', nome: 'Consumidor final', ehCliente: true, origem: 'balcao' } });
  if (!cliente) throw badRequest('Cliente não encontrado');
  if (cliente.status === 'BLOQUEADO') throw badRequest('Cliente bloqueado');
  const sessao = await sessaoParaVenda(orgId, userId, b.caixaSessaoId);
  // Dinheiro vai para a gaveta: conta do caixa aberto. Pix/cartão: conta escolhida (ou a padrão, como antes).
  const conta = b.forma === 'DINHEIRO'
    ? await prisma.erpContaFinanceira.findFirst({ where: { id: sessao.contaFinanceiraId, orgId } })
    : b.contaId
    ? await prisma.erpContaFinanceira.findFirst({ where: { id: b.contaId, orgId, ativa: true } })
    : await prisma.erpContaFinanceira.findFirst({ where: { orgId, ativa: true }, orderBy: [{ tipo: 'asc' }] }) ?? await prisma.erpContaFinanceira.create({ data: { orgId, nome: 'Caixa', tipo: 'CAIXA' } });
  if (!conta) throw badRequest('Conta para receber inválida');
  const cfg = await configDa(orgId);
  return { cliente, sessao, conta, cfg };
}
type Preparo = Awaited<ReturnType<typeof prepararVendaBalcao>>;

/**
 * Dentro da transação: cria o pedido e passa por toda a máquina (aprovar → reservar → separar/conferir → faturar →
 * entregar), baixa o estoque, gera o título e o liquida na conta. `obsExtra` entra nas observações (ex.: maquininha).
 */
export async function executarVendaBalcao(tx: Prisma.TransactionClient, ctx: Ctx, b: VendaBalcaoInput, prep: Preparo, obsExtra?: string | null) {
  const { orgId, userId } = ctx;
  const { cliente, sessao, conta, cfg } = prep;
  await travarSessaoParaVenda(tx, sessao.id);
  const { itens, tot, maxItemBp } = await montarItens(tx, orgId, { itens: b.itens, tabelaPrecoId: null, descontoCents: b.descontoCents, freteCents: 0 });
  if (tot.totalCents <= 0) throw badRequest('Venda com total zero');
  const descBp = tot.subtotalCents > 0 ? Math.round((tot.descontoCents / tot.subtotalCents) * 10_000) : 0;
  if (!ctx.gestor && cfg.descontoMaxBp > 0 && Math.max(descBp, maxItemBp) > cfg.descontoMaxBp) throw badRequest(`Desconto acima do permitido (${cfg.descontoMaxBp / 100}%): peça a um administrador`);
  const c = await tx.erpConfig.update({ where: { orgId }, data: { proximoPedido: { increment: 1 } } });
  const numero = c.proximoPedido - 1;
  const correlationId = randomUUID();
  const obs = [b.nomeCliente && !b.parceiroId ? `Cliente: ${b.nomeCliente}` : null, b.observacoes, `Venda balcão · ${b.forma}`, obsExtra].filter(Boolean).join('\n');
  let p = await tx.erpPedidoVenda.create({
    data: { orgId, numero, parceiroId: cliente.id, vendedorId: userId, depositoId: b.depositoId ?? null, observacoes: obs, subtotalCents: tot.subtotalCents, descontoCents: tot.descontoCents, freteCents: 0, totalCents: tot.totalCents, descontoMaxItemBp: maxItemBp, validadeOrcamento: new Date(), correlationId, caixaSessaoId: sessao.id, itens: { create: itens } },
    include: { itens: true },
  });
  await emitir(tx, { orgId, tipo: 'vendas.pedido.criado', agregado: 'pedido_venda', agregadoId: p.id, correlationId, payload: { numero, parceiroId: cliente.id, totalCents: p.totalCents } });
  p = await aplicar(tx, p, 'ENVIAR', {});
  p = await aplicar(tx, p, 'APROVAR', {}, { aprovadoEm: new Date(), aprovadoPorId: userId });
  const faltas = await reservarPedido(tx, orgId, p.id, b.depositoId ?? null);
  if (faltas.length) {
    const nomes = new Map(itens.map((i) => [i.produtoId, i.descricao]));
    const lotes = new Map((await tx.erpLote.findMany({ where: { id: { in: faltas.map((f) => f.loteId).filter(Boolean) as string[] } }, select: { id: true, numero: true } })).map((l) => [l.id, l.numero]));
    throw badRequest(`Sem estoque disponível: ${faltas.map((f) => `${nomes.get(f.produtoId) ?? f.produtoId}${f.loteId ? ` no lote ${lotes.get(f.loteId) ?? ''} lido (lote vencido, bloqueado ou sem saldo)` : ''} (faltam ${f.faltaMil / 1000})`).join(', ')}`);
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
    const bx = await tx.erpBaixa.create({ data: { tituloId: t.id, contaId: conta.id, data: new Date(), valorCents: t.valorCents, jurosCents: 0, descontoCents: 0, forma: b.forma, userId, caixaSessaoId: sessao.id } });
    await tx.erpLancamento.create({ data: { orgId, contaId: conta.id, data: new Date(), valorCents: t.valorCents, descricao: t.descricao, origemTipo: 'baixa', origemId: bx.id, categoriaId: t.categoriaId } });
    await recalcularTitulo(tx, t.id);
  }
  return tx.erpPedidoVenda.findUniqueOrThrow({ where: { id: p.id }, include: { itens: true } });
}

class Simulacao extends Error { constructor(public totalCents: number) { super('simulação'); } }
/**
 * Ensaio da venda: roda tudo (estoque, desconto, caixa aberto) numa transação desfeita no fim, sem gravar nada.
 * Usado antes de mandar a cobrança para a maquininha, para não cobrar o cliente por uma venda que não fecharia.
 */
export async function simularVendaBalcao(ctx: Ctx, b: VendaBalcaoInput, prep: Preparo): Promise<{ totalCents: number }> {
  try {
    await prisma.$transaction(async (tx) => { const p = await executarVendaBalcao(tx, ctx, b, prep); throw new Simulacao(p.totalCents); });
  } catch (e) {
    if (e instanceof Simulacao) return { totalCents: e.totalCents };
    throw e;
  }
  throw new Error('simulação não concluída');
}

export const ehGestor = (req: { auth?: { role?: string | null } }) => req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';

balcaoRouter.post('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = schema.parse(req.body);
  const ctx: Ctx = { orgId, userId: req.auth?.userId ?? null, gestor: ehGestor(req) };
  const prep = await prepararVendaBalcao(ctx, b);
  const pedido = await prisma.$transaction((tx) => executarVendaBalcao(tx, ctx, b, prep));
  despacharEmBreve();
  await auditar(req, 'pedido.balcao', 'erp_pedido_venda', pedido.id, null, { numero: pedido.numero, totalCents: pedido.totalCents, forma: b.forma, caixaSessaoId: prep.sessao.id });
  avisarPedidoErp(pedido, { balcao: true });
  res.status(201).json(pedido);
}));
