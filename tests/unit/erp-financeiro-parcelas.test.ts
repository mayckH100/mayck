import { describe, it, expect } from 'vitest';
import { gerarParcelas, conferirParcelas, somarMeses, somarDias, dividirCentavos, isoValida, MAX_PARCELAS } from '../../server/erp/financeiro/parcelas.js';

const soma = (l: { valorCents: number }[]) => l.reduce((a, p) => a + p.valorCents, 0);

describe('Financeiro · cálculo de parcelas', () => {
  it('1 parcela = à vista, no próprio 1º vencimento', () => {
    expect(gerarParcelas(12_345, 1, '2026-11-14')).toEqual([{ parcela: 1, parcelas: 1, valorCents: 12_345, vencimento: '2026-11-14' }]);
  });

  it('arredondamento: a sobra vai na última e a soma bate exatamente o total', () => {
    const p = gerarParcelas(10_000, 3, '2026-11-14');
    expect(p.map((x) => x.valorCents)).toEqual([3333, 3333, 3334]);
    expect(p.map((x) => x.vencimento)).toEqual(['2026-11-14', '2026-12-14', '2027-01-14']);
    for (const [total, n] of [[1, 1], [2, 3], [99_999, 7], [100_001, 12], [5, 120], [1_999_999_999, 120]]) {
      const l = gerarParcelas(total, n, '2026-01-31');
      expect(l).toHaveLength(n);
      expect(soma(l)).toBe(total);
      expect(Math.max(...l.map((x) => x.valorCents)) - Math.min(...l.slice(0, -1).map((x) => x.valorCents))).toBeLessThan(n);
    }
    expect(dividirCentavos(100, 3)).toEqual([33, 33, 34]);
  });

  it('12 parcelas mensais: mesmo dia de cada mês, atravessando o ano', () => {
    const p = gerarParcelas(120_000, 12, '2026-11-14');
    expect(p).toHaveLength(12);
    expect(p.every((x) => x.valorCents === 10_000)).toBe(true);
    expect(p[0].vencimento).toBe('2026-11-14');
    expect(p[1].vencimento).toBe('2026-12-14');
    expect(p[2].vencimento).toBe('2027-01-14');
    expect(p[11].vencimento).toBe('2027-10-14');
    expect(p.map((x) => `${x.parcela}/${x.parcelas}`)[11]).toBe('12/12');
  });

  it('31 de janeiro → último dia de fevereiro, e volta ao dia 31 quando o mês tem', () => {
    expect(gerarParcelas(30_000, 4, '2026-01-31').map((x) => x.vencimento)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(somarMeses('2026-08-31', 1)).toBe('2026-09-30');
    expect(somarMeses('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('ano bissexto: 29 de fevereiro existe em 2028, não em 2027', () => {
    expect(somarMeses('2028-01-31', 1)).toBe('2028-02-29');
    expect(somarMeses('2027-01-30', 1)).toBe('2027-02-28');
    expect(gerarParcelas(300, 3, '2028-02-29').map((x) => x.vencimento)).toEqual(['2028-02-29', '2028-03-29', '2028-04-29']);
    expect(somarMeses('2028-02-29', 12)).toBe('2029-02-28');
    expect(isoValida('2028-02-29')).toBe(true);
    expect(isoValida('2027-02-29')).toBe(false);
  });

  it('opção a cada X dias', () => {
    expect(gerarParcelas(900, 3, '2026-12-20', { tipo: 'DIAS', dias: 15 }).map((x) => x.vencimento)).toEqual(['2026-12-20', '2027-01-04', '2027-01-19']);
    expect(somarDias('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('limita a 120 parcelas e trata quantidade inválida como 1', () => {
    expect(gerarParcelas(100_000, 500, '2026-11-14')).toHaveLength(MAX_PARCELAS);
    expect(gerarParcelas(100, 0, '2026-11-14')).toHaveLength(1);
  });

  it('conferência de parcelas editadas: soma, valores, datas e limite', () => {
    expect(conferirParcelas([{ vencimento: '2026-11-14', valorCents: 500 }, { vencimento: '2026-12-14', valorCents: 500 }], 1000)).toMatchObject({ ok: true, diferencaCents: 0 });
    const falta = conferirParcelas([{ vencimento: '2026-11-14', valorCents: 400 }, { vencimento: '2026-12-14', valorCents: 500 }], 1000);
    expect(falta).toMatchObject({ ok: false, somaCents: 900, diferencaCents: 100 });
    expect(conferirParcelas([{ vencimento: '2026-11-14', valorCents: 1200 }], 1000).diferencaCents).toBe(-200);
    expect(conferirParcelas([{ vencimento: '2026-02-30', valorCents: 1000 }], 1000).ok).toBe(false);
    expect(conferirParcelas([{ vencimento: '', valorCents: 1000 }], 1000).ok).toBe(false);
    expect(conferirParcelas([{ vencimento: '2026-11-14', valorCents: 0 }, { vencimento: '2026-12-14', valorCents: 1000 }], 1000).ok).toBe(false);
    expect(conferirParcelas([], 1000).ok).toBe(false);
    expect(conferirParcelas(Array.from({ length: 121 }, () => ({ vencimento: '2026-11-14', valorCents: 1 })), 121).ok).toBe(false);
  });
});
