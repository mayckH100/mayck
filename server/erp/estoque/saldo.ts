/**
 * Regras puras de saldo e alocação (sem banco). Testadas em tests/unit/erp-estoque-vendas.test.ts.
 * Quantidades em milésimos.
 */
export interface SaldoLinha {
  id: string; loteId: string; enderecoId: string;
  fisicoMil: number; reservadoMil: number; quarentenaMil: number;
  lote: { numero: string; status: string; validade: Date | null; createdAt: Date };
}

export const disponivel = (s: Pick<SaldoLinha, 'fisicoMil' | 'reservadoMil' | 'quarentenaMil'>) => Math.max(0, s.fisicoMil - s.reservadoMil - s.quarentenaMil);

/** Ordem de saída: FEFO (vence primeiro sai primeiro; sem validade vai para o fim) ou FIFO (lote mais antigo). */
export function ordenarSaida<T extends SaldoLinha>(saldos: T[], regra: string): T[] {
  const t = (d: Date | null) => (d ? d.getTime() : Number.MAX_SAFE_INTEGER);
  return [...saldos].sort((a, b) =>
    regra === 'FEFO'
      ? t(a.lote.validade) - t(b.lote.validade) || a.lote.createdAt.getTime() - b.lote.createdAt.getTime()
      : a.lote.createdAt.getTime() - b.lote.createdAt.getTime() || a.lote.numero.localeCompare(b.lote.numero));
}

export interface Alocacao { saldoId: string; loteId: string; enderecoId: string; qtdMil: number }

/**
 * Planeja de onde sai a quantidade: só lotes LIBERADOS e não vencidos, na ordem da regra.
 * Retorna as alocações e quanto faltou (0 = atendido por completo).
 */
export function planejarAlocacao(saldos: SaldoLinha[], qtdMil: number, regra: string, hoje = new Date()): { alocacoes: Alocacao[]; faltaMil: number } {
  const aptos = saldos.filter((s) => s.lote.status === 'LIBERADO' && !(s.lote.validade && s.lote.validade.getTime() < hoje.getTime()) && disponivel(s) > 0);
  const alocacoes: Alocacao[] = [];
  let resta = qtdMil;
  for (const s of ordenarSaida(aptos, regra)) {
    if (resta <= 0) break;
    const q = Math.min(resta, disponivel(s));
    alocacoes.push({ saldoId: s.id, loteId: s.loteId, enderecoId: s.enderecoId, qtdMil: q });
    resta -= q;
  }
  return { alocacoes, faltaMil: Math.max(0, resta) };
}

/** Custo médio ponderado após uma entrada (centavos por unidade). */
export function novoCustoMedio(saldoAtualMil: number, custoAtualCents: number, entradaMil: number, custoEntradaCents: number) {
  const base = Math.max(0, saldoAtualMil);
  const total = base + entradaMil;
  if (total <= 0) return custoEntradaCents;
  return Math.round((base * custoAtualCents + entradaMil * custoEntradaCents) / total);
}
