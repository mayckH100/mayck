import { describe, it, expect } from 'vitest';
import {
  lerMidias, midiaDaVersao, definirMidia, erroLegenda, LEGENDA_MAX, maxMbDoTipo,
  proximaExecucao, proximaDepoisDe, erroFimRecorrencia, nomeExecucao, diaDoMesBrt,
  lerCanais, canaisDaCampanha, escolherCanal, MAX_CANAIS_RODIZIO,
  atendeFiltroErp, filtroErpVazio, erroFiltroErp, descreverFiltroErp, lerPublico,
} from '../../server/mckmensagem/campanhaCore.js';

const brt = (s: string) => new Date(`${s}-03:00`);

describe('v1.49.0 — imagem/PDF', () => {
  it('lê o JSON sem quebrar, versão sem arquivo usa o da A, grava e tira', () => {
    expect(lerMidias('lixo')).toEqual([]);
    expect(lerMidias('[null,"b",null]')).toEqual([null, 'b']);
    expect(lerMidias('["a",1,"c","d","e"]')).toEqual(['a', null, 'c', 'd']);
    expect(midiaDaVersao(['a'], 2)).toBe('a');
    expect(midiaDaVersao([null, 'b'], 1)).toBe('b');
    expect(midiaDaVersao([], 0)).toBeNull();
    expect(definirMidia([], 2, 'x')).toBe('[null,null,"x"]');
    expect(definirMidia(['a', null, 'x'], 2, null)).toBe('["a"]');
  });
  it('legenda até 1.024 caracteres e limites por tipo', () => {
    expect(erroLegenda(['ok', 'x'.repeat(LEGENDA_MAX)])).toBeNull();
    expect(erroLegenda(['ok', 'x'.repeat(LEGENDA_MAX + 1)])).toMatch(/versão B/);
    expect(maxMbDoTipo('pdf')).toBe(10);
    expect(maxMbDoTipo('png')).toBe(5);
  });
});

describe('v1.49.0 — campanha que se repete', () => {
  it('diária/semanal mantêm a hora; mensal no mesmo dia e no último dia do mês curto', () => {
    const base = brt('2026-01-31T10:30:00');
    expect(proximaExecucao(base, 'DIARIA').toISOString()).toBe(brt('2026-02-01T10:30:00').toISOString());
    expect(proximaExecucao(base, 'SEMANAL').toISOString()).toBe(brt('2026-02-07T10:30:00').toISOString());
    const fev = proximaExecucao(base, 'MENSAL', 31);
    expect(fev.toISOString()).toBe(brt('2026-02-28T10:30:00').toISOString());
    expect(proximaExecucao(fev, 'MENSAL', 31).toISOString()).toBe(brt('2026-03-31T10:30:00').toISOString());
    expect(proximaExecucao(brt('2026-12-15T08:00:00'), 'MENSAL').toISOString()).toBe(brt('2027-01-15T08:00:00').toISOString());
    expect(diaDoMesBrt(brt('2026-03-01T00:30:00'))).toBe(1); // 03:30 UTC ainda é dia 1 em Brasília
  });
  it('pula as repetições perdidas, fim no futuro e nome da execução', () => {
    const p = proximaDepoisDe(brt('2026-11-01T09:00:00'), 'DIARIA', brt('2026-11-05T12:00:00'));
    expect(p.toISOString()).toBe(brt('2026-11-06T09:00:00').toISOString());
    const agora = new Date('2026-11-23T12:00:00Z');
    expect(erroFimRecorrencia(null, agora)).toBeNull();
    expect(erroFimRecorrencia(new Date('2026-11-01'), agora)).toMatch(/futuro/);
    expect(erroFimRecorrencia(new Date('2030-01-01'), agora)).toMatch(/2 anos/);
    expect(nomeExecucao('Promo', brt('2026-11-24T09:00:00'))).toBe('Promo · 24/11');
    expect(nomeExecucao('Promo · 24/11', brt('2026-11-25T09:00:00'))).toBe('Promo · 25/11');
  });
});

describe('v1.49.0 — rodízio entre números', () => {
  it('lista de números sem repetir e com limite; desligado = só o principal', () => {
    expect(lerCanais('["b","b","c"]')).toEqual(['b', 'c']);
    expect(lerCanais(JSON.stringify(['1', '2', '3', '4', '5', '6']))).toHaveLength(MAX_CANAIS_RODIZIO - 1);
    expect(canaisDaCampanha({ channelId: 'a', rodizio: false, canaisRodizio: '["b"]' })).toEqual(['a']);
    expect(canaisDaCampanha({ channelId: 'a', rodizio: true, canaisRodizio: '["a","b"]' })).toEqual(['a', 'b']);
  });
  it('contato fica no mesmo número: atribuído > conversa existente > sorteio fixo', () => {
    const todos = ['a', 'b', 'c'];
    expect(escolherCanal({ chave: 'x', atribuido: 'c', preferido: 'a', todos, saudaveis: ['a'] })).toBe('c'); // espera o dele
    expect(escolherCanal({ chave: 'x', atribuido: 'z', preferido: 'b', todos, saudaveis: ['a', 'b'] })).toBe('b');
    const um = escolherCanal({ chave: 'lead1', atribuido: null, preferido: null, todos, saudaveis: ['c', 'a', 'b'] });
    expect(escolherCanal({ chave: 'lead1', atribuido: null, preferido: null, todos, saudaveis: ['a', 'b', 'c'] })).toBe(um);
    expect(escolherCanal({ chave: 'x', atribuido: null, preferido: null, todos, saudaveis: [] })).toBeNull();
    const usados = new Set(Array.from({ length: 60 }, (_, i) => escolherCanal({ chave: `l${i}`, atribuido: null, preferido: null, todos, saudaveis: todos })));
    expect(usados.size).toBe(3);
  });
});

describe('v1.49.0 — público pelas compras do ERP', () => {
  const agora = new Date('2026-11-23T12:00:00Z');
  const dias = (n: number) => new Date(agora.getTime() - n * 86_400_000);
  const vip = { gastoCents: 90000, compras: 3, ultimaCompra: dias(3) };
  const sumido = { gastoCents: 5000, compras: 1, ultimaCompra: dias(200) };
  const nunca = { gastoCents: 0, compras: 0, ultimaCompra: null };
  it('valor gasto, número de compras e última compra', () => {
    expect(atendeFiltroErp(vip, { gastoMin: 500 }, agora)).toBe(true);
    expect(atendeFiltroErp(sumido, { gastoMin: 500 }, agora)).toBe(false);
    expect(atendeFiltroErp(vip, { gastoMax: 100 }, agora)).toBe(false);
    expect(atendeFiltroErp(vip, { comprasMin: 2, comprasMax: 5 }, agora)).toBe(true);
    expect(atendeFiltroErp(vip, { ultimaCompraMaxDias: 30 }, agora)).toBe(true);
    expect(atendeFiltroErp(nunca, { ultimaCompraMaxDias: 30 }, agora)).toBe(false);
    expect(atendeFiltroErp(sumido, { ultimaCompraMinDias: 90 }, agora)).toBe(true);
    expect(atendeFiltroErp(nunca, { ultimaCompraMinDias: 90 }, agora)).toBe(true);
    expect(atendeFiltroErp(vip, { ultimaCompraMinDias: 90 }, agora)).toBe(false);
  });
  it('validação, filtro vazio, texto e público gravado', () => {
    expect(filtroErpVazio({})).toBe(true);
    expect(filtroErpVazio({ gastoMin: null, comprasMin: 0 })).toBe(false);
    expect(erroFiltroErp({ comprasMin: 5, comprasMax: 2 })).toMatch(/compras/);
    expect(erroFiltroErp({ gastoMin: 1, gastoMax: 2 })).toBeNull();
    expect(descreverFiltroErp({ gastoMin: 500, ultimaCompraMaxDias: 30 })).toMatch(/500,00.*30 dias/);
    expect(lerPublico(null)).toEqual({ modo: 'vinculados' });
    expect(lerPublico('{"modo":"etiqueta","tag":"vip"}')).toEqual({ modo: 'etiqueta', tag: 'vip' });
    expect(lerPublico('{"modo":"erp","erp":{"gastoMin":1}}')).toEqual({ modo: 'erp', erp: { gastoMin: 1 } });
  });
});
