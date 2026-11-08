/**
 * v1.24.0 — De onde a IA consulta os produtos (AiSettings.productSource, por organização):
 *  - catalogo (padrão): só os Produtos cadastrados (comportamento de antes, sem mudança nenhuma);
 *  - erp: só os produtos ativos do MCK ERP, com o saldo em tempo real;
 *  - ambos: Produtos para descrição/promoção/link + ERP para o saldo (liga pelo SKU ou pelo nome).
 *
 * ERP só para quem tem o ERP liberado (plano com o MCK ERP ativo/teste — padrão Plano Completo — ou a empresa da própria MCK). Sem isso, ou se a
 * consulta ao ERP falhar, volta para o catálogo e a IA responde normalmente.
 * Nunca vai para o prompt: custo médio, custos adicionais, fornecedor, lote, endereço ou qualquer dado interno —
 * a consulta ao ErpProduto seleciona só os campos públicos abaixo.
 */
import { prisma } from '../db.js';
import { erpLiberado } from '../billing/erpAccess.js';
import { saldosParaSaida } from '../erp/estoque/servico.js';
import { planejarAlocacao, type SaldoLinha } from '../erp/estoque/saldo.js';
import {
  PRODUCT_LIMITS, PRODUCT_RULES, PROMPT_MAX_PRODUCTS, clip, formatBRL, formatLinesBlock, formatProductLine,
  formatProductsContext, matchProducts, type ProductLike,
} from './products.js';

export const PRODUCT_SOURCES = ['catalogo', 'erp', 'ambos'] as const;
export type ProductSource = (typeof PRODUCT_SOURCES)[number];
export const isProductSource = (v: unknown): v is ProductSource => (PRODUCT_SOURCES as readonly unknown[]).includes(v);

export const ERP_SEM_PLANO_MSG = 'O estoque do MCK ERP faz parte do Plano Completo (ERP + MCKBOT + MCK Mensagens). Sem ele, a IA usa só os Produtos cadastrados.';

/**
 * O ERP pode alimentar a IA desta empresa? Mesma regra de acesso do ERP (v1.25.0: plano com o módulo MCK ERP no
 * Master, padrão Plano Completo) + empresa da própria MCK. Sem isso, 'erp'/'ambos' voltam ao catálogo.
 */
export async function erpLiberadoParaIa(orgId: string): Promise<boolean> {
  return erpLiberado(orgId);
}

// ---------------- Regras puras (testadas em tests/unit/ia-fonte-produtos.test.ts) ----------------

export type ErpStock = 'disponivel' | 'poucas' | 'sem_estoque' | 'sob_encomenda';
export const ERP_STOCK_LABEL: Record<ErpStock, string> = { disponivel: 'Disponível', poucas: 'Poucas unidades', sem_estoque: 'Sem estoque', sob_encomenda: 'Sob encomenda' };
/** Até 5 unidades (ou até o estoque mínimo do produto, se maior) = "poucas unidades". */
export const POUCAS_MIL = 5_000;

/** Situação do estoque a partir do disponível (milésimos). Serviço não tem estoque; produzido sem saldo = sob encomenda. */
export function erpStockStatus(disponivelMil: number, p: { tipo?: string | null; estoqueMinimoMil?: number | null }): ErpStock {
  if (p.tipo === 'SERVICO') return 'disponivel';
  if (disponivelMil <= 0) return p.tipo === 'PRODUZIDO' ? 'sob_encomenda' : 'sem_estoque';
  return disponivelMil <= Math.max(POUCAS_MIL, p.estoqueMinimoMil ?? 0) ? 'poucas' : 'disponivel';
}

/** 12500 mil, "KG" → "12,5 KG"; 3000, "UN" → "3 UN". */
export function formatQtdMil(mil: number, unidade = 'UN'): string {
  const n = Math.max(0, mil) / 1000;
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${(unidade || 'UN').trim().toUpperCase()}`;
}

/** Campos do ErpProduto que podem chegar à IA. Custo, custos adicionais e fornecedor ficam de fora de propósito. */
export const ERP_PUBLIC_SELECT = {
  id: true, sku: true, nome: true, descricao: true, codigoBarras: true, unidade: true, tipo: true,
  estoqueMinimoMil: true, precoBaseCents: true,
} as const;
export interface ErpPublic {
  id: string; sku: string; nome: string; descricao: string | null; codigoBarras: string | null; unidade: string;
  tipo: string; estoqueMinimoMil: number; precoBaseCents: number;
}

/** Item que a IA pode receber: vindo do catálogo, do ERP ou dos dois (ambos). */
export interface AiProductItem extends ProductLike {
  key: string;
  catalogId?: string;
  /** Detalhes do catálogo (sem o SKU/código de barras que entram em `details` só para a busca). */
  catalogDetails?: string;
  erp?: ErpPublic;
  /** Preenchido depois da busca, só para os itens escolhidos (consulta de saldo). */
  disponivelMil?: number;
}

const nameKey = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** O SKU aparece como código inteiro no nome/detalhes do produto do catálogo? (SKU curto demais não liga.) */
export function mentionsSku(text: string, sku: string): boolean {
  const k = sku.trim().toLowerCase();
  if (k.length < 3) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(k)}([^a-z0-9]|$)`).test(text.toLowerCase());
}

/** Texto extra de busca do ERP: SKU e código de barras (o cliente pode mandar o código). */
const erpSearchExtra = (e: ErpPublic) => [e.sku, e.codigoBarras ?? ''].filter(Boolean).join(' ');
const erpPrice = (e: ErpPublic) => (e.precoBaseCents > 0 ? e.precoBaseCents : null);

export function erpItem(e: ErpPublic): AiProductItem {
  return { key: `erp:${e.id}`, erp: e, name: e.nome, category: null, priceCents: erpPrice(e), promoCents: null, description: e.descricao ?? '', details: erpSearchExtra(e), active: true };
}

/**
 * "Os dois": cada produto do catálogo liga a um produto do ERP pelo SKU (citado no nome/detalhes) ou pelo nome igual.
 * Ligado: descrição, detalhes, promoção, link e foto do catálogo; preço do catálogo (ou do ERP, se o catálogo não
 * tem); estoque do ERP. Produto só do catálogo segue como está; produto só do ERP entra com os dados do ERP.
 */
export function mergeCatalogErp<C extends ProductLike & { id: string }>(catalog: C[], erp: ErpPublic[]): AiProductItem[] {
  const byName = new Map<string, ErpPublic>();
  for (const e of erp) if (!byName.has(nameKey(e.nome))) byName.set(nameKey(e.nome), e);
  const used = new Set<string>();
  const out: AiProductItem[] = [];
  for (const c of catalog) {
    if (c.active === false) continue;
    const hay = `${c.name} ${c.details ?? ''}`;
    let e = erp.find((x) => !used.has(x.id) && mentionsSku(hay, x.sku));
    if (!e) { const n = byName.get(nameKey(c.name)); if (n && !used.has(n.id)) e = n; }
    if (e) used.add(e.id);
    out.push({
      key: `cat:${c.id}`, catalogId: c.id, catalogDetails: c.details ?? '', erp: e,
      name: c.name, category: c.category ?? null,
      priceCents: c.priceCents ?? (e ? erpPrice(e) : null), promoCents: c.promoCents ?? null,
      description: c.description || e?.descricao || '',
      details: [c.details ?? '', e ? erpSearchExtra(e) : ''].filter(Boolean).join(' | '),
      stock: c.stock, quantity: c.quantity, link: c.link ?? null, imageUrl: c.imageUrl ?? null, active: true,
    });
  }
  for (const e of erp) if (!used.has(e.id)) out.push(erpItem(e));
  return out;
}

/** Linha do prompt. Item sem ERP usa a linha do catálogo; com ERP, a disponibilidade vem do saldo. */
export function formatAiItemLine(it: AiProductItem, showQty: boolean): string {
  if (!it.erp) return formatProductLine(it);
  const parts = [clip(it.name, 120)];
  if (it.category) parts.push(clip(it.category, 60));
  parts.push(`cód. ${clip(it.erp.sku, 40)}`);
  if (it.priceCents != null && it.promoCents != null && it.promoCents < it.priceCents) parts.push(`promoção ${formatBRL(it.promoCents)} (de ${formatBRL(it.priceCents)})`);
  else if (it.promoCents != null) parts.push(`preço ${formatBRL(it.promoCents)}`);
  else if (it.priceCents != null) parts.push(`preço ${formatBRL(it.priceCents)}`);
  else parts.push('preço não cadastrado');
  const st = erpStockStatus(it.disponivelMil ?? 0, it.erp);
  const qtyOk = showQty && it.erp.tipo !== 'SERVICO' && (st === 'disponivel' || st === 'poucas');
  parts.push(ERP_STOCK_LABEL[st] + (qtyOk ? ` (${formatQtdMil(it.disponivelMil ?? 0, it.erp.unidade)})` : ''));
  // Detalhes do catálogo (sem o SKU/código de barras repetidos, que só servem para a busca).
  if (it.catalogDetails?.trim()) parts.push(`detalhes: ${clip(it.catalogDetails, 200)}`);
  if (it.description?.trim()) parts.push(`descrição: ${clip(it.description, 220)}`);
  if (it.link) parts.push(`link: ${it.link}`);
  if (it.imageUrl) parts.push(`foto: ${it.imageUrl}`);
  return '- ' + parts.join(' | ');
}

export const ERP_HEADER = '[Produtos do ERP]';

/** Regras da IA quando o estoque vem do ERP. */
export function erpRules(source: 'erp' | 'ambos', showQty: boolean): string {
  const base = source === 'erp'
    ? PRODUCT_RULES.replace('"[Produtos do catálogo]" cadastrados pela empresa', `"${ERP_HEADER}" (estoque da empresa)`).replace(/no catálogo/g, 'na lista')
    : PRODUCT_RULES;
  return [
    base,
    '- ESTOQUE EM TEMPO REAL: produtos com "cód." têm a situação vinda do estoque: "Disponível", "Poucas unidades", "Sem estoque" ou "Sob encomenda". "Sem estoque": avise que no momento não há e ofereça verificar com a equipe.',
    showQty
      ? '- Pode informar a quantidade disponível exatamente como aparece entre parênteses; nunca prometa mais do que isso.'
      : '- Não informe quantidade de estoque: diga só a situação (disponível, poucas unidades, sem estoque ou sob encomenda).',
    '- Nunca informe custo, margem, fornecedor ou qualquer dado interno da empresa.',
  ].join('\n');
}

// ---------------- Banco ----------------

/** Disponível do produto (milésimos) = Σ (físico − reservado − quarentena) dos lotes liberados e não vencidos (regra do ERP). */
export async function erpDisponivelMil(orgId: string, produtoId: string, depositoId?: string | null): Promise<number> {
  const saldos: SaldoLinha[] = await saldosParaSaida(prisma as any, orgId, produtoId, depositoId ?? null);
  const { alocacoes } = planejarAlocacao(saldos, Number.MAX_SAFE_INTEGER, 'FIFO');
  return alocacoes.reduce((a, x) => a + x.qtdMil, 0);
}

async function loadErp(orgId: string): Promise<ErpPublic[]> {
  // Insumo (matéria-prima) não é vendido ao cliente: fica fora.
  return prisma.erpProduto.findMany({ where: { orgId, ativo: true, tipo: { not: 'INSUMO' } }, select: ERP_PUBLIC_SELECT, orderBy: { updatedAt: 'desc' }, take: PRODUCT_LIMITS.total });
}

export interface SourceOptions { source?: ProductSource; showQty?: boolean; depositoId?: string | null }
export interface ProductSection {
  context: string; rules: string; count: number;
  /** Fonte pedida (configuração) e a usada de fato. */
  requested: ProductSource; source: ProductSource;
  /** Por que voltou ao catálogo, se voltou. */
  fallback: null | 'sem_plano' | 'erro_erp';
  products: { id: string; name: string; origem: 'catalogo' | 'erp' | 'ambos' }[];
}

/** Só o catálogo: o mesmo resultado de productsPromptSection (comportamento de antes), com a lista para a prévia. */
async function catalogSection(orgId: string, query: string, requested: ProductSource, fallback: ProductSection['fallback']): Promise<ProductSection> {
  const products = await prisma.product.findMany({ where: { orgId, active: true }, orderBy: { updatedAt: 'desc' }, take: PRODUCT_LIMITS.total });
  if (!products.length) return { context: '', rules: '', count: 0, requested, source: 'catalogo', fallback, products: [] };
  const hits = matchProducts(query, products);
  return {
    context: formatProductsContext(hits), rules: PRODUCT_RULES, count: hits.length, requested, source: 'catalogo', fallback,
    products: hits.map((p) => ({ id: p.id, name: p.name, origem: 'catalogo' as const })),
  };
}

/**
 * Bloco de produtos do prompt conforme a fonte da organização (ou a pedida na prévia).
 * Sempre devolve algo: sem plano ou com erro no ERP, volta ao catálogo.
 */
export async function productContextFor(orgId: string, query: string, opts: SourceOptions = {}): Promise<ProductSection> {
  const s = opts.source === undefined || opts.showQty === undefined || opts.depositoId === undefined
    ? await prisma.aiSettings.findUnique({ where: { orgId }, select: { productSource: true, erpShowQuantity: true, erpDepositoId: true } })
    : null;
  const requested: ProductSource = opts.source ?? (isProductSource(s?.productSource) ? s!.productSource as ProductSource : 'catalogo');
  if (requested === 'catalogo') return catalogSection(orgId, query, requested, null);
  if (!(await erpLiberadoParaIa(orgId).catch(() => false))) return catalogSection(orgId, query, requested, 'sem_plano');
  const showQty = opts.showQty ?? s?.erpShowQuantity ?? false;
  const depositoId = opts.depositoId !== undefined ? opts.depositoId : s?.erpDepositoId ?? null;
  try {
    const erp = await loadErp(orgId);
    const catalog = requested === 'ambos' ? await prisma.product.findMany({ where: { orgId, active: true }, orderBy: { updatedAt: 'desc' }, take: PRODUCT_LIMITS.total }) : [];
    const items = requested === 'ambos' ? mergeCatalogErp(catalog, erp) : erp.map(erpItem);
    if (!items.length) return { context: '', rules: '', count: 0, requested, source: requested, fallback: null, products: [] };
    const hits = matchProducts(query, items, PROMPT_MAX_PRODUCTS);
    for (const h of hits) if (h.erp) h.disponivelMil = await erpDisponivelMil(orgId, h.erp.id, depositoId);
    const head = requested === 'erp' ? ERP_HEADER : '[Produtos do catálogo]';
    const context = formatLinesBlock(head, hits.map((h) => formatAiItemLine(h, showQty)));
    const anyErp = items.some((i) => i.erp);
    const rules = anyErp ? erpRules(requested, showQty) : PRODUCT_RULES;
    return {
      context, rules, count: hits.length, requested, source: requested, fallback: null,
      products: hits.map((h) => ({ id: h.catalogId ?? h.erp!.id, name: h.name, origem: h.catalogId && h.erp ? 'ambos' as const : h.erp ? 'erp' as const : 'catalogo' as const })),
    };
  } catch (e) {
    console.warn('[ia] consulta ao ERP falhou: usando o catálogo', { orgId, error: (e as Error).message });
    return catalogSection(orgId, query, requested, 'erro_erp');
  }
}
