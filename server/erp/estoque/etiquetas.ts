/**
 * Etiquetas de produto/lote: ZPL (Zebra) e dados para impressora comum.
 * QR = "MCK1;lote interno;lote do fornecedor;validade AAAA-MM-DD;SKU;descrição" (campo vazio = "-").
 * Código de barras (Code 128) = lote interno (ou o código de barras do produto, sem lote). A conferência aceita os dois.
 */
import { lerCodigo, qrLote } from './codigoLote.js';

export interface DadosEtiqueta { empresa?: string | null; gs1?: { dados: string; legivel: string; zpl: string } | null; barras?: string; qr: string; sku: string; nome: string; lote: string | null; loteFornecedor: string | null; validade: string | null; fabricacao: string | null; fornecedor: string | null; unidade: string }

const sem = (s: string | null | undefined) => (s ? String(s).replace(/;/g, ',').trim() : '') || '-';
/** Texto do QR com todas as informações da etiqueta (v1.33.0: + fabricação e empresa no fim, compatível). */
export function textoQr(d: { lote: string | null; loteFornecedor: string | null; validadeIso: string | null; sku: string; nome: string; fabricacaoIso?: string | null; empresa?: string | null }) {
  return qrLote(d);
}
/**
 * Lê um código bipado/fotografado: QR da etiqueta (MCK1;...), código de barras GS1-128 do lote (v1.33.0) ou código
 * simples. Devolve o que a conferência compara (lote interno e/ou código do produto) e, no GS1 sem separador, os pares possíveis.
 */
export function lerCodigoEtiqueta(codigo: string): { lote: string | null; sku: string | null; bruto: string; candidatos: { sku: string; lote: string }[] } {
  const r = lerCodigo(codigo);
  return { lote: r.lote, sku: r.sku, bruto: r.bruto, candidatos: r.candidatos };
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
    d.empresa ? limpa(d.empresa).slice(0, 34) : null,
    limpa(d.nome).slice(0, 34),
    `SKU ${limpa(d.sku)}`,
    d.lote ? `LOTE INT. ${limpa(d.lote)}` : null,
    d.loteFornecedor && d.loteFornecedor !== d.lote ? `LOTE FAB. ${limpa(d.loteFornecedor)}` : null,
    d.fabricacao ? `FAB ${d.fabricacao}` : null,
    d.validade ? `VAL ${d.validade}` : null,
  ].filter(Boolean) as string[];
  const barraAlt = Math.round(H * 0.22); // faixa do código de barras no rodapé, ao lado do QR
  const passo = Math.floor((H - 2 * m - barraAlt - m) / Math.max(linhas.length, 1));
  return [
    '^XA', '^CI28', `^PW${W}`, `^LL${H}`, '^LH0,0',
    `^FO${m},${m}^BQN,2,${qrMag}^FDLA,${limpa(d.qr)}^FS`,
    ...linhas.map((t, i) => { const f = Math.min(i === 0 ? fonte : Math.round(fonte * 0.85), Math.max(14, passo - 2)); return `^FO${x},${m + i * passo}^A0N,${f},${f}^FB${W - x - m},1,0,L^FD${t}^FS`; }),
    // v1.33.0: GS1-128 do lote (produto + lote + datas) com o texto legível embaixo; sem lote, o código simples.
    d.gs1 ? `^FO${x},${H - m - barraAlt}^BY1^BCN,${Math.max(20, barraAlt - 22)},N,N,N^FD${d.gs1.zpl}^FS` : `^FO${x},${H - m - barraAlt}^BY2^BCN,${barraAlt},N,N,N^FD${limpa(d.barras || d.lote || d.sku)}^FS`,
    d.gs1 ? `^FO${x},${H - m - 18}^A0N,16,16^FD${limpa(d.gs1.legivel)}^FS` : null,
    `^PQ${Math.max(1, Math.min(999, o.copias ?? 1))}`, '^XZ',
  ].filter(Boolean).join('\n');
}
