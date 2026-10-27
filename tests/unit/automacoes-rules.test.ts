import { describe, it, expect } from 'vitest';
import { gerarHorarios, zonedToUtc, regraSchema, localTime, localDate } from '../../server/mckmensagem/automacoes/rules.js';
import { proximoNaJanela } from '../../server/mckmensagem/automacoes/engine.js';

const tz = 'America/Sao_Paulo';
const fmt = (ds: Date[]) => ds.map((d) => `${localDate(d, tz)} ${localTime(d, tz)}`);
const ini = zonedToUtc('2026-11-01', '00:00', tz);

describe('regras de recorrência', () => {
  it('converte horário local para UTC', () => {
    expect(zonedToUtc('2026-11-01', '09:00', tz).toISOString()).toBe('2026-11-01T12:00:00.000Z');
    expect(zonedToUtc('2026-11-01', '09:00', 'Europe/Lisbon').toISOString()).toBe('2026-11-01T09:00:00.000Z');
  });
  it('mensal: dia 31 vira o último dia em meses curtos; filtro de meses', () => {
    const r = regraSchema.parse({ tipo: 'MENSAL', diasMes: [31], horarios: ['10:00'], meses: [11, 2] });
    expect(fmt(gerarHorarios({ regra: r, tz, inicio: ini, de: ini, ate: zonedToUtc('2027-03-01', '00:00', tz) }))).toEqual(['2026-11-30 10:00', '2027-02-28 10:00']);
  });
  it('semanal com máximo de envios estável entre janelas', () => {
    const r = regraSchema.parse({ tipo: 'SEMANAL', diasSemana: [1, 5], horarios: ['08:00'] });
    const ate = zonedToUtc('2026-12-31', '00:00', tz);
    expect(fmt(gerarHorarios({ regra: r, tz, inicio: ini, de: ini, ate, max: 3 }))).toEqual(['2026-11-02 08:00', '2026-11-06 08:00', '2026-11-09 08:00']);
    expect(fmt(gerarHorarios({ regra: r, tz, inicio: ini, de: zonedToUtc('2026-11-07', '00:00', tz), ate, max: 3 }))).toEqual(['2026-11-09 08:00']);
  });
  it('intervalo em minutos e meses; anual; fim inclusivo', () => {
    const m = regraSchema.parse({ tipo: 'INTERVALO', a_cada: 90, unidade: 'MINUTOS' });
    const i9 = zonedToUtc('2026-11-01', '09:00', tz);
    expect(fmt(gerarHorarios({ regra: m, tz, inicio: i9, de: i9, ate: zonedToUtc('2026-11-01', '12:01', tz) }))).toEqual(['2026-11-01 09:00', '2026-11-01 10:30', '2026-11-01 12:00']);
    const mes = regraSchema.parse({ tipo: 'INTERVALO', a_cada: 1, unidade: 'MESES', horario: '08:00' });
    const i31 = zonedToUtc('2027-01-31', '00:00', tz);
    expect(fmt(gerarHorarios({ regra: mes, tz, inicio: i31, de: i31, ate: zonedToUtc('2027-04-01', '00:00', tz) }))).toEqual(['2027-01-31 08:00', '2027-02-28 08:00', '2027-03-31 08:00']);
    const an = regraSchema.parse({ tipo: 'ANUAL', datas: ['11-09'], horarios: ['09:00'] });
    expect(gerarHorarios({ regra: an, tz, inicio: ini, fim: zonedToUtc('2028-11-09', '08:59', tz), de: ini, ate: zonedToUtc('2030-01-01', '00:00', tz) })).toHaveLength(2);
    expect(regraSchema.safeParse({ tipo: 'INTERVALO', a_cada: 2, unidade: 'MINUTOS' }).success).toBe(false);
  });
  it('janela de horário', () => {
    const cfg = { janelaInicio: '08:00', janelaFim: '20:00', timezone: tz };
    expect(proximoNaJanela(zonedToUtc('2026-11-01', '07:00', tz), cfg).toISOString()).toBe(zonedToUtc('2026-11-01', '08:00', tz).toISOString());
    expect(proximoNaJanela(zonedToUtc('2026-11-01', '20:00', tz), cfg).toISOString()).toBe(zonedToUtc('2026-11-02', '08:00', tz).toISOString());
    const noite = { janelaInicio: '22:00', janelaFim: '06:00', timezone: tz };
    expect(proximoNaJanela(zonedToUtc('2026-11-01', '23:00', tz), noite).toISOString()).toBe(zonedToUtc('2026-11-01', '23:00', tz).toISOString());
  });
});
