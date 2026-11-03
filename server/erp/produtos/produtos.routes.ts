/** Cadastro de produtos, tabelas de preço (regional e por volume), condições de pagamento e regras comerciais. */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, badRequest, notFound } from '../../lib/http.js';
import { orgOf, requireRole } from '../../auth/session.js';
import { auditar } from '../shared/auditoria.js';
import { precoPorVolume } from '../vendas/calculo.js';

export const produtosRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');
const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const cents = z.number().int().min(0).max(2_000_000_000);

export const produtoSchema = z.object({
  sku: z.string().trim().min(1).max(40).transform((v) => v.toUpperCase()),
  nome: z.string().trim().min(2).max(200), descricao: opt(2000), codigoBarras: opt(20),
  unidade: z.string().trim().min(1).max(6).transform((v) => v.toUpperCase()).default('UN'),
  ncm: z.string().nullish().transform((v) => (v ? v.replace(/\D/g, '') || null : null)).refine((v) => !v || v.length === 8, 'NCM deve ter 8 dígitos'),
  cest: opt(9), origem: z.number().int().min(0).max(8).default(0), pesoGramas: z.number().int().min(0).max(100_000_000).default(0),
  controlaLote: z.boolean().default(false), controlaValidade: z.boolean().default(false), regraSaida: z.enum(['FIFO', 'FEFO']).default('FIFO'),
  estoqueMinimoMil: z.number().int().min(0).default(0), pontoPedidoMil: z.number().int().min(0).default(0),
  leadTimeDias: z.number().int().min(0).max(730).default(0), loteMinimoMil: z.number().int().min(0).default(0), fornecedorPadraoId: z.string().nullish(),
  precoBaseCents: cents.default(0), tipo: z.enum(['REVENDA', 'PRODUZIDO', 'INSUMO', 'SERVICO']).default('REVENDA'), ativo: z.boolean().default(true),
}).refine((p) => !p.controlaValidade || p.controlaLote, { message: 'Controle de validade exige controle de lote', path: ['controlaValidade'] });

/** Saldo agregado por produto (físico, reservado, quarentena, disponível). */
async function saldosPorProduto(orgId: string, ids?: string[]) {
  const g = await prisma.erpSaldo.groupBy({ by: ['produtoId'], where: { orgId, ...(ids ? { produtoId: { in: ids } } : {}) }, _sum: { fisicoMil: true, reservadoMil: true, quarentenaMil: true } });
  return new Map(g.map((x) => {
    const f = x._sum.fisicoMil ?? 0, r = x._sum.reservadoMil ?? 0, q = x._sum.quarentenaMil ?? 0;
    return [x.produtoId, { fisicoMil: f, reservadoMil: r, quarentenaMil: q, disponivelMil: Math.max(0, f - r - q) }];
  }));
}
const ZERO = { fisicoMil: 0, reservadoMil: 0, quarentenaMil: 0, disponivelMil: 0 };

produtosRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const where = { orgId, ...(req.query.ativos === '1' ? { ativo: true } : {}), ...(q ? { OR: [{ nome: { contains: q } }, { sku: { contains: q.toUpperCase() } }, { codigoBarras: q }] } : {}) };
  const items = await prisma.erpProduto.findMany({ where, orderBy: { nome: 'asc' }, take: 300 });
  const saldos = await saldosPorProduto(orgId, items.map((i) => i.id));
  res.json({ items: items.map((p) => { const s = saldos.get(p.id) ?? ZERO; return { ...p, saldo: s, abaixoMinimo: p.tipo !== 'SERVICO' && p.estoqueMinimoMil > 0 && s.disponivelMil < p.estoqueMinimoMil, noPontoPedido: p.tipo !== 'SERVICO' && p.pontoPedidoMil > 0 && s.disponivelMil <= p.pontoPedidoMil }; }) });
}));

produtosRouter.post('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = produtoSchema.parse(req.body);
  if (await prisma.erpProduto.findUnique({ where: { orgId_sku: { orgId, sku: b.sku } } })) throw badRequest(`SKU ${b.sku} já existe`);
  const p = await prisma.erpProduto.create({ data: { orgId, ...b } });
  await auditar(req, 'produto.criar', 'erp_produto', p.id, null, { sku: p.sku, nome: p.nome });
  res.status(201).json(p);
}));

/** Preço sugerido: tabela (com faixa de volume) ou preço base. */
produtosRouter.get('/preco', ah(async (req, res) => {
  const orgId = orgOf(req);
  const f = z.object({ produtoId: z.string(), tabelaId: z.string().optional(), qtdMil: z.coerce.number().int().min(0).default(1000) }).parse(req.query);
  const p = await prisma.erpProduto.findFirst({ where: { id: f.produtoId, orgId } });
  if (!p) throw notFound('Produto');
  const faixas = f.tabelaId ? await prisma.erpTabelaPrecoItem.findMany({ where: { tabelaId: f.tabelaId, produtoId: p.id, tabela: { orgId, ativa: true } } }) : [];
  res.json({ precoCents: precoPorVolume(faixas, f.qtdMil, p.precoBaseCents) });
}));

// ---- Tabelas de preço ----
produtosRouter.get('/tabelas', ah(async (req, res) => res.json(await prisma.erpTabelaPreco.findMany({ where: { orgId: orgOf(req) }, include: { itens: true }, orderBy: { nome: 'asc' } }))));
const tabelaSchema = z.object({
  nome: z.string().trim().min(1).max(80), uf: z.string().trim().length(2).toUpperCase().nullish().or(z.literal('')).transform((v) => v || null), ativa: z.boolean().default(true),
  itens: z.array(z.object({ produtoId: z.string(), qtdMinimaMil: z.number().int().min(0).default(0), precoCents: cents })).max(5000).default([]),
});
async function salvarTabela(orgId: string, id: string | null, b: z.infer<typeof tabelaSchema>) {
  const ids = [...new Set(b.itens.map((i) => i.produtoId))];
  if (ids.length && (await prisma.erpProduto.count({ where: { orgId, id: { in: ids } } })) !== ids.length) throw badRequest('Produto inválido na tabela');
  return prisma.$transaction(async (tx) => {
    const t = id ? await tx.erpTabelaPreco.update({ where: { id }, data: { nome: b.nome, uf: b.uf, ativa: b.ativa } }) : await tx.erpTabelaPreco.create({ data: { orgId, nome: b.nome, uf: b.uf, ativa: b.ativa } });
    await tx.erpTabelaPrecoItem.deleteMany({ where: { tabelaId: t.id } });
    if (b.itens.length) await tx.erpTabelaPrecoItem.createMany({ data: b.itens.map((i) => ({ tabelaId: t.id, ...i })) });
    return t;
  });
}
produtosRouter.post('/tabelas', admins, ah(async (req, res) => res.status(201).json(await salvarTabela(orgOf(req), null, tabelaSchema.parse(req.body)))));
produtosRouter.put('/tabelas/:id', admins, ah(async (req, res) => {
  if (!(await prisma.erpTabelaPreco.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } }))) throw notFound('Tabela');
  res.json(await salvarTabela(orgOf(req), req.params.id, tabelaSchema.parse(req.body)));
}));

// ---- Condições de pagamento ----
produtosRouter.get('/condicoes', ah(async (req, res) => {
  const items = await prisma.erpCondicaoPagamento.findMany({ where: { orgId: orgOf(req) }, orderBy: { nome: 'asc' } });
  res.json(items.map((c) => ({ ...c, prazos: JSON.parse(c.prazos) as number[] })));
}));
const condSchema = z.object({ nome: z.string().trim().min(1).max(60), prazos: z.array(z.number().int().min(0).max(720)).min(1).max(24), ativa: z.boolean().default(true) });
produtosRouter.post('/condicoes', admins, ah(async (req, res) => {
  const b = condSchema.parse(req.body);
  res.status(201).json(await prisma.erpCondicaoPagamento.create({ data: { orgId: orgOf(req), nome: b.nome, ativa: b.ativa, prazos: JSON.stringify([...b.prazos].sort((x, y) => x - y)) } }));
}));
produtosRouter.put('/condicoes/:id', admins, ah(async (req, res) => {
  const b = condSchema.parse(req.body);
  const r = await prisma.erpCondicaoPagamento.updateMany({ where: { id: req.params.id, orgId: orgOf(req) }, data: { nome: b.nome, ativa: b.ativa, prazos: JSON.stringify([...b.prazos].sort((x, y) => x - y)) } });
  if (!r.count) throw notFound('Condição');
  res.json({ ok: true });
}));

// ---- Regras comerciais (alçada de desconto, crédito) ----
export const configDa = (orgId: string, db: Pick<typeof prisma, 'erpConfig'> = prisma) => db.erpConfig.upsert({ where: { orgId }, create: { orgId }, update: {} });
produtosRouter.get('/config', ah(async (req, res) => res.json(await configDa(orgOf(req)))));
produtosRouter.put('/config', admins, ah(async (req, res) => {
  const b = z.object({ descontoMaxBp: z.number().int().min(0).max(10_000), bloquearSemCredito: z.boolean(), validadeOrcamentoDias: z.number().int().min(1).max(365),
    formatoLote: z.string().trim().min(3).max(40).regex(/\{SEQ\}/, 'O formato precisa ter {SEQ}').optional(), etiquetaLarguraMm: z.number().int().min(20).max(200).optional(), etiquetaAlturaMm: z.number().int().min(10).max(200).optional(), etiquetaDpi: z.union([z.literal(203), z.literal(300)]).optional(),
    alcadaCompraCents: z.number().int().min(0).max(2_000_000_000).optional(), toleranciaPrecoBp: z.number().int().min(0).max(5000).optional(), recebimentoCego: z.boolean().optional(), multaAtrasoBp: z.number().int().min(0).max(200).optional(), jurosMesBp: z.number().int().min(0).max(1000).optional() }).partial({ descontoMaxBp: true, bloquearSemCredito: true, validadeOrcamentoDias: true }).parse(req.body);
  const orgId = orgOf(req);
  const antes = await configDa(orgId);
  const c = await prisma.erpConfig.update({ where: { orgId }, data: b });
  await auditar(req, 'config.comercial', 'erp_config', orgId, { descontoMaxBp: antes.descontoMaxBp, bloquearSemCredito: antes.bloquearSemCredito }, b);
  res.json(c);
}));

// Por último: '/:id' não pode capturar '/config', '/tabelas'...
produtosRouter.put('/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const antes = await prisma.erpProduto.findFirst({ where: { id: req.params.id, orgId } });
  if (!antes) throw notFound('Produto');
  const b = produtoSchema.parse(req.body);
  if (b.sku !== antes.sku && (await prisma.erpProduto.findUnique({ where: { orgId_sku: { orgId, sku: b.sku } } }))) throw badRequest(`SKU ${b.sku} já existe`);
  const temSaldo = (await prisma.erpSaldo.count({ where: { orgId, produtoId: antes.id, fisicoMil: { gt: 0 } } })) > 0;
  if (temSaldo && b.controlaLote !== antes.controlaLote) throw badRequest('Não dá para mudar o controle de lote com saldo em estoque');
  const p = await prisma.erpProduto.update({ where: { id: antes.id }, data: b });
  await auditar(req, 'produto.editar', 'erp_produto', p.id, { precoBaseCents: antes.precoBaseCents, ativo: antes.ativo }, { precoBaseCents: p.precoBaseCents, ativo: p.ativo });
  res.json(p);
}));

