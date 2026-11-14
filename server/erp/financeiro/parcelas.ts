/**
 * Parcelamento de contas a pagar/receber: regras puras, sem Node, usadas pelo servidor e pela tela (prévia).
 *
 * - Datas sempre como texto ISO "AAAA-MM-DD" (sem fuso), para a prévia da tela e o servidor darem o mesmo resultado.
 * - Mensal: mesmo dia do mês do 1º vencimento; se o dia não existir no mês (31 em fevereiro), usa o último dia do mês.
 *   O dia é sempre o do 1º vencimento (31/01 → 28/02 → 31/03), nunca o da parcela anterior.
 * - Valores em centavos: divide igual e a sobra do arredondamento vai na ÚLTIMA parcela; a soma bate exatamente o total.
 */

export const MAX_PARCELAS = 120;

export type Intervalo = { tipo: 'MENSAL' } | { tipo: 'DIAS'; dias: number };
export interface Parcela { parcela: number; parcelas: number; vencimento: string; valorCents: number }

const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number, t = 2) => String(n).padStart(t, '0');
const diasNoMes = (ano: number, mes1a12: number) => new Date(Date.UTC(ano, mes1a12, 0)).getUTCDate();

/** "AAAA-MM-DD" que existe no calendário (recusa 2026-02-30, 2026-13-01...). */
export function isoValida(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = RE_ISO.exec(s);
  if (!m) return false;
  const [a, me, d] = [+m[1], +m[2], +m[3]];
  return a >= 1900 && a <= 2200 && me >= 1 && me <= 12 && d >= 1 && d <= diasNoMes(a, me);
}

/** Soma n meses mantendo o dia; se o dia não existir no mês de destino, usa o último dia desse mês. */
export function somarMeses(iso: string, n: number): string {
  const m = RE_ISO.exec(iso);
  if (!m) throw new Error('Data inválida');
  const total = +m[1] * 12 + (+m[2] - 1) + n;
  const ano = Math.floor(total / 12); const mes = (total % 12) + 1;
  return `${pad(ano, 4)}-${pad(mes)}-${pad(Math.min(+m[3], diasNoMes(ano, mes)))}`;
}

export function somarDias(iso: string, n: number): string {
  const m = RE_ISO.exec(iso);
  if (!m) throw new Error('Data inválida');
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}

/** Divide o total em n partes de centavos inteiros; a sobra vai na última. */
export function dividirCentavos(totalCents: number, n: number): number[] {
  const q = Math.max(1, Math.floor(n));
  const base = Math.floor(totalCents / q);
  return Array.from({ length: q }, (_, i) => (i === q - 1 ? totalCents - base * (q - 1) : base));
}

/** Gera as parcelas: valor total + quantidade + 1º vencimento (+ intervalo, mensal por padrão). */
export function gerarParcelas(totalCents: number, qtd: number, primeiroVencimento: string, intervalo: Intervalo = { tipo: 'MENSAL' }): Parcela[] {
  const n = Math.min(MAX_PARCELAS, Math.max(1, Math.floor(qtd) || 1));
  const valores = dividirCentavos(totalCents, n);
  return valores.map((valorCents, i) => ({
    parcela: i + 1, parcelas: n, valorCents,
    vencimento: intervalo.tipo === 'DIAS' ? somarDias(primeiroVencimento, i * Math.max(1, Math.floor(intervalo.dias))) : somarMeses(primeiroVencimento, i),
  }));
}

/** Confere uma lista de parcelas (gerada ou editada à mão) contra o valor total. */
export function conferirParcelas(lista: { vencimento: string; valorCents: number }[], totalCents: number): { ok: boolean; somaCents: number; diferencaCents: number; erro: string | null } {
  const somaCents = lista.reduce((a, p) => a + (Number.isFinite(p.valorCents) ? p.valorCents : 0), 0);
  const diferencaCents = totalCents - somaCents;
  const erro =
    lista.length < 1 ? 'Informe pelo menos uma parcela.'
    : lista.length > MAX_PARCELAS ? `No máximo ${MAX_PARCELAS} parcelas.`
    : lista.some((p) => !Number.isInteger(p.valorCents) || p.valorCents <= 0) ? 'Toda parcela precisa ter valor maior que zero.'
    : lista.some((p) => !isoValida(p.vencimento)) ? 'Confira as datas de vencimento: alguma está vazia ou não existe.'
    : diferencaCents !== 0 ? 'A soma das parcelas está diferente do valor total.'
    : null;
  return { ok: erro === null, somaCents, diferencaCents, erro };
}
