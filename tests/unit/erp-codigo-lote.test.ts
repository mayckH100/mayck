/** v1.31.0 — regras puras do código automático do produto e do lote interno. */
import { describe, it, expect } from 'vitest';
import { padraoSku, proximoDaLista } from '../../server/erp/produtos/codigo.js';
import { numeroLoteInterno, formatoLoteEfetivo, FORMATO_LOTE_PADRAO } from '../../server/erp/estoque/nfe-xml.js';
import { hojeBrasilia } from '../../server/erp/estoque/servico.js';

describe('código do produto automático', () => {
  it('sem produtos começa em P0001', () => {
    expect(padraoSku([])).toEqual({ prefixo: 'P', largura: 4 });
    expect(proximoDaLista([], 'P', 4)).toBe('P0001');
  });
  it('segue o padrão mais usado pela empresa e ignora códigos soltos', () => {
    const skus = ['MCK0001', 'MCK0007', 'CAFE500', 'ABC-1', 'X1'];
    expect(padraoSku(skus)).toEqual({ prefixo: 'MCK', largura: 4 });
    expect(proximoDaLista(skus, 'MCK', 4)).toBe('MCK0008');
    expect(proximoDaLista(skus, 'MCK', 4, 1)).toBe('MCK0009');
  });
  it('passa de 9999 sem quebrar', () => {
    expect(proximoDaLista(['P9999'], 'P', 4)).toBe('P10000');
  });
});

describe('lote interno', () => {
  it('formato padrão antigo vira o novo (L + ano/mês + 4 dígitos); formato personalizado é mantido', () => {
    expect(formatoLoteEfetivo('{AA}{MM}{DD}-{SEQ}')).toBe(FORMATO_LOTE_PADRAO);
    expect(formatoLoteEfetivo(null)).toBe(FORMATO_LOTE_PADRAO);
    expect(formatoLoteEfetivo('{SKU}-{SEQ}')).toBe('{SKU}-{SEQ}');
  });
  it('L2611-0001', () => {
    expect(numeroLoteInterno(FORMATO_LOTE_PADRAO, 1, 'MCK0001', new Date(2026, 10, 20, 12))).toBe('L2611-0001');
    expect(numeroLoteInterno(FORMATO_LOTE_PADRAO, 1234, 'X', new Date(2027, 0, 2, 12))).toBe('L2701-1234');
    expect(numeroLoteInterno('{AA}{MM}{DD}-{SEQ}', 3, 'X', new Date(2026, 10, 1, 12))).toBe('261101-00003'); // lotes antigos continuam no formato antigo
  });
  it('dia do lote é o de Brasília (00:30 UTC ainda é o dia anterior)', () => {
    const d = hojeBrasilia(new Date('2026-12-01T00:30:00Z'));
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 11, 30]);
  });
});
