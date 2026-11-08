/**
 * Produtos (catálogo do cliente) — montado em /api/ai/products, dentro do aiRouter: herda requireOrg,
 * requireModule('ia') e requireMckbotForWrites, como a base de conhecimento.
 * Leitura: qualquer membro com o módulo IA. Escrita: OWNER/ADMIN.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, badRequest } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { sanitizeText } from '../lib/contacts-import.js';
import { PRODUCT_LIMITS, STOCK, filterProducts, isHttpsUrl, productTemplateCsv, readProductsCsv } from '../ai/products.js';
import { PRODUCT_SOURCES, ERP_SEM_PLANO_MSG, erpLiberadoParaIa, productContextFor, type ProductSource } from '../ai/productSource.js';

export const productsRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');

const httpsUrl = z.string().trim().max(PRODUCT_LIMITS.url).refine(isHttpsUrl, 'Use um endereço que comece com https://');
const optUrl = z.union([httpsUrl, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null));
const cents = z.number().int().min(0).max(2_000_000_000).nullable().optional().transform((v) => v ?? null);

const productSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(PRODUCT_LIMITS.name),
  category: z.string().trim().max(PRODUCT_LIMITS.category).nullable().optional().transform((v) => (v ? v : null)),
  priceCents: cents,
  promoCents: cents,
  description: z.string().max(PRODUCT_LIMITS.description).optional().default(''),
  details: z.string().max(PRODUCT_LIMITS.details).optional().default(''),
  stock: z.enum(STOCK).optional().default('disponivel'),
  quantity: z.number().int().min(0).max(1_000_000).nullable().optional().transform((v) => v ?? null),
  link: optUrl,
  imageUrl: optUrl,
  active: z.boolean().optional().default(true),
});

const clean = (b: z.infer<typeof productSchema>) => ({
  ...b,
  name: sanitizeText(b.name, PRODUCT_LIMITS.name) || b.name.trim(),
  category: b.category ? sanitizeText(b.category, PRODUCT_LIMITS.category) || null : null,
  description: b.description.trim(),
  details: b.details.trim(),
});

productsRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  const list = await prisma.product.findMany({ where: { orgId }, orderBy: [{ active: 'desc' }, { name: 'asc' }], take: PRODUCT_LIMITS.total });
  const items = filterProducts(list, q);
  res.json({ items, total: list.length, limit: PRODUCT_LIMITS.total });
}));

/** Modelo da planilha (CSV ; com BOM, abre no Excel). */
productsRouter.get('/template', ah(async (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-produtos.csv"');
  res.send(productTemplateCsv());
}));

// ---- v1.24.0 De onde a IA consulta os produtos (Produtos, ERP ou os dois) ----
const sourceSchema = z.object({
  productSource: z.enum(PRODUCT_SOURCES),
  erpShowQuantity: z.boolean().optional(),
  erpDepositoId: z.string().trim().min(1).max(64).nullable().optional(),
});

/** Configuração atual + se o ERP está liberado + depósitos da empresa (só id e nome) para o seletor. */
productsRouter.get('/source', ah(async (req, res) => {
  const orgId = orgOf(req);
  const [s, erpLiberado] = await Promise.all([
    prisma.aiSettings.findUnique({ where: { orgId }, select: { productSource: true, erpShowQuantity: true, erpDepositoId: true } }),
    erpLiberadoParaIa(orgId).catch(() => false),
  ]);
  const depositos = erpLiberado ? await prisma.erpDeposito.findMany({ where: { orgId, ativo: true }, select: { id: true, nome: true }, orderBy: { nome: 'asc' } }) : [];
  const productSource = (s?.productSource ?? 'catalogo') as ProductSource;
  res.json({
    productSource, erpShowQuantity: s?.erpShowQuantity ?? false, erpDepositoId: s?.erpDepositoId ?? null,
    erpLiberado, motivo: erpLiberado ? null : ERP_SEM_PLANO_MSG, depositos,
    efetivo: productSource !== 'catalogo' && !erpLiberado ? 'catalogo' : productSource,
  });
}));

productsRouter.put('/source', admins, ah(async (req, res) => {
  const body = sourceSchema.parse(req.body);
  const orgId = orgOf(req);
  if (body.productSource !== 'catalogo' && !(await erpLiberadoParaIa(orgId))) throw badRequest(ERP_SEM_PLANO_MSG);
  if (body.erpDepositoId && !(await prisma.erpDeposito.findFirst({ where: { id: body.erpDepositoId, orgId }, select: { id: true } }))) throw notFound('Depósito');
  const data = {
    productSource: body.productSource,
    ...(body.erpShowQuantity !== undefined ? { erpShowQuantity: body.erpShowQuantity } : {}),
    ...(body.erpDepositoId !== undefined ? { erpDepositoId: body.erpDepositoId } : {}),
  };
  const s = await prisma.aiSettings.upsert({ where: { orgId }, create: { orgId, ...data }, update: data, select: { productSource: true, erpShowQuantity: true, erpDepositoId: true } });
  await audit(req, 'ai.product_source', { entity: 'ai_settings', meta: { ...s } });
  res.json(s);
}));

/**
 * Prévia do que a IA receberia para uma mensagem (ajuda o cliente a testar). Segue a fonte salva da empresa; a tela
 * pode mandar a fonte escolhida (ainda não salva) para testar antes — com a mesma regra de plano e o mesmo recuo.
 */
productsRouter.post('/preview', ah(async (req, res) => {
  const b = z.object({
    message: z.string().trim().min(1).max(2000),
    productSource: z.enum(PRODUCT_SOURCES).optional(),
    erpShowQuantity: z.boolean().optional(),
    erpDepositoId: z.string().trim().min(1).max(64).nullable().optional(),
  }).parse(req.body);
  const orgId = orgOf(req);
  if (b.erpDepositoId && !(await prisma.erpDeposito.findFirst({ where: { id: b.erpDepositoId, orgId }, select: { id: true } }))) throw notFound('Depósito');
  const r = await productContextFor(orgId, b.message, b.productSource ? { source: b.productSource, showQty: b.erpShowQuantity ?? false, depositoId: b.erpDepositoId ?? null } : {});
  res.json({
    products: r.products.map((p) => ({ id: p.id, name: p.name, origem: p.origem })), context: r.context,
    source: r.source, requested: r.requested, fallback: r.fallback,
  });
}));

productsRouter.post('/', admins, ah(async (req, res) => {
  const body = clean(productSchema.parse(req.body));
  const orgId = orgOf(req);
  if ((await prisma.product.count({ where: { orgId } })) >= PRODUCT_LIMITS.total) throw badRequest(`Limite de ${PRODUCT_LIMITS.total} produtos atingido.`);
  const p = await prisma.product.create({ data: { orgId, ...body } });
  await audit(req, 'product.create', { entity: 'product', entityId: p.id });
  res.status(201).json(p);
}));

productsRouter.put('/:id', admins, ah(async (req, res) => {
  const body = clean(productSchema.parse(req.body));
  const orgId = orgOf(req);
  const p = await prisma.product.findFirst({ where: { id: req.params.id, orgId } });
  if (!p) throw notFound('Produto');
  const updated = await prisma.product.update({ where: { id: p.id }, data: body });
  await audit(req, 'product.update', { entity: 'product', entityId: p.id });
  res.json(updated);
}));

/** Liga/desliga o produto (a IA só usa os ativos). */
productsRouter.patch('/:id', admins, ah(async (req, res) => {
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  const orgId = orgOf(req);
  const p = await prisma.product.findFirst({ where: { id: req.params.id, orgId } });
  if (!p) throw notFound('Produto');
  const updated = await prisma.product.update({ where: { id: p.id }, data: { active } });
  await audit(req, 'product.toggle', { entity: 'product', entityId: p.id, meta: { active } });
  res.json(updated);
}));

productsRouter.delete('/:id', admins, ah(async (req, res) => {
  const orgId = orgOf(req);
  const p = await prisma.product.findFirst({ where: { id: req.params.id, orgId } });
  if (!p) throw notFound('Produto');
  await prisma.product.delete({ where: { id: p.id } });
  await audit(req, 'product.delete', { entity: 'product', entityId: p.id });
  res.json({ ok: true });
}));

/**
 * Importa a planilha (texto do CSV no JSON). Produto com o mesmo nome (sem diferenciar maiúsculas) é atualizado;
 * os demais são criados. Até 500 linhas por importação e 2000 produtos por organização.
 */
productsRouter.post('/import', admins, ah(async (req, res) => {
  const { text } = z.object({ text: z.string().min(1).max(900_000) }).parse(req.body);
  const orgId = orgOf(req);
  const sheet = readProductsCsv(text);
  if (!sheet.ok) throw badRequest(sheet.error);
  if (sheet.rows.length > PRODUCT_LIMITS.perImport) throw badRequest(`A planilha tem ${sheet.rows.length} linhas. Importe no máximo ${PRODUCT_LIMITS.perImport} por vez.`);
  const existing = await prisma.product.findMany({ where: { orgId }, select: { id: true, name: true } });
  const byName = new Map(existing.map((p) => [p.name.trim().toLowerCase(), p.id]));
  let count = existing.length, created = 0, updated = 0;
  const errors: string[] = [];
  for (const r of sheet.rows) {
    if (!r.ok) { errors.push(`Linha ${r.line}: ${r.error}`); continue; }
    const key = r.data.name.trim().toLowerCase();
    const id = byName.get(key);
    if (id) {
      await prisma.product.update({ where: { id }, data: r.data });
      updated++;
      continue;
    }
    if (count >= PRODUCT_LIMITS.total) { errors.push(`Linha ${r.line}: limite de ${PRODUCT_LIMITS.total} produtos atingido`); continue; }
    const p = await prisma.product.create({ data: { orgId, ...r.data } });
    byName.set(key, p.id);
    count++; created++;
  }
  await audit(req, 'product.import', { entity: 'product', meta: { created, updated, errors: errors.length } });
  res.json({ created, updated, errors: errors.slice(0, 50), errorCount: errors.length });
}));
