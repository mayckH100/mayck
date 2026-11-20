/**
 * "O que comprar" (v1.32.0) — cálculo puro da quantidade sugerida, usado pela tela Compras › O que comprar e pelo
 * alerta diário do WhatsApp (mesma regra nos dois).
 *
 * Fórmula: saída média por dia (vendas, baixas e consumo da produção nos últimos 30 dias; se não houve saída, 90 dias;
 * sem saída nenhuma, só o mínimo) × dias de cobertura (padrão 30 + prazo do fornecedor) − o que tem hoje − o que já
 * foi pedido e não chegou; nunca menos que o necessário para voltar ao mínimo; respeita o lote mínimo e arredonda
 * para cima (embalagem inteira, unidade inteira ou 0,1 kg/m/l).
 */
import { arredondarCompra, fatorDe, type ProdutoEmbalagem } from '../shared/embalagem.js';
import { nomeUnidade, numeroQtd } from '../shared/unidade.js';

export const JANELA_CURTA = 30;
export const JANELA_LONGA = 90;
/** Produto novo: a média nunca é dividida por menos de 7 dias (uma venda de 10 no 1º dia não vira "10 por dia"). */
export const JANELA_MINIMA = 7;
export const COBERTURA_PADRAO = 30;

export type BaseConsumo = '30d' | '90d' | 'minimo';

export interface EntradaJanela { saidasCurtaMil: number; saidasLongaMil: number; idadeDias: number; janelaCurta?: number; janelaLonga?: number }

/** Escolhe de onde vem a média: 30 dias; sem saída neles, 90 dias; sem saída nenhuma, só o mínimo. */
export function escolherJanela(e: EntradaJanela): { consumoMil: number; janelaDias: number; base: BaseConsumo } {
  const curta = Math.max(1, e.janelaCurta ?? JANELA_CURTA);
  const longa = Math.max(curta, e.janelaLonga ?? JANELA_LONGA);
  const idade = Math.max(0, Math.floor(e.idadeDias));
  const efetiva = (j: number) => Math.min(j, Math.max(JANELA_MINIMA, idade));
  if (e.saidasCurtaMil > 0) return { consumoMil: e.saidasCurtaMil, janelaDias: efetiva(curta), base: '30d' };
  if (e.saidasLongaMil > 0) return { consumoMil: e.saidasLongaMil, janelaDias: efetiva(longa), base: '90d' };
  return { consumoMil: 0, janelaDias: curta, base: 'minimo' };
}

export interface EntradaCompra extends ProdutoEmbalagem {
  saldoMil: number; minimoMil: number;
  /** Saídas somadas na janela escolhida (positivo) e o tamanho da janela em dias. */
  consumoMil: number; janelaDias: number;
  coberturaDias?: number; leadTimeDias?: number; loteMinimoMil?: number;
  /** Já pedido ao fornecedor e ainda não recebido (unidade base). */
  aCaminhoMil?: number;
  base?: BaseConsumo;
}

export interface ResultadoCompra {
  base: BaseConsumo;
  /** Sem nenhuma unidade hoje. */
  zerado: boolean;
  /** Saída média por dia (milésimos da unidade base; pode ser quebrado). */
  consumoDiaMil: number;
  /** Dias que o estoque de hoje dura (null = sem saída para estimar). */
  duraDias: number | null;
  /** Dias que a compra deve cobrir (cobertura + prazo do fornecedor). */
  coberturaTotalDias: number;
  /** Quanto falta para voltar ao mínimo (antes de descontar o que já foi pedido). */
  faltaMinimoMil: number;
  /** Necessidade pelo consumo (consumo/dia × dias de cobertura). */
  necessidadeMil: number;
  aCaminhoMil: number;
  /** Quantidade sugerida (unidade base, já arredondada). 0 = o que já foi pedido cobre. */
  sugeridaMil: number;
  /** Motivo do arredondamento acima do calculado, quando houver. */
  ajuste: 'lote_minimo' | 'embalagem' | null;
}

export function calcularCompra(e: EntradaCompra): ResultadoCompra {
  const saldo = Math.max(0, e.saldoMil);
  const minimo = Math.max(0, e.minimoMil);
  const aCaminho = Math.max(0, e.aCaminhoMil ?? 0);
  const consumoDiaMil = e.janelaDias > 0 ? Math.max(0, e.consumoMil) / e.janelaDias : 0;
  const coberturaTotalDias = Math.max(1, e.coberturaDias ?? COBERTURA_PADRAO) + Math.max(0, e.leadTimeDias ?? 0);
  const necessidadeMil = Math.ceil(consumoDiaMil * coberturaTotalDias);
  const faltaMinimoMil = Math.max(0, minimo - saldo);
  const duraDias = consumoDiaMil > 0 ? Math.floor(saldo / consumoDiaMil) : null;
  const bruta = Math.max(necessidadeMil - saldo - aCaminho, minimo - saldo - aCaminho, 0);
  let sug = bruta;
  let ajuste: ResultadoCompra['ajuste'] = null;
  if (sug > 0 && (e.loteMinimoMil ?? 0) > sug) { sug = e.loteMinimoMil!; ajuste = 'lote_minimo'; }
  const arred = arredondarCompra(sug, e);
  if (arred > sug && ajuste === null && fatorDe(e) !== 1000) ajuste = 'embalagem';
  const base = e.base ?? (consumoDiaMil > 0 ? '30d' : 'minimo');
  return { base, zerado: saldo <= 0, consumoDiaMil, duraDias, coberturaTotalDias, faltaMinimoMil, necessidadeMil, aCaminhoMil: aCaminho, sugeridaMil: arred, ajuste };
}

/** Entra na lista? Zerado (com mínimo ou com saída nos 90 dias) ou abaixo do mínimo. */
export function precisaComprar(saldoMil: number, minimoMil: number, saidasLongaMil: number): boolean {
  if (minimoMil > 0 && saldoMil < minimoMil) return true;
  return saldoMil <= 0 && (minimoMil > 0 || saidasLongaMil > 0);
}

/** Ordem: zerados primeiro; depois quem acaba antes (dias de cobertura); depois o mais longe do mínimo. */
export function compararUrgencia(a: { saldoMil: number; minimoMil: number; duraDias: number | null; nome?: string }, b: typeof a): number {
  const z = (x: typeof a) => (x.saldoMil <= 0 ? 0 : 1);
  if (z(a) !== z(b)) return z(a) - z(b);
  const d = (x: typeof a) => (x.duraDias === null ? Number.POSITIVE_INFINITY : x.duraDias);
  if (d(a) !== d(b)) return d(a) - d(b);
  const r = (x: typeof a) => (x.minimoMil > 0 ? x.saldoMil / x.minimoMil : 1);
  if (r(a) !== r(b)) return r(a) - r(b);
  return (a.nome ?? '').localeCompare(b.nome ?? '', 'pt-BR');
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

/** Saída média legível: "~2 unidades por dia" ou, se for menos de 1 por dia, "~6 unidades por mês". */
export function saidaMediaTexto(consumoDiaMil: number, unidade: string): string {
  if (consumoDiaMil <= 0) return 'sem saída';
  if (consumoDiaMil >= 1000) {
    const v = Math.round(consumoDiaMil / 100) * 100; // 1 casa
    return `~${numeroQtd(v)} ${nomeUnidade(unidade, v / 1000)} por dia`;
  }
  const mes = Math.max(100, Math.round((consumoDiaMil * 30) / 100) * 100);
  return `~${numeroQtd(mes)} ${nomeUnidade(unidade, mes / 1000)} por mês`;
}

/** O porquê da sugestão, em uma linha curta (sem dois números lado a lado). */
export function motivoCurto(r: ResultadoCompra, unidade: string, extra: { loteMinimoMil?: number; leadTimeDias?: number; apenasQuantidade?: boolean } = {}): string {
  const partes: string[] = [];
  if (r.consumoDiaMil > 0) {
    if (!extra.apenasQuantidade) partes.push(`vende ${saidaMediaTexto(r.consumoDiaMil, unidade)}${r.base === '90d' ? ' (média de 90 dias)' : ''}`);
    if (!extra.apenasQuantidade) partes.push(r.zerado ? 'já acabou' : r.duraDias === null ? '' : r.duraDias <= 0 ? 'acaba hoje' : `dura ${plural(r.duraDias, 'dia', 'dias')}`);
    const necessidadeVence = r.necessidadeMil >= Math.max(0, r.faltaMinimoMil);
    partes.push(necessidadeVence ? `compra para ${plural(r.coberturaTotalDias, 'dia', 'dias')}${extra.leadTimeDias ? ' (inclui o prazo do fornecedor)' : ''}` : 'completa o estoque mínimo');
  } else {
    partes.push(extra.apenasQuantidade ? '' : 'sem vendas nos últimos 90 dias', r.faltaMinimoMil > 0 ? 'completa o estoque mínimo' : '');
  }
  if (r.aCaminhoMil > 0) partes.push(r.sugeridaMil > 0 ? `desconta ${numeroQtd(r.aCaminhoMil)} ${nomeUnidade(unidade, r.aCaminhoMil / 1000)} já ${r.aCaminhoMil < 2000 ? 'pedida' : 'pedidas'}` : 'o que já foi pedido cobre');
  if (r.ajuste === 'lote_minimo') partes.push('arredondado para o lote mínimo');
  if (r.ajuste === 'embalagem') partes.push('arredondado para embalagem inteira');
  return partes.filter(Boolean).join(', ');
}
