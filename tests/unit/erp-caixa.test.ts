import { describe, it, expect } from 'vitest';
import { resumoCaixa, diferencaCaixa, validarFechamento } from '../../server/erp/vendas/caixa.calculo.js';

describe('caixa do PDV · contas', () => {
  it('esperado em dinheiro = abertura + vendas em dinheiro + suprimentos − sangrias', () => {
    const r = resumoCaixa({
      aberturaCents: 10_000,
      recebimentos: [{ forma: 'DINHEIRO', valorCents: 2_000 }, { forma: 'PIX', valorCents: 1_500 }, { forma: 'CARTAO', valorCents: 3_000 }, { forma: 'DINHEIRO', valorCents: 500 }],
      movimentos: [{ tipo: 'SANGRIA', valorCents: 4_000 }, { tipo: 'SUPRIMENTO', valorCents: 1_000 }, { tipo: 'SANGRIA', valorCents: 500 }],
    });
    expect(r.porForma).toEqual({ DINHEIRO: { qtd: 2, valorCents: 2_500 }, PIX: { qtd: 1, valorCents: 1_500 }, CARTAO: { qtd: 1, valorCents: 3_000 } });
    expect(r).toMatchObject({ qtdVendas: 4, totalVendasCents: 7_000, vendasDinheiroCents: 2_500, sangriasCents: 4_500, suprimentosCents: 1_000, esperadoDinheiroCents: 9_000 });
  });

  it('caixa sem movimento: esperado = abertura; formas zeradas aparecem', () => {
    const r = resumoCaixa({ aberturaCents: 0, recebimentos: [], movimentos: [] });
    expect(r.esperadoDinheiroCents).toBe(0);
    expect(r.porForma.PIX).toEqual({ qtd: 0, valorCents: 0 });
  });

  it('forma desconhecida entra no total mas não no dinheiro', () => {
    const r = resumoCaixa({ aberturaCents: 100, recebimentos: [{ forma: 'BOLETO', valorCents: 900 }], movimentos: [] });
    expect(r.totalVendasCents).toBe(900);
    expect(r.esperadoDinheiroCents).toBe(100);
    expect(r.porForma.BOLETO).toEqual({ qtd: 1, valorCents: 900 });
  });

  it('diferença: sobra, falta e confere', () => {
    expect(diferencaCaixa(10_200, 10_000)).toEqual({ diferencaCents: 200, situacao: 'SOBRA' });
    expect(diferencaCaixa(9_900, 10_000)).toEqual({ diferencaCents: -100, situacao: 'FALTA' });
    expect(diferencaCaixa(10_000, 10_000)).toEqual({ diferencaCents: 0, situacao: 'CONFERE' });
  });

  it('fechamento com diferença exige observação', () => {
    expect(validarFechamento(10_000, 10_000)).toBeNull();
    expect(validarFechamento(9_000, 10_000)).toContain('falta');
    expect(validarFechamento(11_000, 10_000, '  ')).toContain('sobra');
    expect(validarFechamento(11_000, 10_000, 'cliente deixou troco')).toBeNull();
    expect(validarFechamento(-1, 0)).toContain('dinheiro contado');
  });
});
