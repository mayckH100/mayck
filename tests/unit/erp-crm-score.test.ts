import { describe, it, expect } from 'vitest';
import { calcularInadimplencia, calcularScore, resumoScores, faixaDoScore, SCORE_BASE } from '../../server/erp/crm/score.js';
import { calcularKpis } from '../../server/erp/crm/kpis.js';

const AGORA = new Date('2026-11-26T15:00:00Z');
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const tit = (o: Partial<{ valorCents: number; pagoCents: number; status: string; vencimento: Date; baixas: Date[] }>) =>
  ({ valorCents: 10_000, pagoCents: 0, status: 'EM_ABERTO', vencimento: d('2026-12-10'), baixas: [], ...o });

describe('inadimplência do Painel CRM (v1.56.0)', () => {
  it('% do vencido em aberto sobre o total a receber do período, e o valor', () => {
    const r = calcularInadimplencia([
      tit({ valorCents: 10_000, vencimento: d('2026-11-10') }), // vencido, nada pago
      tit({ valorCents: 20_000, pagoCents: 5_000, status: 'PARCIAL', vencimento: d('2026-11-20') }), // vencido, falta 150
      tit({ valorCents: 30_000, pagoCents: 30_000, status: 'PAGO', vencimento: d('2026-11-01') }), // pago
      tit({ valorCents: 40_000, vencimento: d('2026-11-30') }), // a vencer
      tit({ valorCents: 99_000, status: 'CANCELADO', vencimento: d('2026-11-01') }), // cancelado não conta
    ], AGORA);
    expect(r).toEqual({ totalCents: 100_000, vencidoCents: 25_000, pct: 25, titulosVencidos: 2 });
  });
  it('vence hoje ainda não é vencido; sem contas = 0%', () => {
    expect(calcularInadimplencia([tit({ vencimento: d('2026-11-26') })], AGORA).vencidoCents).toBe(0);
    expect(calcularInadimplencia([], AGORA)).toEqual({ totalCents: 0, vencidoCents: 0, pct: 0, titulosVencidos: 0 });
  });
  it('arredonda para 1 casa', () => {
    expect(calcularInadimplencia([tit({ valorCents: 1_000, vencimento: d('2026-11-01') }), tit({ valorCents: 2_000 })], AGORA).pct).toBe(33.3);
  });
  it('entra nos KPIs; sem permissão fica null', () => {
    const inad = calcularInadimplencia([tit({ vencimento: d('2026-11-01') })], AGORA);
    const k = calcularKpis([], [], inad);
    expect(k).toMatchObject({ inadimplenciaPct: 100, inadimplenciaVencidoCents: 10_000, inadimplenciaTotalCents: 10_000, inadimplenciaTitulos: 1 });
    expect(calcularKpis([], []).inadimplenciaPct).toBeNull();
    expect(calcularKpis([], []).inadimplenciaVencidoCents).toBeNull();
  });
});

describe('score do cliente (v1.56.0)', () => {
  it('sem histórico: 500, faixa NOVO', () => {
    const s = calcularScore([], [], AGORA);
    expect(s).toMatchObject({ score: SCORE_BASE, faixa: 'NOVO' });
    expect(calcularScore([tit({ status: 'CANCELADO' })], [], AGORA).faixa).toBe('NOVO');
  });
  it('pagou em dia e compra sempre: sobe e explica cada ponto', () => {
    const pagos = Array.from({ length: 4 }, (_, i) => tit({ status: 'PAGO', pagoCents: 10_000, vencimento: d(`2026-0${i + 5}-10`), baixas: [d(`2026-0${i + 5}-09`)] }));
    const compras = Array.from({ length: 6 }, (_, i) => new Date(AGORA.getTime() - (i * 30 + 5) * 86_400_000));
    const s = calcularScore(pagos, compras, AGORA);
    // 500 + 4×20 (em dia) + 80 (comprou há 5 dias) + 70 (6 compras no ano)
    expect(s.score).toBe(730);
    expect(s.faixa).toBe('BOM');
    expect(s.motivos).toEqual([
      { texto: '4 contas pagas em dia', pontos: 80 },
      { texto: 'Última compra há 5 dias', pontos: 80 },
      { texto: '6 compras nos últimos 12 meses', pontos: 70 },
    ]);
  });
  it('pagamento no mesmo dia do vencimento é em dia; depois é atraso (vale a última baixa)', () => {
    const emDia = tit({ status: 'PAGO', vencimento: d('2026-10-10'), baixas: [d('2026-10-05'), d('2026-10-10')] });
    const atrasado = tit({ status: 'PAGO', vencimento: d('2026-10-10'), baixas: [d('2026-10-01'), d('2026-10-15')] });
    expect(calcularScore([emDia], [], AGORA).score).toBe(520);
    expect(calcularScore([atrasado], [], AGORA).score).toBe(480);
  });
  it('contas vencidas derrubam; mais de 30 dias pesa mais; nunca abaixo de 0', () => {
    const s = calcularScore([tit({ vencimento: d('2026-11-20') }), tit({ vencimento: d('2026-10-01') })], [], AGORA);
    // 500 − 2×50 − 100 (vencida há 56 dias)
    expect(s.score).toBe(300);
    expect(s.faixa).toBe('RISCO');
    expect(s.motivos.map((m) => m.texto)).toEqual(['2 contas vencidas sem pagar', 'Conta vencida há 56 dias']);
    const muitas = Array.from({ length: 20 }, () => tit({ vencimento: d('2025-01-01') }));
    const atrasos = Array.from({ length: 20 }, () => tit({ status: 'PAGO', vencimento: d('2025-01-01'), baixas: [d('2025-03-01')] }));
    const zero = calcularScore([...muitas, ...atrasos], [new Date('2024-01-01T00:00:00Z')], AGORA);
    expect(zero.score).toBe(0); // 500 −300 −100 −200 −50
  });
  it('limites: pagos em dia contam até +200; teto 1000', () => {
    const pagos = Array.from({ length: 30 }, () => tit({ status: 'PAGO', vencimento: d('2026-10-10'), baixas: [d('2026-10-01')] }));
    const compras = Array.from({ length: 24 }, (_, i) => new Date(AGORA.getTime() - i * 10 * 86_400_000));
    const s = calcularScore(pagos, compras, AGORA);
    expect(s.motivos[0].pontos).toBe(200);
    expect(s.score).toBe(880); // 500 + 200 + 80 + 100
  });
  it('recência: sem comprar há mais de 1 ano perde 50; título parcial a vencer não mexe', () => {
    const s = calcularScore([tit({ status: 'PARCIAL', pagoCents: 1, vencimento: d('2026-12-30') })], [new Date('2025-06-01T00:00:00Z')], AGORA);
    expect(s.score).toBe(450);
    expect(s.motivos).toEqual([{ texto: 'Sem comprar há mais de 1 ano', pontos: -50 }]);
  });
  it('faixas: 650+ bom, 400+ atenção, abaixo risco', () => {
    expect([faixaDoScore(650), faixaDoScore(649), faixaDoScore(400), faixaDoScore(399)]).toEqual(['BOM', 'ATENCAO', 'ATENCAO', 'RISCO']);
  });
  it('resumo do painel: contagem por faixa, média sem os novos e piores primeiro com o principal motivo', () => {
    const r = resumoScores([
      { id: 'a', nome: 'A', score: calcularScore([], [], AGORA) },
      { id: 'b', nome: 'B', score: calcularScore([tit({ vencimento: d('2026-10-01') })], [], AGORA) }, // 350
      { id: 'c', nome: 'C', score: calcularScore([tit({ status: 'PAGO', vencimento: d('2026-10-10'), baixas: [d('2026-10-01')] })], [AGORA], AGORA) }, // 500+20+80+15 = 615
      { id: 'd', nome: 'D', score: { score: 800, faixa: 'BOM', motivos: [] } },
    ]);
    expect(r).toMatchObject({ bons: 1, atencao: 1, risco: 1, novos: 1, medio: Math.round((350 + 615 + 800) / 3) });
    expect(r.piores.map((x) => [x.id, x.score])).toEqual([['b', 350], ['c', 615]]);
    expect(r.piores[0].motivo).toBe('Conta vencida há 56 dias');
  });
});
