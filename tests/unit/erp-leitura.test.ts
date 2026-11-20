import { describe, it, expect } from 'vitest';
import { classificarLeitura, chaveNfeValida, extrairChave, codigoPedido } from '../../server/erp/leitura/codigo.js';
import { gs1Lote, qrLote } from '../../server/erp/estoque/codigoLote.js';

const CHAVE = '35261112345678000195550010000000011000000015';

describe('leitura unificada (v1.34.0)', () => {
  it('código do pedido', () => {
    expect(codigoPedido(123)).toBe('PV-123');
    for (const s of ['PV-123', 'pv123', 'PV 000123', 'MCKPV:123', ' PV-123\r\n']) expect(classificarLeitura(s)).toMatchObject({ tipo: 'pedido', numero: 123 });
    expect(classificarLeitura('PV-0').tipo).toBe('codigo');
    expect(classificarLeitura('PVC-12').tipo).toBe('codigo');
  });
  it('chave de NF-e: DANFE, com espaços, QR da NFC-e; dígito verificador', () => {
    expect(chaveNfeValida(CHAVE)).toBe(true);
    expect(chaveNfeValida(CHAVE.slice(0, 43) + '9')).toBe(false);
    expect(extrairChave(CHAVE.replace(/(\d{4})/g, '$1 '))).toBe(CHAVE);
    expect(extrairChave(`https://www.nfce.fazenda.sp.gov.br/qrcode?p=${CHAVE}|2|2|1|abc`)).toBe(CHAVE);
    expect(extrairChave(`http://x/consulta?chNFe=${CHAVE}&nVersao=100`)).toBe(CHAVE);
    expect(classificarLeitura(CHAVE)).toMatchObject({ tipo: 'chave_nfe', chave: CHAVE, valida: true, modelo: '55' });
    expect(classificarLeitura('1234').tipo).toBe('codigo');
  });
  it('etiqueta do lote e códigos comuns', () => {
    expect(classificarLeitura(gs1Lote({ sku: 'MCK0001', lote: 'L2611-0001', validadeIso: '2027-01-20' }).dados.replace(/\u00CF/g, '\u001D')).tipo).toBe('etiqueta');
    expect(classificarLeitura(qrLote({ lote: 'L1', sku: 'A', nome: 'B' })).tipo).toBe('etiqueta');
    expect(classificarLeitura('7891234567895').tipo).toBe('codigo');
    expect(classificarLeitura('Padaria').tipo).toBe('codigo');
  });
});
