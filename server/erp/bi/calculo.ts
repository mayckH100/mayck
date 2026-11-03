/** Indicadores puros do BI: curva ABC, série por dia, margem, cobertura e CSV. */

export function curvaAbc<T extends { valorCents: number }>(itens: T[], cortes = { a: 0.8, b: 0.95 }) {
  const total = itens.reduce((s, i) => s + Math.max(0, i.valorCents), 0);
  let acum = 0;
  return [...itens].sort((x, y) => y.valorCents - x.valorCents).map((i) => {
    const antes = total ? acum / total : 0;
    acum += Math.max(0, i.valorCents);
    return { ...i, participacao: total ? i.valorCents / total : 0, acumulado: total ? acum / total : 0, classe: antes < cortes.a ? 'A' : antes < cortes.b ? 'B' : 'C' };
  });
}

/** Soma valores por dia (AAAA-MM-DD, fuso de Brasília) cobrindo todo o intervalo, inclusive dias sem movimento. */
export function seriePorDia(pontos: { data: Date; valorCents: number }[], de: Date, ate: Date) {
  const dia = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
  const mapa = new Map<string, number>();
  for (let t = new Date(`${dia(de)}T12:00:00Z`).getTime(); dia(new Date(t)) <= dia(ate); t += 86_400_000) mapa.set(dia(new Date(t)), 0);
  for (const p of pontos) { const k = dia(p.data); if (mapa.has(k)) mapa.set(k, mapa.get(k)! + p.valorCents); }
  return [...mapa].map(([data, valorCents]) => ({ data, valorCents }));
}

export const pctBp = (parte: number, todo: number) => (todo ? Math.round((parte * 10_000) / todo) : 0);

/** Dias de cobertura: valor em estoque ÷ custo médio diário vendido no período. */
export function coberturaDias(valorEstoqueCents: number, cmvCents: number, dias: number) {
  if (cmvCents <= 0 || dias <= 0) return null;
  return Math.round(valorEstoqueCents / (cmvCents / dias));
}

export function csv(cabecalho: string[], linhas: (string | number | null)[][]) {
  const c = (v: string | number | null) => { const s = v === null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '\uFEFF' + [cabecalho, ...linhas].map((l) => l.map(c).join(';')).join('\r\n');
}
