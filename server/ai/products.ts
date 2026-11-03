/**
 * Produtos (catálogo do cliente) para a IA: busca por termos (mesmo ranking BM25 da base de conhecimento),
 * formatação compacta para o prompt e leitura da planilha CSV de importação. Só funções puras, exceto
 * productsPromptSection (lê o banco).
 */
import { prisma } from '../db.js';
import { rank, tokenize } from './rag.js';
import { decodeCsv, detectDelimiter, parseCsv, sanitizeText } from '../lib/contacts-import.js';

export const STOCK = ['disponivel', 'sob_encomenda', 'esgotado'] as const;
export type Stock = (typeof STOCK)[number];
export const STOCK_LABEL: Record<Stock, string> = { disponivel: 'Disponível', sob_encomenda: 'Sob encomenda', esgotado: 'Esgotado' };

export const PRODUCT_LIMITS = { perImport: 500, total: 2000, name: 160, category: 80, description: 4000, details: 2000, url: 500 } as const;
/** Quantos produtos e quantos caracteres entram no prompt (orçamento de tokens pequeno). */
export const PROMPT_MAX_PRODUCTS = 5;
export const PROMPT_MAX_CHARS = 1800;

export interface ProductLike {
  name: string;
  category?: string | null;
  priceCents?: number | null;
  promoCents?: number | null;
  description?: string | null;
  details?: string | null;
  stock?: string | null;
  quantity?: number | null;
  link?: string | null;
  imageUrl?: string | null;
  active?: boolean;
}

/** 123456 → "R$ 1.234,56" (espaço comum, sem NBSP). */
export function formatBRL(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const int = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}R$ ${int},${String(abs % 100).padStart(2, '0')}`;
}

/** "R$ 1.234,56" | "1234.56" | "49,9" | "49" → centavos. Vazio → null. Inválido → NaN. */
export function parsePriceToCents(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : NaN;
  let s = v.replace(/r\$|\s|\u00a0/gi, '').trim();
  if (!s) return null;
  if (!/^\d[\d.,]*$/.test(s)) return NaN;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // O último separador é o decimal.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = (s.match(/,/g)!.length > 1 ? s.replace(/,(?=\d{3}(,|$))/g, '') : s).replace(',', '.');
  } else if (lastDot >= 0) {
    // "1.500" e "1.234.567" são milhar; "49.90" é decimal.
    const parts = s.split('.');
    if (parts.length > 2 || parts[1].length === 3) s = parts.join('');
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n * 100 <= 2e9 ? Math.round(n * 100) : NaN;
}

/** Texto usado na busca: nome pesa mais (repetido), depois categoria, detalhes e descrição. */
export function searchText(p: ProductLike): string {
  return [p.name, p.name, p.category ?? '', p.details ?? '', (p.description ?? '').slice(0, 1500)].join(' \n ');
}

/** Palavras genéricas ("quais produtos vocês têm?"): sem termo específico, mostra alguns produtos ativos. */
const GENERIC = /\b(produtos?|catalogo|cardapio|vendem|vende|opcoes|modelos|estoque|tabela de precos?|lista de precos?)\b/;

/** Os produtos ativos mais relevantes para a mensagem do cliente (até k). */
export function matchProducts<T extends ProductLike>(query: string, products: T[], k = PROMPT_MAX_PRODUCTS): T[] {
  const active = products.filter((p) => p.active !== false);
  if (!active.length || !tokenize(query).length) return [];
  const hits = rank(query, active.map((item) => ({ item, text: searchText(item) })), k).map((h) => h.item.item);
  if (hits.length) return hits;
  const q = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return GENERIC.test(q) ? active.slice(0, k) : [];
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};

/** Uma linha compacta por produto: nome | categoria | preço/promoção | disponibilidade | detalhes | descrição | link. */
export function formatProductLine(p: ProductLike): string {
  const parts = [clip(p.name, 120)];
  if (p.category) parts.push(clip(p.category, 60));
  if (p.priceCents != null && p.promoCents != null && p.promoCents < p.priceCents) parts.push(`promoção ${formatBRL(p.promoCents)} (de ${formatBRL(p.priceCents)})`);
  else if (p.promoCents != null) parts.push(`preço ${formatBRL(p.promoCents)}`);
  else if (p.priceCents != null) parts.push(`preço ${formatBRL(p.priceCents)}`);
  else parts.push('preço não cadastrado');
  const st = (STOCK as readonly string[]).includes(p.stock ?? '') ? (p.stock as Stock) : 'disponivel';
  parts.push(STOCK_LABEL[st] + (st !== 'esgotado' && p.quantity != null ? ` (${p.quantity} un.)` : ''));
  if (p.details?.trim()) parts.push(`detalhes: ${clip(p.details, 200)}`);
  if (p.description?.trim()) parts.push(`descrição: ${clip(p.description, 220)}`);
  if (p.link) parts.push(`link: ${p.link}`);
  if (p.imageUrl) parts.push(`foto: ${p.imageUrl}`);
  return '- ' + parts.join(' | ');
}

/** Bloco do prompt com os produtos encontrados, limitado a PROMPT_MAX_CHARS. Vazio se nenhum. */
export function formatProductsContext(products: ProductLike[], maxChars = PROMPT_MAX_CHARS): string {
  if (!products.length) return '';
  const head = '[Produtos do catálogo]';
  const lines: string[] = [];
  let size = head.length;
  for (const p of products) {
    let line = formatProductLine(p);
    if (size + line.length + 1 > maxChars) {
      if (lines.length) break;
      line = line.slice(0, Math.max(0, maxChars - size - 2)) + '…';
    }
    lines.push(line);
    size += line.length + 1;
  }
  return [head, ...lines].join('\n');
}

/** Regras da IA para o catálogo (vão junto das instruções quando a empresa tem produtos ativos). */
export const PRODUCT_RULES = [
  'PRODUTOS: o CONTEXTO pode trazer "[Produtos do catálogo]" cadastrados pela empresa.',
  '- Informe preço, promoção, disponibilidade e detalhes somente como aparecem no catálogo. Nunca invente preço, estoque, prazo ou característica.',
  '- Se o produto pedido não estiver no catálogo (ou estiver com "preço não cadastrado"), diga que vai verificar com a equipe.',
  '- Produto "Esgotado": avise que está esgotado. "Sob encomenda": avise que é sob encomenda.',
  '- Pode enviar o link do produto (e da foto) quando ajudar o cliente.',
].join('\n');

/** Busca os produtos ativos da organização e devolve { context, rules, count } para o prompt. */
export async function productsPromptSection(orgId: string, query: string): Promise<{ context: string; rules: string; count: number }> {
  const products = await prisma.product.findMany({ where: { orgId, active: true }, orderBy: { updatedAt: 'desc' }, take: PRODUCT_LIMITS.total });
  if (!products.length) return { context: '', rules: '', count: 0 };
  const hits = matchProducts(query, products);
  return { context: formatProductsContext(hits), rules: PRODUCT_RULES, count: hits.length };
}

// ---------------- Importação CSV ----------------

/** Colunas do modelo: nome;categoria;preco;descricao;detalhes;estoque;link;imagem (promocao opcional). */
export const PRODUCT_TEMPLATE_HEADER = ['nome', 'categoria', 'preco', 'promocao', 'descricao', 'detalhes', 'estoque', 'link', 'imagem'] as const;
export const PRODUCT_TEMPLATE_EXAMPLES: string[][] = [
  ['Camiseta Básica', 'Roupas', '49,90', '39,90', 'Camiseta 100% algodão', 'cores: preta, branca; tamanhos: P, M, G', 'disponivel', 'https://minhaloja.com.br/camiseta', 'https://minhaloja.com.br/fotos/camiseta.jpg'],
  ['Fiat Uno 2015', 'Veículos', '32.900,00', '', 'Revisado, único dono', 'ano 2015; 80.000 km; garantia de 3 meses', 'sob encomenda', '', ''],
  ['Fone Bluetooth X', 'Eletrônicos', '199,00', '', '', 'garantia 1 ano', '0', '', ''],
];

const csvCell = (v: string) => (/[";\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
export function productTemplateCsv(): string {
  return '\uFEFF' + [PRODUCT_TEMPLATE_HEADER, ...PRODUCT_TEMPLATE_EXAMPLES].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

type Col = 'name' | 'category' | 'price' | 'promo' | 'description' | 'details' | 'stock' | 'link' | 'image';
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const HEADER: Record<string, Col> = {
  nome: 'name', produto: 'name', name: 'name',
  categoria: 'category', category: 'category',
  preco: 'price', valor: 'price', price: 'price',
  promocao: 'promo', precopromocional: 'promo', promo: 'promo', precopromo: 'promo',
  descricao: 'description', description: 'description',
  detalhes: 'details', especificacoes: 'details', details: 'details',
  estoque: 'stock', disponibilidade: 'stock', quantidade: 'stock', stock: 'stock',
  link: 'link', url: 'link',
  imagem: 'image', foto: 'image', image: 'image', imageurl: 'image',
};

export function normalizeStock(v: string): { stock: Stock; quantity: number | null } | null {
  const s = norm(v);
  if (!s) return { stock: 'disponivel', quantity: null };
  if (/^\d+$/.test(s)) { const q = Number(s); return { stock: q > 0 ? 'disponivel' : 'esgotado', quantity: q }; }
  if (['disponivel', 'sim', 'emestoque', 'ok'].includes(s)) return { stock: 'disponivel', quantity: null };
  if (['sobencomenda', 'encomenda'].includes(s)) return { stock: 'sob_encomenda', quantity: null };
  if (['esgotado', 'indisponivel', 'nao', 'semestoque'].includes(s)) return { stock: 'esgotado', quantity: null };
  return null;
}

export const isHttpsUrl = (v: string) => { try { const u = new URL(v); return u.protocol === 'https:' && !!u.hostname; } catch { return false; } };

export interface ProductInput {
  name: string; category: string | null; priceCents: number | null; promoCents: number | null;
  description: string; details: string; stock: Stock; quantity: number | null; link: string | null; imageUrl: string | null;
}
export type ImportRow = { line: number; ok: true; data: ProductInput } | { line: number; ok: false; error: string };

/** Lê a planilha de produtos (texto ou bytes). Cabeçalho obrigatório com "nome"; separador ';' ou ','. */
export function readProductsCsv(input: string | Buffer): { ok: true; rows: ImportRow[] } | { ok: false; error: string } {
  let text = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : decodeCsv(input);
  const sep = text.match(/^sep=(.)\r?\n/i);
  const delim = sep ? sep[1] : detectDelimiter(text);
  if (sep) text = text.slice(sep[0].length);
  const all = parseCsv(text, delim);
  let start = 0;
  while (start < all.length && all[start].every((c) => !c.trim())) start++;
  if (start >= all.length) return { ok: false, error: 'A planilha está vazia.' };
  const header = all[start].map((h) => HEADER[norm(h)]);
  if (!header.includes('name')) return { ok: false, error: 'Cabeçalho inválido: a primeira linha precisa ter a coluna "nome". Baixe o modelo.' };
  const rows: ImportRow[] = [];
  for (let i = start + 1; i < all.length; i++) {
    const cells = all[i];
    if (cells.every((c) => !c.trim())) continue;
    const get = (c: Col) => { const idx = header.indexOf(c); return idx >= 0 ? cells[idx] ?? '' : ''; };
    const line = i + 1;
    const name = sanitizeText(get('name'), PRODUCT_LIMITS.name);
    if (!name) { rows.push({ line, ok: false, error: 'nome vazio' }); continue; }
    const priceCents = parsePriceToCents(get('price'));
    const promoCents = parsePriceToCents(get('promo'));
    if (Number.isNaN(priceCents)) { rows.push({ line, ok: false, error: `preço inválido: "${get('price').slice(0, 30)}"` }); continue; }
    if (Number.isNaN(promoCents)) { rows.push({ line, ok: false, error: `promoção inválida: "${get('promo').slice(0, 30)}"` }); continue; }
    const st = normalizeStock(get('stock'));
    if (!st) { rows.push({ line, ok: false, error: `estoque inválido: "${get('stock').slice(0, 30)}" (use disponivel, sob encomenda, esgotado ou a quantidade)` }); continue; }
    const link = get('link').trim(), image = get('image').trim();
    if (link && (!isHttpsUrl(link) || link.length > PRODUCT_LIMITS.url)) { rows.push({ line, ok: false, error: 'link precisa começar com https://' }); continue; }
    if (image && (!isHttpsUrl(image) || image.length > PRODUCT_LIMITS.url)) { rows.push({ line, ok: false, error: 'imagem precisa começar com https://' }); continue; }
    rows.push({
      line, ok: true,
      data: {
        name, category: sanitizeText(get('category'), PRODUCT_LIMITS.category) || null,
        priceCents, promoCents,
        description: sanitizeText(get('description'), PRODUCT_LIMITS.description),
        details: sanitizeText(get('details'), PRODUCT_LIMITS.details),
        stock: st.stock, quantity: st.quantity, link: link || null, imageUrl: image || null,
      },
    });
  }
  return { ok: true, rows };
}

/** Busca simples da lista do painel (nome, categoria, detalhes, descrição), sem acento e sem maiúsculas. */
export function filterProducts<T extends ProductLike>(list: T[], q: string): T[] {
  const terms = norm(q) ? q.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/\s+/).filter(Boolean) : [];
  if (!terms.length) return list;
  return list.filter((p) => {
    const hay = [p.name, p.category ?? '', p.details ?? '', p.description ?? ''].join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
