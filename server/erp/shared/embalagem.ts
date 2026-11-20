/**
 * Unidade de compra (embalagem) × unidade de estoque (v1.32.0) — regra pura, usada pelo servidor e pela web.
 *
 * O estoque fica SEMPRE na unidade base do produto (`ErpProduto.unidade`: peça, kg, metro...). O produto pode ter uma
 * unidade de compra (`unidadeCompra`: pacote, rolo, caixa...) com `fatorCompraMil` = quantas unidades base vêm em
 * cada embalagem, em milésimos (10 peças = 10_000; 2,5 kg = 2_500). Padrão 1000 (1 por embalagem) = sem embalagem.
 *
 * Exemplo: pacote com 10 peças → 5 pacotes = 50 peças; R$ 20,00 o pacote = R$ 2,00 a peça; o total é o mesmo.
 * Preços do pedido de compra continuam por unidade base (o recebimento pela NF-e compara nessa unidade).
 */
import { nomeUnidade, numeroQtd, unidadeLegivel, unidadeValida } from './unidade.js';

/** Unidades que aceitam quantidade quebrada (2,5 kg; 1,75 m). As demais são contadas inteiras. */
export const UNIDADES_DECIMAIS = new Set(['KG', 'G', 'GR', 'MG', 'TON', 'L', 'LT', 'ML', 'M', 'MT', 'CM', 'M2', 'M3']);
export const aceitaDecimal = (u: string | null | undefined) => UNIDADES_DECIMAIS.has(unidadeLegivel(u));

export interface ProdutoEmbalagem { unidade?: string | null; unidadeCompra?: string | null; fatorCompraMil?: number | null }

/** Fator válido (unidades base por embalagem, em milésimos). Vazio, zero, negativo ou absurdo = 1000 (1 por 1). */
export function fatorDe(p: ProdutoEmbalagem | null | undefined): number {
  const f = Number(p?.fatorCompraMil);
  return Number.isFinite(f) && f > 0 && f <= 1_000_000_000 ? Math.round(f) : 1000;
}

/** Tem embalagem de verdade: unidade de compra válida e diferente da base, ou mais de 1 por embalagem. */
export function temEmbalagem(p: ProdutoEmbalagem | null | undefined): boolean {
  if (!p) return false;
  const base = unidadeLegivel(p.unidade);
  const compra = p.unidadeCompra && unidadeValida(p.unidadeCompra) ? p.unidadeCompra.trim().toUpperCase() : null;
  return fatorDe(p) !== 1000 || (!!compra && compra !== base);
}

/** Sigla da unidade de compra (sem embalagem = a própria unidade base). */
export function unidadeCompraDe(p: ProdutoEmbalagem): string {
  return p.unidadeCompra && unidadeValida(p.unidadeCompra) ? p.unidadeCompra.trim().toUpperCase() : unidadeLegivel(p.unidade);
}

/** Embalagens (em milésimos) → unidade base (em milésimos). 5 pacotes × 10 peças = 50 peças. */
export const embalagensParaBase = (embalagensMil: number, fatorMil: number) => Math.round((embalagensMil * fatorMil) / 1000);
/** Unidade base (milésimos) → embalagens (milésimos, pode ser quebrado: 55 peças = 5,5 pacotes). */
export const baseParaEmbalagens = (baseMil: number, fatorMil: number) => Math.round((baseMil * 1000) / Math.max(1, fatorMil));

/** Preço por embalagem → preço por unidade base (centavos, arredondado). R$ 20,00 / 10 peças = R$ 2,00. */
export const precoPorBase = (precoEmbalagemCents: number, fatorMil: number) => Math.round((precoEmbalagemCents * 1000) / Math.max(1, fatorMil));
/** Preço por unidade base → preço por embalagem. R$ 2,00 × 10 peças = R$ 20,00. */
export const precoPorEmbalagem = (precoBaseCents: number, fatorMil: number) => Math.round((precoBaseCents * fatorMil) / 1000);

/**
 * Arredonda uma quantidade da unidade base para comprar: com embalagem, para embalagens inteiras (sempre para cima);
 * sem embalagem, para unidade inteira, ou para 0,1 quando a unidade aceita decimal (kg, metro, litro).
 */
export function arredondarCompra(baseMil: number, p: ProdutoEmbalagem): number {
  if (baseMil <= 0) return 0;
  const f = fatorDe(p);
  if (f !== 1000) return Math.ceil(baseMil / f - 1e-9) * f;
  const passo = aceitaDecimal(p.unidade) ? 100 : 1000;
  return Math.ceil(baseMil / passo - 1e-9) * passo;
}

/** Quantidade com unidade por extenso: "5 pacotes (50 peças)" ou só "50 peças" sem embalagem. */
export function qtdComEmbalagem(baseMil: number, p: ProdutoEmbalagem): string {
  const base = unidadeLegivel(p.unidade);
  const em = (mil: number, u: string) => `${numeroQtd(mil)} ${nomeUnidade(u, mil / 1000)}`;
  if (!temEmbalagem(p)) return em(baseMil, base);
  const emb = baseParaEmbalagens(baseMil, fatorDe(p));
  return `${em(emb, unidadeCompraDe(p))} (${em(baseMil, base)})`;
}

/** "pacote com 10 peças" / "saco com 2,5 kg" (vazio sem embalagem). */
export function descricaoEmbalagem(p: ProdutoEmbalagem): string {
  if (!temEmbalagem(p)) return '';
  const f = fatorDe(p);
  return `${nomeUnidade(unidadeCompraDe(p), 1)} com ${numeroQtd(f)} ${nomeUnidade(p.unidade, f / 1000)}`;
}

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' ');

export interface LinhaCompra {
  quantidade: string;
  /** "R$ 20,00/pacote" (só com embalagem). */
  precoEmbalagem: string | null;
  /** "R$ 2,00/peça". */
  precoBase: string | null;
  totalCents: number;
  /** Frase pronta: "5 pacotes (50 peças) · R$ 20,00/pacote · R$ 2,00/peça · Total R$ 100,00". */
  texto: string;
}

/**
 * Quantidade, preço por embalagem, preço por unidade e total de uma linha de compra. `custoBaseCents` é por unidade
 * base. O total sai de quantidade × preço da embalagem quando a quantidade é de embalagens inteiras (assim bate com o
 * preço do fornecedor, sem erro de arredondamento do preço por peça).
 */
export function linhaCompra(baseMil: number, custoBaseCents: number, p: ProdutoEmbalagem): LinhaCompra {
  const f = fatorDe(p); const emb = temEmbalagem(p);
  const precoEmb = emb ? precoPorEmbalagem(custoBaseCents, f) : null;
  const embMil = baseParaEmbalagens(baseMil, f);
  const totalCents = emb && precoEmb !== null && embMil % 1000 === 0 ? Math.round((embMil * precoEmb) / 1000) : Math.round((baseMil * custoBaseCents) / 1000);
  const quantidade = qtdComEmbalagem(baseMil, p);
  if (!(custoBaseCents > 0)) return { quantidade, precoEmbalagem: null, precoBase: null, totalCents: 0, texto: quantidade };
  const precoEmbalagem = precoEmb !== null ? `${brl(precoEmb)}/${nomeUnidade(unidadeCompraDe(p), 1)}` : null;
  const precoBase = `${brl(custoBaseCents)}/${nomeUnidade(p.unidade, 1)}`;
  return { quantidade, precoEmbalagem, precoBase, totalCents, texto: [quantidade, precoEmbalagem, precoBase, `Total ${brl(totalCents)}`].filter(Boolean).join(' · ') };
}

/** Lê "2,5" / "10" / "1.000,5" digitado → milésimos (0 se inválido). */
export const lerQtdMil = (s: string) => Math.round(Number(String(s).trim().replace(/\./g, '').replace(',', '.')) * 1000) || 0;
