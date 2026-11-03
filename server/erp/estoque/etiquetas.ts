/** Etiquetas de produto/lote: ZPL (Zebra) e dados para impressora comum. QR = número do lote (ou SKU sem lote). */
export interface DadosEtiqueta { qr: string; sku: string; nome: string; lote: string | null; loteFornecedor: string | null; validade: string | null; fabricacao: string | null; fornecedor: string | null; unidade: string }

const limpa = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\^~\\]/g, ' ');

/** Gera ZPL II para uma etiqueta do tamanho configurado (mm) na resolução da impressora (203 ou 300 dpi). */
export function zpl(d: DadosEtiqueta, o: { larguraMm: number; alturaMm: number; dpi: number; copias?: number }) {
  const dpmm = o.dpi >= 300 ? 12 : 8;
  const W = Math.round(o.larguraMm * dpmm), H = Math.round(o.alturaMm * dpmm);
  const m = 2 * dpmm; // margem
  const qrMag = Math.max(2, Math.min(10, Math.floor((H - 2 * m) / 30)));
  const qrLado = qrMag * 29; // QR versão ~3
  const x = m + qrLado + m;
  const fonte = Math.max(18, Math.round(H / 9));
  const linhas = [
    limpa(d.nome).slice(0, 34),
    `SKU ${limpa(d.sku)}`,
    d.lote ? `LOTE ${limpa(d.lote)}` : null,
    d.loteFornecedor && d.loteFornecedor !== d.lote ? `LOTE FORN. ${limpa(d.loteFornecedor)}` : null,
    d.fabricacao ? `FAB ${d.fabricacao}` : null,
    d.validade ? `VAL ${d.validade}` : null,
  ].filter(Boolean) as string[];
  const passo = Math.floor((H - 2 * m) / Math.max(linhas.length, 1));
  return [
    '^XA', '^CI28', `^PW${W}`, `^LL${H}`, '^LH0,0',
    `^FO${m},${m}^BQN,2,${qrMag}^FDLA,${limpa(d.qr)}^FS`,
    ...linhas.map((t, i) => `^FO${x},${m + i * passo}^A0N,${i === 0 ? fonte : Math.round(fonte * 0.85)},${i === 0 ? fonte : Math.round(fonte * 0.85)}^FB${W - x - m},1,0,L^FD${t}^FS`),
    `^PQ${Math.max(1, Math.min(999, o.copias ?? 1))}`, '^XZ',
  ].join('\n');
}
