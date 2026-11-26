/**
 * v1.55.0 — "📄 Exportar PDF" e "🖨️ Imprimir / PDF" de qualquer lista, ficha ou export do MCK ERP (puro, sem DOM:
 * testado em tests/unit/impressao-listas.test.ts). Cada gerador devolve um Documento para o `imprimir` de ./cabecalho, que
 * põe o cabeçalho da empresa (layout esquerda/centro) e o rodapé fixo da MCK.
 *  - htmlTabela: título, filtros, data de geração e a tabela; com muitas colunas sai em paisagem e com letra menor.
 *  - htmlFicha: dados salvos de um cadastro (rótulo → valor) + tabelas opcionais.
 *  - htmlDeCsv: o MESMO conteúdo do arquivo de exportação (CSV com ";" do servidor), bloco a bloco.
 * Tudo que vem do usuário/servidor passa por `esc`.
 */
import { esc, type Orientacao } from './modelo';
import type { Documento } from './cabecalho';

/** "dd/mm/aaaa hh:mm" no fuso de São Paulo. */
export const geradoEmSP = (d: Date = new Date()) =>
  `${d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ${d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}`;

/** Linha "filtros · Gerado em …" (texto puro; o modelo escapa). */
export function linhaFiltros(filtros: (string | false | null | undefined)[], agora: Date = new Date()) {
  const f = filtros.map((x) => String(x || '').trim()).filter(Boolean);
  return [...f, `Gerado em ${geradoEmSP(agora)}`].join(' · ');
}

/** Acima disso a tabela sai em A4 deitado (paisagem) e com letra menor. */
export const COLUNAS_PAISAGEM = 7;
export const orientacaoPara = (colunas: number): Orientacao => (colunas > COLUNAS_PAISAGEM ? 'paisagem' : 'retrato');

export interface Coluna<T> { titulo: string; valor: (r: T) => unknown; dir?: boolean }
export interface Tabela<T = any> { titulo?: string; colunas: Coluna<T>[]; linhas: T[]; vazio?: string }

const celula = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : esc(v));

/** Tabela HTML com thead (repetido em cada página na impressão). */
export function tabelaHtml<T>(t: Tabela<T>) {
  const cab = t.titulo ? `<h2>${esc(t.titulo)}</h2>` : '';
  if (!t.linhas.length) return `${cab}<p class="small">${esc(t.vazio ?? 'Nada para mostrar com estes filtros.')}</p>`;
  const th = t.colunas.map((c) => `<th${c.dir ? ' class="dir"' : ''}>${esc(c.titulo)}</th>`).join('');
  const tr = t.linhas.map((r) => `<tr>${t.colunas.map((c) => `<td${c.dir ? ' class="dir"' : ''}>${celula(c.valor(r))}</td>`).join('')}</tr>`).join('');
  return `${cab}<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

export interface DefLista<T> { titulo: string; filtros?: (string | false | null | undefined)[]; colunas: Coluna<T>[]; linhas: T[]; total?: string; vazio?: string; extras?: Tabela[]; arquivo?: string }

/** Lista (cadastro ou relatório) com os filtros/busca atuais da tela. */
export function htmlTabela<T>(d: DefLista<T>, agora: Date = new Date()): Documento {
  const largura = Math.max(d.colunas.length, ...(d.extras ?? []).map((x) => x.colunas.length));
  const qtd = `${d.linhas.length} registro(s)`;
  const corpo = tabelaHtml({ colunas: d.colunas, linhas: d.linhas, vazio: d.vazio })
    + (d.total ? `<div class="tot"><b>${esc(d.total)}</b></div>` : '')
    + (d.extras ?? []).map((x) => tabelaHtml(x)).join('');
  return { titulo: d.titulo, subtitulo: linhaFiltros([...(d.filtros ?? []), qtd], agora), corpo, orientacao: orientacaoPara(largura), arquivo: d.arquivo, css: largura > COLUNAS_PAISAGEM ? 'table{font-size:.92em}' : undefined };
}

export type Campo = [string, unknown];
export interface Secao { titulo?: string; campos: Campo[] }

/** Ficha de um cadastro (dados salvos). Campos vazios não aparecem. */
export function htmlFicha(d: { titulo: string; subtitulo?: string; secoes: Secao[]; tabelas?: Tabela[]; observacoes?: string; arquivo?: string }, agora: Date = new Date()): Documento {
  const secoes = d.secoes.map((s) => {
    const campos = s.campos.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '');
    if (!campos.length) return '';
    return `${s.titulo ? `<h2>${esc(s.titulo)}</h2>` : ''}<table class="mck-ficha"><tbody>${campos.map(([l, v]) => `<tr><th>${esc(l)}</th><td>${esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}</tbody></table>`;
  }).join('');
  const tabelas = (d.tabelas ?? []).map((t) => tabelaHtml(t)).join('');
  const largura = Math.max(0, ...(d.tabelas ?? []).map((t) => t.colunas.length));
  const obs = d.observacoes?.trim() ? `<h2>Observações</h2><p>${esc(d.observacoes.trim()).replace(/\n/g, '<br>')}</p>` : '';
  return { titulo: d.titulo, subtitulo: linhaFiltros([d.subtitulo], agora), corpo: secoes + tabelas + obs, orientacao: orientacaoPara(largura), arquivo: d.arquivo, css: '.mck-ficha th{width:34%;background:#f9fafb;font-weight:600}' };
}

/** Lê o CSV do servidor (";" ou ",", aspas, BOM, CRLF). */
export function lerCsv(texto: string): string[][] {
  const t = texto.replace(/^\uFEFF/, '');
  const sep = (t.split(/\r?\n/, 1)[0].match(/;/g)?.length ?? 0) >= (t.split(/\r?\n/, 1)[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const linhas: string[][] = []; let linha: string[] = []; let cel = ''; let aspas = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (aspas) {
      if (ch === '"' && t[i + 1] === '"') { cel += '"'; i++; } else if (ch === '"') aspas = false; else cel += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === sep) { linha.push(cel); cel = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      linha.push(cel); linhas.push(linha); linha = []; cel = '';
    } else cel += ch;
  }
  if (cel !== '' || linha.length) { linha.push(cel); linhas.push(linha); }
  // Proteção anti-fórmula do export (aspa simples no início) não precisa aparecer no PDF.
  return linhas.map((l) => l.map((c) => (/^'[=+@-]/.test(c) ? c.slice(1) : c)));
}

/** Blocos separados por linha em branco: bloco de 1–2 colunas vira ficha (rótulo → valor); o resto vira tabela (1ª linha = cabeçalho). */
export function blocosCsv(linhas: string[][]) {
  const blocos: string[][][] = []; let atual: string[][] = [];
  for (const l of linhas) {
    if (l.every((c) => c.trim() === '')) { if (atual.length) blocos.push(atual); atual = []; } else atual.push(l);
  }
  if (atual.length) blocos.push(atual);
  return blocos;
}

/** PDF com o mesmo conteúdo do arquivo de exportação (CSV), título, filtros e data de geração. */
export function htmlDeCsv(d: { titulo: string; filtros?: (string | false | null | undefined)[]; csv: string; arquivo?: string }, agora: Date = new Date()): Documento {
  const blocos = blocosCsv(lerCsv(d.csv));
  let largura = 0; let registros = 0;
  const corpo = blocos.map((b) => {
    const cols = Math.max(...b.map((l) => l.length));
    if (cols <= 2) return `<table class="mck-ficha"><tbody>${b.map((l) => `<tr><th>${esc(l[0])}</th><td>${celula(l[1])}</td></tr>`).join('')}</tbody></table>`;
    largura = Math.max(largura, cols); registros += b.length - 1;
    const [cab, ...resto] = b;
    const th = Array.from({ length: cols }, (_, i) => `<th>${esc(cab[i] ?? '')}</th>`).join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${resto.map((l) => `<tr>${Array.from({ length: cols }, (_, i) => `<td>${celula(l[i])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }).join('') || '<p class="small">O arquivo de exportação veio vazio.</p>';
  return { titulo: d.titulo, subtitulo: linhaFiltros([...(d.filtros ?? []), largura ? `${registros} registro(s)` : ''], agora), corpo, orientacao: orientacaoPara(largura), arquivo: d.arquivo,
    css: `.mck-ficha{width:auto;min-width:50%}.mck-ficha th{background:#f9fafb;font-weight:600;padding-right:12px}${largura > COLUNAS_PAISAGEM ? 'table{font-size:.9em}' : ''}` };
}

/** Atalhos de formatação para as colunas (texto puro). */
export const fmt = {
  brl: (c: unknown) => (c === null || c === undefined || c === '' ? '' : (Number(c) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })),
  qtd: (m: unknown) => (m === null || m === undefined || m === '' ? '' : (Number(m) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 })),
  dia: (d: unknown) => {
    if (!d) return '';
    const s = String(d);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.split('-').reverse().join('/');
    const x = new Date(s); return Number.isNaN(x.getTime()) ? s : x.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  },
  dataHora: (d: unknown) => { if (!d) return ''; const x = new Date(String(d)); return Number.isNaN(x.getTime()) ? String(d) : x.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }); },
  doc: (d: unknown) => {
    const n = String(d ?? '').replace(/\D/g, '');
    if (n.length === 14) return n.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    if (n.length === 11) return n.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    return String(d ?? '');
  },
  simNao: (b: unknown) => (b ? 'Sim' : 'Não'),
  pct: (bp: unknown) => (bp === null || bp === undefined ? '' : `${(Number(bp) / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`),
};
