/**
 * Etiqueta do lote em PDF (v1.33.0): pronta para impressora comum (folha A4) ou de etiqueta (rolo, uma por página).
 * Cada etiqueta: nome da empresa, produto, código, lote interno (e do fabricante), fabricação e validade, QR com os
 * mesmos dados e código de barras GS1-128 (produto + lote + datas) com o texto legível embaixo.
 */
import { createRequire } from 'node:module';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { FNC1 } from './codigoLote.js';

const require = createRequire(import.meta.url);
// Codificador Code 128 do jsbarcode (sem canvas): devolve a sequência de módulos "1101…".
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CODE128: new (data: string, opts: Record<string, unknown>) => { valid(): boolean; encode(): { data: string } } = require('jsbarcode/bin/barcodes/CODE128/CODE128_AUTO.js').default;

const MM = 72 / 25.4;

export interface EtiquetaPdf {
  empresa: string | null; nome: string; sku: string; lote: string | null; loteFornecedor: string | null;
  fabricacao: string | null; validade: string | null; qr: string; gs1: { dados: string; legivel: string } | null; barras: string; copias: number;
}

/** Módulos do Code 128 (GS1-128 quando os dados começam com FNC1 implícito). */
export function modulosCode128(dados: string, gs1: boolean): string {
  const enc = new CODE128(gs1 ? dados : dados.replace(new RegExp(FNC1, 'g'), ''), { ean128: gs1 });
  if (!enc.valid()) throw new Error('Código de barras com caracteres inválidos');
  return enc.encode().data;
}

/** Texto cabendo na largura: diminui a fonte até o mínimo e, se ainda não couber, corta com "…". */
function caber(font: PDFFont, texto: string, larg: number, tam: number, min = 4.5): { t: string; tam: number } {
  let s = tam;
  while (s > min && font.widthOfTextAtSize(texto, s) > larg) s -= 0.25;
  let t = texto;
  while (t.length > 1 && font.widthOfTextAtSize(t, s) > larg) t = `${t.slice(0, -2)}…`;
  return { t, tam: s };
}
// Fontes padrão do PDF usam WinAnsi: troca o que não existe nela (acentos comuns do português existem).
const ansi = (s: string) => s.replace(/[^\x20-\x7E\u00A0-\u00FF]/g, (c) => ({ '–': '-', '—': '-', '“': '"', '”': '"', '’': "'", '…': '...', '·': '·' } as Record<string, string>)[c] ?? '');

async function desenhar(pdf: PDFDocument, page: PDFPage, e: EtiquetaPdf, x0: number, y0: number, W: number, H: number, f: PDFFont, fb: PDFFont, qrPng: Uint8Array) {
  const m = Math.min(2.5 * MM, H * 0.06);
  const preto = rgb(0, 0, 0);
  // Faixa do código de barras: ~30% da altura, embaixo, largura toda.
  const barraH = H * 0.24; const legH = Math.max(5, H * 0.06);
  const topoBarras = y0 + m + legH + barraH;
  // QR à esquerda, do topo até a faixa das barras.
  const qrLado = Math.min(H - (topoBarras - y0) - 2 * m, W * 0.38);
  const img = await pdf.embedPng(qrPng);
  page.drawImage(img, { x: x0 + m, y: y0 + H - m - qrLado, width: qrLado, height: qrLado });
  // Textos à direita do QR.
  const tx = x0 + m + qrLado + m * 0.8; const larg = x0 + W - m - tx;
  const linhas: { t: string; f: PDFFont; tam: number }[] = [];
  const base = Math.min(H * 0.085, 9);
  if (e.empresa) linhas.push({ t: ansi(e.empresa), f, tam: base * 0.8 });
  linhas.push({ t: ansi(e.nome), f: fb, tam: base * 1.05 });
  linhas.push({ t: `Cód. ${ansi(e.sku)}`, f, tam: base });
  if (e.lote) linhas.push({ t: `Lote ${ansi(e.lote)}${e.loteFornecedor && e.loteFornecedor !== e.lote ? ` · Fab. lote ${ansi(e.loteFornecedor)}` : ''}`, f: fb, tam: base });
  if (e.fabricacao) linhas.push({ t: `Fabricação ${e.fabricacao}`, f, tam: base * 0.9 });
  if (e.validade) linhas.push({ t: `Validade ${e.validade}`, f: fb, tam: base * 0.9 });
  let y = y0 + H - m;
  const espaco = (y - topoBarras - m * 0.5) / linhas.reduce((a, l) => a + l.tam * 1.2, 0);
  const k = Math.min(1, espaco);
  for (const l of linhas) {
    const c = caber(l.f, l.t, larg, l.tam * k);
    y -= c.tam * 1.2;
    page.drawText(c.t, { x: tx, y, size: c.tam, font: l.f, color: preto });
  }
  // Código de barras (GS1-128 do lote; sem lote, o código simples do produto).
  const quiet = 10; // zona de silêncio em módulos, cada lado
  const larguraBarras = W - 2 * m;
  let gs1 = e.gs1;
  let mods = modulosCode128(gs1?.dados ?? e.barras, !!gs1);
  // Etiqueta estreita: barra fina demais para o leitor (< 0,19 mm). Tira as datas das barras (continuam no QR e no texto).
  if (gs1 && larguraBarras / (mods.length + 2 * quiet) < 0.19 * MM) {
    gs1 = { dados: gs1.dados.replace(/^((11|17)\d{6})+/, ''), legivel: gs1.legivel.replace(/\((11|17)\)\d{6}/g, '') };
    mods = modulosCode128(gs1.dados, true);
  }
  const modulo = larguraBarras / (mods.length + 2 * quiet);
  const bx = x0 + m + quiet * modulo;
  for (let i = 0; i < mods.length; ) {
    if (mods[i] === '1') { let j = i; while (mods[j] === '1') j++; page.drawRectangle({ x: bx + i * modulo, y: y0 + m + legH, width: (j - i) * modulo, height: barraH, color: preto }); i = j; }
    else i++;
  }
  const leg = caber(f, ansi(gs1?.legivel ?? e.barras), larguraBarras, legH * 0.95, 3.5);
  page.drawText(leg.t, { x: x0 + m + (larguraBarras - f.widthOfTextAtSize(leg.t, leg.tam)) / 2, y: y0 + m, size: leg.tam, font: f, color: preto });
}

/**
 * Gera o PDF. `rolo`: cada etiqueta é uma página do tamanho configurado (impressora de etiqueta, inclusive Zebra pelo
 * driver). `a4`: etiquetas lado a lado numa folha A4 com linha de corte.
 */
export async function pdfEtiquetas(etqs: EtiquetaPdf[], o: { larguraMm: number; alturaMm: number; formato: 'rolo' | 'a4' }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Etiquetas de lote'); pdf.setCreator('MCK ERP');
  const f = await pdf.embedFont(StandardFonts.Helvetica); const fb = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = Math.max(20, o.larguraMm) * MM; const H = Math.max(15, o.alturaMm) * MM;
  const pngs = new Map<string, Uint8Array>();
  for (const e of etqs) if (!pngs.has(e.qr)) pngs.set(e.qr, new Uint8Array(await QRCode.toBuffer(e.qr, { margin: 0, width: 300, errorCorrectionLevel: 'M' })));
  const lista = etqs.flatMap((e) => Array.from({ length: Math.max(1, Math.min(999, e.copias)) }, () => e)).slice(0, 2000);
  if (o.formato === 'rolo') {
    for (const e of lista) { const pg = pdf.addPage([W, H]); await desenhar(pdf, pg, e, 0, 0, W, H, f, fb, pngs.get(e.qr)!); }
  } else {
    const PW = 210 * MM, PH = 297 * MM, marg = 8 * MM;
    const cols = Math.max(1, Math.floor((PW - 2 * marg) / W)); const rows = Math.max(1, Math.floor((PH - 2 * marg) / H));
    let pg: PDFPage | null = null;
    for (let i = 0; i < lista.length; i++) {
      const pos = i % (cols * rows);
      if (pos === 0) pg = pdf.addPage([PW, PH]);
      const c = pos % cols, r = Math.floor(pos / cols);
      const x = marg + c * W, y = PH - marg - (r + 1) * H;
      pg!.drawRectangle({ x, y, width: W, height: H, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.4 });
      await desenhar(pdf, pg!, lista[i], x, y, W, H, f, fb, pngs.get(lista[i].qr)!);
    }
  }
  if (!lista.length) pdf.addPage([W, H]);
  return pdf.save();
}
