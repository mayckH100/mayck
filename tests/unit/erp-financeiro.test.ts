import { describe, it, expect } from 'vitest';
import { parcelar, encargos, crc16, pixCopiaECola, lerOfx, sugerirConciliacao, aging, fluxoProjetado, dre } from '../../server/erp/financeiro/calculo.js';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
describe('ERP · financeiro', () => {
  it('parcela com resto na última e vencimentos pelos prazos', () => {
    const p = parcelar(10_000, [30, 60, 90], d('2026-11-03'));
    expect(p.map((x) => x.valorCents)).toEqual([3333, 3333, 3334]);
    expect(p[0].vencimento.toISOString().slice(0, 10)).toBe('2026-12-03');
  });
  it('multa e juros pro rata só depois do vencimento', () => {
    expect(encargos(10_000, d('2026-11-03'), d('2026-11-03'), 200, 100)).toMatchObject({ multaCents: 0, jurosCents: 0 });
    expect(encargos(10_000, d('2026-11-03'), d('2026-11-18'), 200, 100)).toEqual({ dias: 15, multaCents: 200, jurosCents: 50 });
  });
  it('Pix copia-e-cola com CRC16 CCITT válido', () => {
    expect(crc16('123456789')).toBe('29B1');
    const c = pixCopiaECola({ chave: '12345678000195', nome: 'Empresa Exemplo Ltda', cidade: 'São Paulo', valorCents: 1050, txid: 'PED1' });
    expect(c).toMatch(/^000201/); expect(c).toContain('br.gov.bcb.pix'); expect(c).toContain('540510.50'); expect(c).toContain('SAO PAULO');
    expect(crc16(c.slice(0, -4))).toBe(c.slice(-4));
  });
  it('lê OFX e sugere conciliação pelo valor e data mais próxima', () => {
    const ofx = '<OFX><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261105120000<TRNAMT>150.00<FITID>A1<MEMO>PIX RECEBIDO</STMTTRN><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261106<TRNAMT>-12,90<FITID>A2<MEMO>TARIFA</STMTTRN></OFX>';
    const l = lerOfx(ofx);
    expect(l.map((x) => [x.fitId, x.valorCents])).toEqual([['A1', 15_000], ['A2', -1290]]);
    const pares = sugerirConciliacao([{ id: 'e1', data: l[0].data, valorCents: 15_000 }], [{ id: 'x', data: d('2026-11-01'), valorCents: 15_000 }, { id: 'y', data: d('2026-11-04'), valorCents: 15_000 }]);
    expect(pares).toEqual([{ extratoId: 'e1', lancamentoId: 'y' }]);
  });
  it('aging, fluxo projetado e DRE', () => {
    const hoje = d('2026-11-03');
    expect(aging([{ valorCents: 100, pagoCents: 0, vencimento: d('2026-11-10') }, { valorCents: 100, pagoCents: 40, vencimento: d('2026-09-01') }], hoje)).toMatchObject({ aVencer: 100, ate90: 60 });
    const f = fluxoProjetado(1000, [{ tipo: 'RECEBER', valorCents: 500, pagoCents: 0, vencimento: d('2026-11-04') }, { tipo: 'PAGAR', valorCents: 300, pagoCents: 0, vencimento: d('2026-10-01') }], 3, hoje);
    expect(f.map((x) => x.saldoCents)).toEqual([700, 1200, 1200]);
    const r = dre([{ tipo: 'RECEBER', valorCents: 10_000, grupo: 'RECEITA_BRUTA' }, { tipo: 'PAGAR', valorCents: 1_000, grupo: 'DEDUCAO' }, { tipo: 'PAGAR', valorCents: 4_000, grupo: 'CUSTO' }, { tipo: 'PAGAR', valorCents: 2_000, grupo: null }]);
    expect(r).toMatchObject({ receitaLiquida: 9_000, lucroBruto: 5_000, resultadoOperacional: 3_000, resultadoLiquido: 3_000 });
  });
});
