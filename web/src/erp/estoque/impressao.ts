/**
 * Impressão de etiquetas.
 *  - Zebra: envia ZPL pelo Zebra Browser Print (app gratuito da Zebra instalado no computador ligado à impressora,
 *    USB ou rede). Sem o app, baixa o arquivo .zpl para enviar pela ferramenta da Zebra.
 *  - Comum: abre a folha de etiquetas no navegador e chama a impressão (A4 ou impressora de rolo comum).
 */
const BP = 'http://localhost:9100';

export async function imprimirZebra(zpl: string): Promise<'impresso' | 'baixado'> {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2500);
    const dev = await fetch(`${BP}/default?type=printer`, { signal: ctrl.signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    clearTimeout(t);
    if (dev?.uid || dev?.name) {
      // text/plain evita preflight de CORS no Browser Print
      const r = await fetch(`${BP}/write`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ device: dev, data: zpl }) });
      if (r.ok) return 'impresso';
    }
  } catch { /* cai no download */ }
  const url = URL.createObjectURL(new Blob([zpl], { type: 'text/plain' }));
  const a = document.createElement('a'); a.href = url; a.download = `etiquetas-${Date.now()}.zpl`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'baixado';
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function imprimirComum(d: { larguraMm: number; alturaMm: number; etiquetas: any[] }, modo: 'rolo' | 'a4') {
  const cards = d.etiquetas.flatMap((e) => Array.from({ length: e.copias }, () => `
    <div class="etq"><img src="${e.png}" alt=""><div class="txt"><b>${esc(e.nome)}</b><div>SKU ${esc(e.sku)}</div>${e.lote ? `<div>LOTE <b>${esc(e.lote)}</b></div>` : ''}${e.loteFornecedor && e.loteFornecedor !== e.lote ? `<div>Lote forn. ${esc(e.loteFornecedor)}</div>` : ''}${e.fabricacao ? `<div>Fab. ${esc(e.fabricacao)}</div>` : ''}${e.validade ? `<div>Val. <b>${esc(e.validade)}</b></div>` : ''}</div></div>`)).join('');
  // Sem <script> inline (a CSP bloqueia): a impressão é chamada daqui depois que as imagens carregam.
  const W = d.larguraMm, H = d.alturaMm;
  const css = modo === 'rolo'
    ? `@page{size:${W}mm ${H}mm;margin:0}body{margin:0}.etq{width:${W}mm;height:${H}mm;page-break-after:always}`
    : `@page{size:A4;margin:8mm}body{margin:0;display:flex;flex-wrap:wrap;gap:2mm}.etq{width:${W}mm;height:${H}mm;border:1px dashed #bbb;break-inside:avoid}`;
  const w = window.open('', '_blank', 'width=800,height=600');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>Etiquetas</title><style>${css}*{box-sizing:border-box;font-family:Arial,sans-serif}.etq{display:flex;align-items:center;gap:2mm;padding:2mm;overflow:hidden}.etq img{height:${Math.max(10, H - 6)}mm;width:auto}.txt{font-size:${Math.max(7, Math.round(H / 6))}pt;line-height:1.2}</style></head><body>${cards}</body></html>`);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 600);
}
