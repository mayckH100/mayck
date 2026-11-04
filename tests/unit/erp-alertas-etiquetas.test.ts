import { describe, it, expect } from 'vitest';
import { textoQr, lerCodigoEtiqueta, zpl } from '../../server/erp/estoque/etiquetas.js';
import { digitoEan13 } from '../../server/erp/produtos/produtos.routes.js';
import { agoraLocal } from '../../server/erp/alertas/alertas.js';

describe('ERP · etiqueta, código de barras e alertas', () => {
  it('QR leva lote interno, lote do fornecedor, validade, SKU e descrição; conferência lê o lote', () => {
    const q = textoQr({ lote: '261103-0001', loteFornecedor: 'F;77', validadeIso: '2027-01-31', sku: 'ABC', nome: 'Café 500g' });
    expect(q).toBe('MCK1;261103-0001;F,77;2027-01-31;ABC;Café 500g');
    expect(lerCodigoEtiqueta(q)).toMatchObject({ lote: '261103-0001', sku: 'ABC' });
    expect(lerCodigoEtiqueta('MCK1;-;-;-;ABC;X')).toMatchObject({ lote: null, sku: 'ABC' });
    expect(lerCodigoEtiqueta('261103-0001')).toMatchObject({ lote: null, sku: null, bruto: '261103-0001' });
  });
  it('ZPL inclui Code 128 do lote', () => {
    const z = zpl({ barras: '261103-0001', qr: 'MCK1;x', sku: 'A', nome: 'N', lote: '261103-0001', loteFornecedor: null, validade: null, fabricacao: null, fornecedor: null, unidade: 'UN' }, { larguraMm: 100, alturaMm: 50, dpi: 203 });
    expect(z).toContain('^BCN,');
    expect(z).toContain('^FD261103-0001^FS');
  });
  it('EAN-13: dígito verificador', () => {
    expect(digitoEan13('789100031550')).toBe('7'); // 7891000315507
  });
  it('hora local no fuso da organização', () => {
    expect(agoraLocal('America/Sao_Paulo', new Date('2026-11-04T02:30:00Z'))).toEqual({ dia: '2026-11-03', hora: 23 });
  });
});
