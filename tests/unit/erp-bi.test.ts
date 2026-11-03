import { describe, it, expect } from 'vitest';
import { curvaAbc, seriePorDia, pctBp, coberturaDias, csv } from '../../server/erp/bi/calculo.js';

describe('ERP · BI', () => {
  it('curva ABC pelo acumulado antes do item', () => {
    const r = curvaAbc([{ id: 'c', valorCents: 50 }, { id: 'a', valorCents: 800 }, { id: 'b', valorCents: 150 }]);
    expect(r.map((x) => [x.id, x.classe])).toEqual([['a', 'A'], ['b', 'B'], ['c', 'C']]);
  });
  it('série por dia preenche dias vazios no fuso de Brasília', () => {
    const s = seriePorDia([{ data: new Date('2026-11-02T02:00:00Z'), valorCents: 10 }], new Date('2026-11-01T03:00:00Z'), new Date('2026-11-03T20:00:00Z'));
    expect(s).toEqual([{ data: '2026-11-01', valorCents: 10 }, { data: '2026-11-02', valorCents: 0 }, { data: '2026-11-03', valorCents: 0 }]);
  });
  it('percentual, cobertura e CSV com BOM e escape', () => {
    expect(pctBp(25, 100)).toBe(2500); expect(pctBp(1, 0)).toBe(0);
    expect(coberturaDias(3000, 1000, 30)).toBe(90); expect(coberturaDias(10, 0, 30)).toBeNull();
    expect(csv(['a', 'b'], [['x;y', 'diz "oi"']])).toBe('\uFEFFa;b\r\n"x;y";"diz ""oi"""');
  });
});
