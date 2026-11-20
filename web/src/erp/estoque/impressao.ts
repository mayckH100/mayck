/**
 * Impressão de etiquetas.
 *  - Zebra (v1.34.0): impressão direta em ./zebra.ts (Bluetooth, USB, Browser Print); veja <BotaoZebra>.
 *  - Comum: abre a folha de etiquetas no navegador e chama a impressão (A4 ou impressora de rolo comum).
 */
import JsBarcode from 'jsbarcode';
import { impressoraSalva, tentarBrowserPrintPadrao, imprimirNaSalva, baixarZpl } from './zebra';


/** Código de barras Code 128 em SVG (texto) para a folha de etiquetas. */
function barrasSvg(valor: string, alturaMm: number) {
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    JsBarcode(svg, valor, { format: 'CODE128', displayValue: false, height: 40, width: 1.4, margin: 0 });
    svg.setAttribute('style', `height:${Math.max(5, Math.round(alturaMm * 0.2))}mm;width:100%;display:block;margin-top:1mm`);
    svg.setAttribute('preserveAspectRatio', 'none');
    return svg.outerHTML;
  } catch { return ''; }
}

/** Compatibilidade: imprime na impressora guardada (ou Browser Print padrão); sem nenhuma, baixa o .zpl. Prefira <BotaoZebra>. */
export async function imprimirZebra(zpl: string): Promise<'impresso' | 'baixado'> {
  try {
    if (!impressoraSalva() && !(await tentarBrowserPrintPadrao())) throw new Error('sem impressora');
    await imprimirNaSalva(zpl); return 'impresso';
  } catch { baixarZpl(zpl); return 'baixado'; }
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function imprimirComum(d: { larguraMm: number; alturaMm: number; etiquetas: any[] }, modo: 'rolo' | 'a4') {
  const cards = d.etiquetas.flatMap((e) => Array.from({ length: e.copias }, () => `
    <div class="etq"><img src="${e.png}" alt=""><div class="txt"><b>${esc(e.nome)}</b><div>SKU ${esc(e.sku)}</div>${e.lote ? `<div>Lote int. <b>${esc(e.lote)}</b></div>` : ''}${e.loteFornecedor && e.loteFornecedor !== e.lote ? `<div>Lote fab. ${esc(e.loteFornecedor)}</div>` : ''}${e.fabricacao ? `<div>Fab. ${esc(e.fabricacao)}</div>` : ''}${e.validade ? `<div>Val. <b>${esc(e.validade)}</b></div>` : ''}${e.barras ? barrasSvg(e.barras, d.alturaMm) : ''}</div></div>`)).join('');
  // Sem <script> inline (a CSP bloqueia): a impressão é chamada daqui depois que as imagens carregam.
  const W = d.larguraMm, H = d.alturaMm;
  const css = modo === 'rolo'
    ? `@page{size:${W}mm ${H}mm;margin:0}body{margin:0}.etq{width:${W}mm;height:${H}mm;page-break-after:always}`
    : `@page{size:A4;margin:8mm}body{margin:0;display:flex;flex-wrap:wrap;gap:2mm}.etq{width:${W}mm;height:${H}mm;border:1px dashed #bbb;break-inside:avoid}`;
  const w = window.open('', '_blank', 'width=800,height=600');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>Etiquetas</title><style>${css}*{box-sizing:border-box;font-family:Arial,sans-serif}.etq{display:flex;align-items:center;gap:2mm;padding:2mm;overflow:hidden}.etq img{height:${Math.max(10, H - 6)}mm;width:auto}.txt{flex:1;min-width:0;font-size:${Math.max(7, Math.round(H / 6))}pt;line-height:1.2}</style></head><body>${cards}</body></html>`);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 600);
}
