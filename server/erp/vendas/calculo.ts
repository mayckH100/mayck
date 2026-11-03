/** Cálculo puro do pedido: totais por item, desconto, alçada e crédito. */
export interface ItemCalc { qtdMil: number; precoUnitCents: number; descontoBp: number }

export const totalItem = (i: ItemCalc) => Math.round(((i.qtdMil * i.precoUnitCents) / 1000) * (1 - i.descontoBp / 10_000));

export function totalizar(itens: ItemCalc[], descontoCents = 0, freteCents = 0) {
  const bruto = itens.reduce((a, i) => a + Math.round((i.qtdMil * i.precoUnitCents) / 1000), 0);
  const liquidoItens = itens.reduce((a, i) => a + totalItem(i), 0);
  const descontoTotal = bruto - liquidoItens + descontoCents;
  const totalCents = Math.max(0, liquidoItens - descontoCents + freteCents);
  // desconto efetivo do pedido inteiro, em pontos-base sobre o bruto
  const descontoEfetivoBp = bruto > 0 ? Math.round((descontoTotal / bruto) * 10_000) : 0;
  return { subtotalCents: bruto, descontoCents: descontoTotal, totalCents, descontoEfetivoBp };
}

/** Escolhe o preço da tabela pela maior faixa de volume que a quantidade alcança. */
export function precoPorVolume(faixas: { qtdMinimaMil: number; precoCents: number }[], qtdMil: number, precoBase: number) {
  const f = faixas.filter((x) => qtdMil >= x.qtdMinimaMil).sort((a, b) => b.qtdMinimaMil - a.qtdMinimaMil)[0];
  return f ? f.precoCents : precoBase;
}

/** Motivos de bloqueio na aprovação (vazio = aprova direto). */
export function motivosBloqueio(p: { descontoEfetivoBp: number; totalCents: number }, regras: { descontoMaxBp: number; bloquearSemCredito: boolean },
  cliente: { status: string; limiteCreditoCents: number; emAbertoCents: number }) {
  const m: string[] = [];
  if (cliente.status === 'BLOQUEADO') m.push('Cliente bloqueado');
  if (p.descontoEfetivoBp > regras.descontoMaxBp) m.push(`Desconto de ${(p.descontoEfetivoBp / 100).toFixed(1)}% acima da alçada (${(regras.descontoMaxBp / 100).toFixed(1)}%)`);
  if (regras.bloquearSemCredito && cliente.limiteCreditoCents > 0 && cliente.emAbertoCents + p.totalCents > cliente.limiteCreditoCents) m.push('Limite de crédito insuficiente');
  return m;
}
