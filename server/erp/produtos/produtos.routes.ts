/** Cadastro de produtos, tabelas de preço (regional e por volume), condições de pagamento e regras comerciais. */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { contem } from '../../lib/busca.js';
import { ah, badRequest, notFound } from '../../lib/http.js';
import { orgOf, requireRole } from '../../auth/session.js';
import { auditar } from '../shared/auditoria.js';
import bcrypt from 'bcryptjs';
import { precoPorVolume } from '../vendas/calculo.js';
import { HttpError } from '../../lib/http.js';
import { notificarProprietario } from '../alertas/alertas.js';

/** Custo que entra no CMV: custo médio + custos adicionais por unidade (embalagem, frete rateado...). */
export function custoTotal(p: { custoMedioCents: number; custosAdicionais?: string | null }): number {
  try { return p.custoMedioCents + (JSON.parse(p.custosAdicionais || '[]') as { valorCents: number }[]).reduce((a, c) => a + (Number(c.valorCents) || 0), 0); }
  catch { return p.custoMedioCents; }
}
/** Produtos cujo custo veio de NF-e (XML): mudar o custo à mão exige a senha do usuário. */
export async function comEntradaXml(orgId: string, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const r = await prisma.erpMovimento.findMany({ where: { orgId, produtoId: { in: ids }, docTipo: 'nfe_entrada' }, distinct: ['produtoId'], select: { produtoId: true } });
  return new Set(r.map((m) => m.produtoId));
}

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
  precoBaseCents: cents.default(0), custoMedioCents: cents.optional(), custosAdicionais: z.array(z.object({ nome: z.string().trim().min(1).max(60), valorCents: cents })).max(20).default([]).transform((l) => JSON.stringify(l)), tipo: z.enum(['REVENDA', 'PRODUZIDO', 'INSUMO', 'SERVICO']).default('REVENDA'), ativo: z.boolean().default(true),
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
  const where = { orgId, ...(req.query.ativos === '1' ? { ativo: true } : {}), ...(q ? { OR: [{ nome: contem(q) }, { sku: contem(q.toUpperCase()) }, { codigoBarras: q }] } : {}) };
  const items = await prisma.erpProduto.findMany({ where, orderBy: { nome: 'asc' }, take: 300 });
  const saldos = await saldosPorProduto(orgId, items.map((i) => i.id));
  const xml = await comEntradaXml(orgId, items.map((p) => p.id));
  res.json({ items: items.map((p) => { const s = saldos.get(p.id) ?? ZERO; return { ...p, custoPorXml: xml.has(p.id), custoTotalCents: custoTotal(p), saldo: s, abaixoMinimo: p.tipo !== 'SERVICO' && p.estoqueMinimoMil > 0 && s.disponivelMil < p.estoqueMinimoMil, noPontoPedido: p.tipo !== 'SERVICO' && p.pontoPedidoMil > 0 && s.disponivelMil <= p.pontoPedidoMil }; }) });
}));

/** EAN-13 com dígito verificador. */
export function digitoEan13(doze: string) {
  const soma = doze.split('').reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
  return String((10 - (soma % 10)) % 10);
}
/** Código de barras interno (EAN-13 com prefixo 2, faixa de uso interno da GS1), único na empresa. */
export async function gerarCodigoBarras(orgId: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const doze = `2${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`;
    const ean = doze + digitoEan13(doze);
    if (!(await prisma.erpProduto.findFirst({ where: { orgId, codigoBarras: ean }, select: { id: true } }))) return ean;
  }
  throw badRequest('Não foi possível gerar o código de barras; tente de novo');
}

produtosRouter.post('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = produtoSchema.parse(req.body);
  if (await prisma.erpProduto.findUnique({ where: { orgId_sku: { orgId, sku: b.sku } } })) throw badRequest(`SKU ${b.sku} já existe`);
  const codigoBarras = b.codigoBarras || await gerarCodigoBarras(orgId);
  const p = await prisma.erpProduto.create({ data: { orgId, ...b, codigoBarras } });
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
  // Código de barras: mantém o atual se o campo vier vazio; gera um interno se o produto ainda não tem.
  const codigoBarras = b.codigoBarras || antes.codigoBarras || await gerarCodigoBarras(orgId);
  const mudouCusto = b.custoMedioCents !== undefined && b.custoMedioCents !== antes.custoMedioCents;
  const porXml = mudouCusto && (await comEntradaXml(orgId, [antes.id])).has(antes.id);
  if (porXml) {
    const senha = typeof req.body?.senhaCusto === 'string' ? req.body.senhaCusto : '';
    if (!senha) throw new HttpError(403, 'Este custo veio da nota fiscal (XML). Informe sua senha para alterar.');
    const u = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { passwordHash: true } });
    if (!u || !(await bcrypt.compare(senha, u.passwordHash))) throw new HttpError(403, 'Senha incorreta. O custo não foi alterado.');
  }
  const p = await prisma.erpProduto.update({ where: { id: antes.id }, data: { ...b, codigoBarras } });
  if (mudouCusto) await auditar(req, porXml ? 'produto.custo_xml' : 'produto.custo', 'erp_produto', p.id, { custoMedioCents: antes.custoMedioCents }, { custoMedioCents: b.custoMedioCents, origem: porXml ? 'custo da NF-e alterado com senha' : 'manual' });
  const mudouExtras = (antes.custosAdicionais ?? '[]') !== (p.custosAdicionais ?? '[]');
  if (porXml || (mudouExtras && (await comEntradaXml(orgId, [antes.id])).has(antes.id))) {
    const quem = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { name: true, email: true } });
    const r = (c: number) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;
    const linhas = [`Produto: ${p.sku} · ${p.nome}`, porXml ? `Custo da nota (XML): ${r(antes.custoMedioCents)} → ${r(p.custoMedioCents)}` : null, mudouExtras ? `Custo total com extras: ${r(custoTotal(antes))} → ${r(custoTotal(p))}` : null, `Alterado por: ${quem?.name ?? ''} (${quem?.email ?? ''})`, `Quando: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`].filter(Boolean).join('\n');
    void notificarProprietario(orgId, 'Custo de produto alterado', linhas);
  }
  if (mudouExtras) await auditar(req, 'produto.custos_adicionais', 'erp_produto', p.id, { custosAdicionais: antes.custosAdicionais }, { custosAdicionais: p.custosAdicionais });
  await auditar(req, 'produto.editar', 'erp_produto', p.id, { precoBaseCents: antes.precoBaseCents, ativo: antes.ativo }, { precoBaseCents: p.precoBaseCents, ativo: p.ativo });
  res.json(p);
}));

