/**
 * Inventário v1.33.0 — relatório Físico x Sistema (puro, sem banco; testado em tests/unit/erp-inventario-relatorio.test.ts).
 * Por produto, lote e local: contado, sistema, diferença em quantidade e em R$ (custo por unidade no fechamento).
 * Totais: itens contados, itens com diferença, sobras (R$), faltas (R$), valor líquido e a maior divergência.
 */
import { qtdUn } from '../shared/unidade.js';

export interface LinhaInventario {
  id: string; produtoId: string; sku: string; nome: string; unidade: string;
  loteId: string; lote: string; loteFornecedor: string | null; local: string;
  sistemaMil: number; contadoMil: number | null; custoUnitCents: number; leituras?: number; modo?: string | null;
}
export interface LinhaRelatorio extends LinhaInventario { contadoFinalMil: number; diferencaMil: number; diferencaCents: number; situacao: 'ok' | 'sobra' | 'falta' }
export interface TotaisInventario {
  linhas: number; divergentes: number; sobras: number; faltas: number;
  sobrasCents: number; faltasCents: number; liquidoCents: number;
  maior: { sku: string; nome: string; lote: string; local: string; diferencaMil: number; diferencaCents: number; unidade: string } | null;
}

/** Linha não contada conta como zero (inventário geral). Diferença = contado − sistema; R$ = diferença × custo. */
export function relatorioInventario(linhas: LinhaInventario[]): { linhas: LinhaRelatorio[]; totais: TotaisInventario } {
  const out: LinhaRelatorio[] = linhas.map((l) => {
    const contadoFinalMil = l.contadoMil ?? 0;
    const diferencaMil = contadoFinalMil - l.sistemaMil;
    const diferencaCents = Math.round((diferencaMil * l.custoUnitCents) / 1000);
    return { ...l, contadoFinalMil, diferencaMil, diferencaCents, situacao: (diferencaMil > 0 ? 'sobra' : diferencaMil < 0 ? 'falta' : 'ok') as LinhaRelatorio['situacao'] };
  }).sort((a, b) => a.nome.localeCompare(b.nome) || a.lote.localeCompare(b.lote) || a.local.localeCompare(b.local));
  const div = out.filter((l) => l.diferencaMil !== 0);
  const sobrasCents = div.filter((l) => l.diferencaMil > 0).reduce((a, l) => a + l.diferencaCents, 0);
  const faltasCents = div.filter((l) => l.diferencaMil < 0).reduce((a, l) => a - l.diferencaCents, 0);
  // Maior divergência: pelo valor em R$; empate (ou custo zero) pela quantidade.
  const maior = [...div].sort((a, b) => Math.abs(b.diferencaCents) - Math.abs(a.diferencaCents) || Math.abs(b.diferencaMil) - Math.abs(a.diferencaMil))[0];
  return {
    linhas: out,
    totais: {
      linhas: out.length, divergentes: div.length, sobras: div.filter((l) => l.diferencaMil > 0).length, faltas: div.filter((l) => l.diferencaMil < 0).length,
      sobrasCents, faltasCents, liquidoCents: sobrasCents - faltasCents,
      maior: maior ? { sku: maior.sku, nome: maior.nome, lote: maior.lote, local: maior.local, diferencaMil: maior.diferencaMil, diferencaCents: maior.diferencaCents, unidade: maior.unidade } : null,
    },
  };
}

export const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' ');
const sinal = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '');

/** Resumo curto para o proprietário (WhatsApp/e-mail/app): quantos itens, maior divergência e valor total. */
export function resumoDivergencia(descricao: string, t: TotaisInventario): string {
  const m = t.maior;
  return [
    `📋 Inventário "${descricao}" encerrado com diferença.`,
    `• Itens com diferença: *${t.divergentes}* de ${t.linhas} (${t.sobras} com sobra, ${t.faltas} com falta)`,
    m ? `• Maior diferença: *${m.nome}* (cód. ${m.sku}), lote ${m.lote}, ${m.local}: ${sinal(m.diferencaMil)}${qtdUn(Math.abs(m.diferencaMil), m.unidade)} (${sinal(m.diferencaCents)}*${reais(Math.abs(m.diferencaCents))}*)` : '',
    `• Sobras: ${reais(t.sobrasCents)} · Faltas: ${reais(t.faltasCents)}`,
    `• Valor líquido: *${sinal(t.liquidoCents)}${reais(Math.abs(t.liquidoCents))}* (preço de custo)`,
    'O estoque só muda depois que você aprovar com a sua senha em MCK ERP › Estoque › Inventário.',
  ].filter(Boolean).join('\n');
}

const cel = (v: unknown) => { const s = v == null ? '' : String(v); const x = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s; return /[;"\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
const n3 = (mil: number) => (mil / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const n2 = (c: number) => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** CSV do relatório Físico x Sistema (";" e BOM, abre direto no Excel). */
export function csvInventario(descricao: string, r: { linhas: LinhaRelatorio[]; totais: TotaisInventario }): string {
  const L = [[`Inventário`, descricao], [], ['Código', 'Produto', 'Lote interno', 'Lote do fornecedor', 'Local', 'Unidade', 'Sistema', 'Contado', 'Diferença', 'Custo por unidade (R$)', 'Diferença (R$)', 'Situação']];
  for (const l of r.linhas) L.push([l.sku, l.nome, l.lote, l.loteFornecedor ?? '', l.local, l.unidade, n3(l.sistemaMil), n3(l.contadoFinalMil), n3(l.diferencaMil), n2(l.custoUnitCents), n2(l.diferencaCents), { ok: 'Confere', sobra: 'Sobra', falta: 'Falta' }[l.situacao]]);
  const t = r.totais;
  L.push([], ['Itens', String(t.linhas)], ['Itens com diferença', String(t.divergentes)], ['Sobras (R$)', n2(t.sobrasCents)], ['Faltas (R$)', n2(t.faltasCents)], ['Valor líquido (R$)', n2(t.liquidoCents)]);
  return '\uFEFF' + L.map((c) => c.map(cel).join(';')).join('\r\n') + '\r\n';
}
