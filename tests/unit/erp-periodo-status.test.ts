import { describe, it, expect } from 'vitest';
import { intervaloDoPreset, periodoInicial, escolherPreset, ajustarDatas, descreverPeriodo, isoBrasilia, PERIODOS_PADRAO } from '../../web/src/erp/periodo';
import { statusInadimplencia, statusScore, statusSaldo, statusTitulo, tomDoStatus, classeStatus } from '../../web/src/erp/status';

// 26/11/2026 01:30 em UTC = 25/11/2026 22:30 em Brasília
const NOITE = new Date('2026-11-26T01:30:00Z');
const TARDE = new Date('2026-11-26T15:00:00Z');

describe('seletor de período padrão (v1.56.0)', () => {
  it('opções padrão na ordem pedida', () => {
    expect(PERIODOS_PADRAO).toEqual(['hoje', '7d', '30d', 'mes', 'personalizado']);
  });
  it('usa o dia de Brasília, não o de UTC', () => {
    expect(isoBrasilia(NOITE)).toBe('2026-11-25');
    expect(intervaloDoPreset('hoje', NOITE)).toEqual({ de: '2026-11-25', ate: '2026-11-25' });
  });
  it('7 dias, 30 dias, 90 dias e mês contam hoje', () => {
    expect(intervaloDoPreset('7d', TARDE)).toEqual({ de: '2026-11-20', ate: '2026-11-26' });
    expect(intervaloDoPreset('30d', TARDE)).toEqual({ de: '2026-10-28', ate: '2026-11-26' });
    expect(intervaloDoPreset('90d', TARDE)).toEqual({ de: '2026-08-29', ate: '2026-11-26' });
    expect(intervaloDoPreset('mes', TARDE)).toEqual({ de: '2026-11-01', ate: '2026-11-26' });
    expect(intervaloDoPreset('todos', TARDE)).toEqual({ de: '', ate: '' });
  });
  it('Personalizado mantém as datas atuais; vindo de "Todos" começa nos últimos 30 dias', () => {
    const p = periodoInicial('7d', TARDE);
    expect(escolherPreset(p, 'personalizado', TARDE)).toEqual({ preset: 'personalizado', de: '2026-11-20', ate: '2026-11-26' });
    expect(escolherPreset(periodoInicial('todos', TARDE), 'personalizado', TARDE)).toEqual({ preset: 'personalizado', de: '2026-10-28', ate: '2026-11-26' });
    expect(escolherPreset(p, 'mes', TARDE)).toEqual({ preset: 'mes', de: '2026-11-01', ate: '2026-11-26' });
  });
  it('datas invertidas não passam', () => {
    const p = { preset: 'personalizado' as const, de: '2026-11-01', ate: '2026-11-10' };
    expect(ajustarDatas(p, 'de', '2026-11-15')).toEqual({ preset: 'personalizado', de: '2026-11-15', ate: '2026-11-15' });
    expect(ajustarDatas(p, 'ate', '2026-10-20')).toEqual({ preset: 'personalizado', de: '2026-10-20', ate: '2026-10-20' });
    expect(ajustarDatas(periodoInicial('7d', TARDE), 'de', '2026-11-22').preset).toBe('personalizado');
  });
  it('descrição em português simples', () => {
    expect(descreverPeriodo(periodoInicial('hoje', TARDE))).toBe('Hoje');
    expect(descreverPeriodo(periodoInicial('30d', TARDE))).toBe('Últimos 30 dias');
    expect(descreverPeriodo(periodoInicial('mes', TARDE))).toBe('Este mês');
    expect(descreverPeriodo(periodoInicial('todos', TARDE))).toBe('Todos');
    expect(descreverPeriodo({ preset: 'personalizado', de: '2026-11-01', ate: '2026-11-10' })).toBe('01/11/2026 a 10/11/2026');
  });
});

describe('cores de status iguais (v1.56.0)', () => {
  it('inadimplência: até 2% verde, até 10% amarelo, acima vermelho; sem dado neutro', () => {
    expect([0, 2, 2.1, 10, 10.1].map(statusInadimplencia)).toEqual(['ok', 'ok', 'atencao', 'atencao', 'problema']);
    expect(statusInadimplencia(null)).toBe('neutro');
  });
  it('score: 650+ verde, 400+ amarelo, abaixo vermelho; sem histórico neutro', () => {
    expect([1000, 650, 649, 400, 399, 0].map((s) => statusScore(s))).toEqual(['ok', 'ok', 'atencao', 'atencao', 'problema', 'problema']);
    expect(statusScore(500, 'NOVO')).toBe('neutro');
  });
  it('saldo e contas', () => {
    expect([statusSaldo(-1), statusSaldo(0), statusSaldo(null)]).toEqual(['problema', 'ok', 'neutro']);
    expect(statusTitulo({ status: 'PAGO', vencimento: '2026-01-01' }, TARDE)).toBe('ok');
    expect(statusTitulo({ status: 'EM_ABERTO', vencimento: '2026-11-25T00:00:00Z' }, TARDE)).toBe('problema');
    expect(statusTitulo({ status: 'PARCIAL', vencimento: '2026-11-28T00:00:00Z' }, TARDE)).toBe('atencao');
    expect(statusTitulo({ status: 'EM_ABERTO', vencimento: '2026-12-20T00:00:00Z' }, TARDE)).toBe('neutro');
    expect(statusTitulo({ status: 'CANCELADO', vencimento: '2026-01-01' }, TARDE)).toBe('neutro');
  });
  it('mesmas cores nos indicadores do Resumo', () => {
    expect(['ok', 'atencao', 'problema', 'neutro'].map((s) => tomDoStatus(s as any))).toEqual(['ok', 'alerta', 'perigo', 'neutro']);
    expect(classeStatus('atencao')).toBe('st st-atencao');
  });
});
