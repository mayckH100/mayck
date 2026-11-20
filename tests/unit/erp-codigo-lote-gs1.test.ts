/** v1.33.0 — etiqueta do lote: GS1-128 (11/17/241/10), QR com os mesmos dados, leitura de ambos e etiquetas sugeridas. */
import { describe, it, expect } from 'vitest';
import { gs1Lote, qrLote, lerCodigo, variantesBarras, etiquetasSugeridas, FNC1 } from '../../server/erp/estoque/codigoLote.js';
import { lerCodigoEtiqueta } from '../../server/erp/estoque/etiquetas.js';
import { PDFDocument } from 'pdf-lib';
import { modulosCode128, pdfEtiquetas } from '../../server/erp/estoque/etiquetaPdf.js';

describe('código de barras GS1-128 do lote', () => {
  const g = gs1Lote({ sku: 'mck0001', lote: 'L2611-0001', fabricacaoIso: '2026-11-01', validadeIso: '2027-01-20' });
  it('datas fixas primeiro (11, 17), depois produto (241) e lote (10) separados por FNC1; texto legível', () => {
    expect(g.dados).toBe(`1126110117270120241MCK0001${FNC1}10L2611-0001`);
    expect(g.legivel).toBe('(11)261101(17)270120(241)MCK0001(10)L2611-0001');
    expect(g.zpl).toBe('>81126110117270120241MCK0001>810L2611-0001');
    expect(gs1Lote({ sku: 'P1', lote: 'L1' }).legivel).toBe('(241)P1(10)L1');
  });
  it('lê o que o leitor manda: com GS, com ]C1, com parênteses e sem separador', () => {
    const gs = g.dados.replace(FNC1, '\u001d');
    for (const t of [gs, `]C1${gs}`, g.legivel]) expect(lerCodigo(t)).toMatchObject({ tipo: 'gs1', sku: 'MCK0001', lote: 'L2611-0001', fabricacao: '2026-11-01', validade: '2027-01-20' });
    const sem = lerCodigo(g.dados.replace(FNC1, ''));
    expect(sem.candidatos).toContainEqual({ sku: 'MCK0001', lote: 'L2611-0001' });
  });
  it('EAN do produto (só números) não vira GS1', () => {
    expect(lerCodigo('2410000000001')).toMatchObject({ tipo: 'simples', bruto: '2410000000001' });
    expect(variantesBarras('07891234567895')).toContain('7891234567895');
  });
  it('QR da etiqueta tem os mesmos dados + empresa e continua compatível com o formato antigo', () => {
    const q = qrLote({ lote: 'L2611-0001', loteFornecedor: 'ABC;1', validadeIso: '2027-01-20', sku: 'MCK0001', nome: 'Canetack', fabricacaoIso: '2026-11-01', empresa: 'MCK Desenvolvimento' });
    expect(q).toBe('MCK1;L2611-0001;ABC,1;2027-01-20;MCK0001;Canetack;2026-11-01;MCK Desenvolvimento');
    expect(lerCodigo(q)).toMatchObject({ tipo: 'qr', lote: 'L2611-0001', sku: 'MCK0001', validade: '2027-01-20', fabricacao: '2026-11-01' });
    expect(lerCodigoEtiqueta('MCK1;L1;-;-;P1;Velho')).toMatchObject({ lote: 'L1', sku: 'P1' });
    expect(lerCodigoEtiqueta(g.legivel)).toMatchObject({ lote: 'L2611-0001', sku: 'MCK0001' });
  });
  it('etiquetas sugeridas: uma por embalagem, senão por peça; granel = 1; limite 999', () => {
    expect(etiquetasSugeridas(50_000, { unidade: 'UN', unidadeCompra: 'CX', fatorCompraMil: 10_000 })).toBe(5);
    expect(etiquetasSugeridas(7_000, { unidade: 'UN' })).toBe(7);
    expect(etiquetasSugeridas(2_500, { unidade: 'KG' })).toBe(1);
    expect(etiquetasSugeridas(5_000_000, { unidade: 'UN' })).toBe(999);
  });
});

describe('PDF da etiqueta', () => {
  it('codifica GS1-128 válido e gera PDF (rolo e A4)', async () => {
    expect(modulosCode128(gs1Lote({ sku: 'MCK0001', lote: 'L2611-0001' }).dados, true)).toMatch(/^[01]+$/);
    const e = { empresa: 'MCK Desenvolvimento', nome: 'Canetack azul ação', sku: 'MCK0001', lote: 'L2611-0001', loteFornecedor: 'ABC', fabricacao: '01/11/2026', validade: '20/01/2027', qr: 'MCK1;L2611-0001', gs1: gs1Lote({ sku: 'MCK0001', lote: 'L2611-0001', validadeIso: '2027-01-20' }), barras: 'L2611-0001', copias: 3 };
    const rolo = await pdfEtiquetas([e], { larguraMm: 50, alturaMm: 30, formato: 'rolo' });
    expect(Buffer.from(rolo.slice(0, 5)).toString()).toBe('%PDF-');
    expect((await PDFDocument.load(rolo)).getPageCount()).toBe(3);
    const a4 = await pdfEtiquetas([e], { larguraMm: 100, alturaMm: 50, formato: 'a4' });
    expect((await PDFDocument.load(a4)).getPageCount()).toBe(1);
  });
});
