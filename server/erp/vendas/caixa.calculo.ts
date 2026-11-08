/**
 * Caixa do PDV — contas puras (sem banco), usadas na tela, no fechamento e nos testes.
 * Esperado em dinheiro = abertura + vendas em dinheiro + suprimentos − sangrias. Diferença = contado − esperado.
 */
export const FORMAS_CAIXA = ['DINHEIRO', 'PIX', 'CARTAO'] as const;
export type TotaisPorForma = Record<string, { qtd: number; valorCents: number }>;

export interface EntradaResumo {
  aberturaCents: number;
  recebimentos: { forma: string; valorCents: number }[];
  movimentos: { tipo: string; valorCents: number }[];
}

export interface ResumoCaixa {
  aberturaCents: number;
  porForma: TotaisPorForma;
  qtdVendas: number;
  totalVendasCents: number;
  vendasDinheiroCents: number;
  sangriasCents: number;
  suprimentosCents: number;
  esperadoDinheiroCents: number;
}

export function resumoCaixa(e: EntradaResumo): ResumoCaixa {
  const porForma: TotaisPorForma = {};
  for (const f of FORMAS_CAIXA) porForma[f] = { qtd: 0, valorCents: 0 };
  for (const r of e.recebimentos) {
    const k = porForma[r.forma] ? r.forma : r.forma || 'OUTRA';
    porForma[k] = porForma[k] ?? { qtd: 0, valorCents: 0 };
    porForma[k].qtd += 1;
    porForma[k].valorCents += r.valorCents;
  }
  const soma = (tipo: string) => e.movimentos.filter((m) => m.tipo === tipo).reduce((a, m) => a + m.valorCents, 0);
  const sangriasCents = soma('SANGRIA');
  const suprimentosCents = soma('SUPRIMENTO');
  const vendasDinheiroCents = porForma.DINHEIRO.valorCents;
  const totalVendasCents = Object.values(porForma).reduce((a, f) => a + f.valorCents, 0);
  return {
    aberturaCents: e.aberturaCents,
    porForma,
    qtdVendas: e.recebimentos.length,
    totalVendasCents,
    vendasDinheiroCents,
    sangriasCents,
    suprimentosCents,
    esperadoDinheiroCents: e.aberturaCents + vendasDinheiroCents + suprimentosCents - sangriasCents,
  };
}

export type SituacaoCaixa = 'CONFERE' | 'SOBRA' | 'FALTA';

export function diferencaCaixa(contadoCents: number, esperadoCents: number): { diferencaCents: number; situacao: SituacaoCaixa } {
  const diferencaCents = contadoCents - esperadoCents;
  return { diferencaCents, situacao: diferencaCents === 0 ? 'CONFERE' : diferencaCents > 0 ? 'SOBRA' : 'FALTA' };
}

/** Fechamento: diferença diferente de zero exige justificativa. Devolve a mensagem de erro ou null. */
export function validarFechamento(contadoCents: number, esperadoCents: number, observacao?: string | null): string | null {
  if (!Number.isInteger(contadoCents) || contadoCents < 0) return 'Informe o dinheiro contado no caixa';
  const { diferencaCents, situacao } = diferencaCaixa(contadoCents, esperadoCents);
  if (diferencaCents !== 0 && !(observacao ?? '').trim()) return `Há ${situacao === 'SOBRA' ? 'sobra' : 'falta'} no caixa: explique a diferença na observação`;
  return null;
}
