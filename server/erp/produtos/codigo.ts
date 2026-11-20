/**
 * Código do produto (SKU) automático — v1.31.0.
 *
 * Todo produto novo sem código recebe um código sequencial da empresa. O padrão segue o que a empresa já usa
 * (ex.: tem MCK0001 → o próximo é MCK0002); sem nenhum, começa em P0001. Códigos existentes nunca mudam.
 * Seguro contra corrida: o banco já tem código único por empresa (@@unique orgId+sku); se dois cadastros pegarem
 * o mesmo número ao mesmo tempo, o segundo recebe o erro de único e tenta o próximo número.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest } from '../../lib/http.js';

type Db = Pick<Prisma.TransactionClient, 'erpProduto'>;

export const PADRAO_SKU = { prefixo: 'P', largura: 4 };
const RE = /^([A-Z]{1,6})(\d{3,8})$/;

/** Padrão mais usado pela empresa (prefixo de letras + número com zeros), ou P0001. */
export function padraoSku(skus: string[]): { prefixo: string; largura: number } {
  const cont = new Map<string, { n: number; largura: number }>();
  for (const s of skus) {
    const m = RE.exec(s.toUpperCase());
    if (!m) continue;
    const c = cont.get(m[1]) ?? { n: 0, largura: m[2].length };
    c.n++; c.largura = Math.max(c.largura, m[2].length);
    cont.set(m[1], c);
  }
  let melhor: { prefixo: string; largura: number; n: number } | null = null;
  for (const [prefixo, c] of cont) if (!melhor || c.n > melhor.n) melhor = { prefixo, largura: c.largura, n: c.n };
  return melhor ? { prefixo: melhor.prefixo, largura: melhor.largura } : { ...PADRAO_SKU };
}

/** Maior número já usado com o prefixo + 1 (+ `pular`, para tentar o seguinte após uma colisão). */
export function proximoDaLista(skus: string[], prefixo: string, largura: number, pular = 0): string {
  let max = 0;
  for (const s of skus) {
    const m = RE.exec(s.toUpperCase());
    if (m && m[1] === prefixo) max = Math.max(max, Number(m[2]));
  }
  return `${prefixo}${String(max + 1 + pular).padStart(largura, '0')}`;
}

/** Próximo código livre da empresa. */
export async function proximoSku(orgId: string, db: Db = prisma, pular = 0): Promise<string> {
  const skus = (await db.erpProduto.findMany({ where: { orgId }, select: { sku: true } })).map((p) => p.sku);
  const { prefixo, largura } = padraoSku(skus);
  return proximoDaLista(skus, prefixo, largura, pular);
}

const ehSkuDuplicado = (e: unknown) => {
  const x = e as { code?: string; meta?: { target?: unknown } };
  return x?.code === 'P2002' && JSON.stringify(x.meta?.target ?? '').toLowerCase().includes('sku');
};

/**
 * Cria com código automático quando `sku` vem vazio. `criar(sku)` faz o insert; se outro cadastro levou o mesmo
 * número ao mesmo tempo, tenta o seguinte (até 8 vezes). Com `sku` informado, só cria (duplicado → erro claro).
 */
export async function criarComSku<T>(orgId: string, sku: string | null | undefined, criar: (sku: string) => Promise<T>, db: Db = prisma): Promise<{ sku: string; resultado: T; automatico: boolean }> {
  if (sku) {
    try { return { sku, resultado: await criar(sku), automatico: false }; }
    catch (e) { if (ehSkuDuplicado(e)) throw badRequest(`Código ${sku} já existe`); throw e; }
  }
  let pular = 0; let ultimo = '';
  for (let t = 0; t < 8; t++) {
    let novo = await proximoSku(orgId, db, pular);
    if (novo === ultimo) novo = await proximoSku(orgId, db, ++pular); // o outro cadastro ainda não aparece: pula um
    ultimo = novo;
    try { return { sku: novo, resultado: await criar(novo), automatico: true }; }
    catch (e) { if (!ehSkuDuplicado(e)) throw e; }
  }
  throw badRequest('Não foi possível gerar o código do produto agora; tente de novo');
}
