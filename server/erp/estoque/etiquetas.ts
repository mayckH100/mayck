/**
 * Etiquetas de produto/lote: ZPL (Zebra) e dados para impressora comum.
 * QR = "MCK1;lote interno;lote do fornecedor;validade AAAA-MM-DD;SKU;descrição" (campo vazio = "-").
 * Código de barras (Code 128) = lote interno (ou o código de barras do produto, sem lote). A conferência aceita os dois.
 */
export interface DadosEtiqueta { barras?: string; qr: string; sku: string; nome: string; lote: string | null; loteFornecedor: string | null; validade: string | null; fabricacao: string | null; fornecedor: string | null; unidade: string }

const sem = (s: string | null | undefined) => (s ? String(s).replace(/;/g, ',').trim() : '') || '-';
/** Texto do QR com todas as informações da etiqueta. */
export function textoQr(d: { lote: string | null; loteFornecedor: string | null; validadeIso: string | null; sku: string; nome: string }) {
  return ['MCK1', sem(d.lote), sem(d.loteFornecedor), sem(d.validadeIso), sem(d.sku), sem(d.nome).slice(0, 60)].join(';');
}
/** Lê um código bipado: QR da etiqueta (MCK1;...) ou código simples. Devolve o que a conferência compara. */
export function lerCodigoEtiqueta(codigo: string): { lote: string | null; sku: string | null; bruto: string } {
  const c = codigo.trim();
  if (!c.toUpperCase().startsWith('MCK1;')) return { lote: null, sku: null, bruto: c };
  const [, lote, , , sku] = c.split(';');
  return { lote: lote && lote !== '-' ? lote : null, sku: sku && sku !== '-' ? sku : null, bruto: c };
}

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
  const barraAlt = Math.round(H * 0.22); // faixa do código de barras no rodapé, ao lado do QR
  const passo = Math.floor((H - 2 * m - barraAlt - m) / Math.max(linhas.length, 1));
  return [
    '^XA', '^CI28', `^PW${W}`, `^LL${H}`, '^LH0,0',
    `^FO${m},${m}^BQN,2,${qrMag}^FDLA,${limpa(d.qr)}^FS`,
    ...linhas.map((t, i) => { const f = Math.min(i === 0 ? fonte : Math.round(fonte * 0.85), Math.max(14, passo - 2)); return `^FO${x},${m + i * passo}^A0N,${f},${f}^FB${W - x - m},1,0,L^FD${t}^FS`; }),
    `^FO${x},${H - m - barraAlt}^BY2^BCN,${barraAlt},N,N,N^FD${limpa(d.barras || d.lote || d.sku)}^FS`,
    `^PQ${Math.max(1, Math.min(999, o.copias ?? 1))}`, '^XZ',
  ].join('\n');
}
