/**
 * Leitura de código (v1.33.0): o que veio do leitor/câmera/teclado → produto e, quando der, o lote.
 * Aceita GS1-128 da etiqueta do lote, QR da etiqueta (MCK1;...), número do lote, código do produto e
 * código de barras do produto (EAN/GTIN, com ou sem zeros à esquerda). Usada no inventário e nas movimentações.
 */
import type { Prisma, PrismaClient, ErpLote, ErpProduto } from '@prisma/client';
import { lerCodigo, variantesBarras } from './codigoLote.js';
import { LOTE_INICIAL, LOTE_SEM_NUMERO } from './rastreio-regras.js';

type Db = Prisma.TransactionClient | PrismaClient;
export interface Resolvido { produto: ErpProduto; lote: ErpLote | null; tipo: 'gs1' | 'qr' | 'simples' }

export async function resolverCodigo(db: Db, orgId: string, codigo: string): Promise<Resolvido | null> {
  const lido = lerCodigo(codigo);
  const pares = [...(lido.lote ? [{ sku: lido.sku, lote: lido.lote }] : []), ...lido.candidatos];
  for (const par of pares) {
    const numero = par.lote.toUpperCase() === LOTE_SEM_NUMERO ? LOTE_INICIAL : par.lote.toUpperCase();
    const lotes = await db.erpLote.findMany({ where: { orgId, numero }, take: 20 });
    if (!lotes.length) continue;
    let lote = lotes[0];
    if (lotes.length > 1 && par.sku) {
      const p = await db.erpProduto.findFirst({ where: { orgId, sku: par.sku.toUpperCase() }, select: { id: true } });
      lote = lotes.find((l) => l.produtoId === p?.id) ?? lote;
    } else if (par.sku && lido.candidatos.length) {
      // GS1 sem separador: só aceita o par se o código do produto também bate.
      const p = await db.erpProduto.findFirst({ where: { orgId, sku: par.sku.toUpperCase() }, select: { id: true } });
      if (!p || p.id !== lote.produtoId) continue;
    }
    const produto = await db.erpProduto.findUniqueOrThrow({ where: { id: lote.produtoId } });
    return { produto, lote, tipo: lido.tipo };
  }
  if (lido.tipo === 'simples') {
    const cod = lido.bruto.toUpperCase();
    const lotes = await db.erpLote.findMany({ where: { orgId, numero: cod === LOTE_SEM_NUMERO ? LOTE_INICIAL : cod }, take: 2 });
    if (lotes.length === 1) return { produto: await db.erpProduto.findUniqueOrThrow({ where: { id: lotes[0].produtoId } }), lote: lotes[0], tipo: 'simples' };
  }
  const sku = (lido.sku ?? lido.bruto).trim();
  if (!sku) return null;
  const produto = await db.erpProduto.findFirst({ where: { orgId, OR: [{ sku: sku.toUpperCase() }, { codigoBarras: { in: variantesBarras(sku) } }] } });
  return produto ? { produto, lote: null, tipo: lido.tipo } : null;
}
