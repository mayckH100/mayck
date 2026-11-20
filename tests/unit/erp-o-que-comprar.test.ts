import { describe, it, expect } from 'vitest';
import { calcularCompra, escolherJanela, precisaComprar, compararUrgencia, motivoCurto, saidaMediaTexto } from '../../server/erp/compras/sugestao.js';
import { trechosParecemTelefone } from '../../server/erp/alertas/formato.js';

describe('O que comprar: sugestão pelo histórico (v1.32.0)', () => {
  it('sem histórico: compra só o que falta para o mínimo (Canetack: tem 5, mínimo 10 → 5)', () => {
    const j = escolherJanela({ saidasCurtaMil: 0, saidasLongaMil: 0, idadeDias: 60 });
    expect(j.base).toBe('minimo');
    const r = calcularCompra({ unidade: 'UN', saldoMil: 5000, minimoMil: 10_000, consumoMil: j.consumoMil, janelaDias: j.janelaDias, base: j.base });
    expect(r.sugeridaMil).toBe(5000);
    expect(r.duraDias).toBeNull();
    expect(motivoCurto(r, 'UN')).toBe('sem vendas nos últimos 90 dias, completa o estoque mínimo');
  });

  it('com histórico de 30 dias: consumo × 30 dias − estoque (vende 2/dia, tem 5 → 55)', () => {
    const j = escolherJanela({ saidasCurtaMil: 60_000, saidasLongaMil: 150_000, idadeDias: 200 });
    expect(j).toEqual({ consumoMil: 60_000, janelaDias: 30, base: '30d' });
    const r = calcularCompra({ unidade: 'UN', saldoMil: 5000, minimoMil: 10_000, consumoMil: j.consumoMil, janelaDias: j.janelaDias, base: j.base });
    expect(r.consumoDiaMil).toBe(2000);
    expect(r.duraDias).toBe(2);
    expect(r.sugeridaMil).toBe(55_000);
    expect(motivoCurto(r, 'UN')).toBe('vende ~2 unidades por dia, dura 2 dias, compra para 30 dias');
  });

  it('nunca menos que o necessário para chegar ao mínimo (vende pouco, mínimo alto)', () => {
    const r = calcularCompra({ unidade: 'UN', saldoMil: 2000, minimoMil: 50_000, consumoMil: 3000, janelaDias: 30 });
    expect(r.necessidadeMil).toBe(3000);
    expect(r.sugeridaMil).toBe(48_000);
    expect(motivoCurto(r, 'UN')).toContain('completa o estoque mínimo');
  });

  it('pouco histórico: sem saída em 30 dias cai para 90 dias', () => {
    const j = escolherJanela({ saidasCurtaMil: 0, saidasLongaMil: 9000, idadeDias: 365 });
    expect(j).toEqual({ consumoMil: 9000, janelaDias: 90, base: '90d' });
    const r = calcularCompra({ unidade: 'UN', saldoMil: 0, minimoMil: 2000, consumoMil: j.consumoMil, janelaDias: j.janelaDias, base: j.base });
    expect(r.sugeridaMil).toBe(3000); // 0,1/dia × 30 = 3
    expect(motivoCurto(r, 'UN')).toContain('~3 unidades por mês (média de 90 dias)');
  });

  it('produto novo: a média não divide por menos de 7 dias nem por mais que a idade', () => {
    expect(escolherJanela({ saidasCurtaMil: 10_000, saidasLongaMil: 10_000, idadeDias: 1 }).janelaDias).toBe(7);
    expect(escolherJanela({ saidasCurtaMil: 10_000, saidasLongaMil: 10_000, idadeDias: 12 }).janelaDias).toBe(12);
  });

  it('zerado: lista e calcula; prazo do fornecedor entra na cobertura', () => {
    const r = calcularCompra({ unidade: 'UN', saldoMil: 0, minimoMil: 1000, consumoMil: 30_000, janelaDias: 30, coberturaDias: 10, leadTimeDias: 5 });
    expect(r.duraDias).toBe(0);
    expect(r.coberturaTotalDias).toBe(15);
    expect(r.sugeridaMil).toBe(15_000);
    expect(motivoCurto(r, 'UN', { leadTimeDias: 5 })).toContain('já acabou');
  });

  it('saldo negativo legado conta como zero', () => {
    expect(calcularCompra({ unidade: 'UN', saldoMil: -3000, minimoMil: 4000, consumoMil: 0, janelaDias: 30 }).sugeridaMil).toBe(4000);
  });

  it('unidade inválida legada ("30") é tratada como unidades', () => {
    const r = calcularCompra({ unidade: '30', saldoMil: 5000, minimoMil: 10_000, consumoMil: 0, janelaDias: 30 });
    expect(r.sugeridaMil).toBe(5000);
    expect(saidaMediaTexto(2000, '30')).toBe('~2 unidades por dia');
  });

  it('desconta o que já foi pedido e não chegou', () => {
    const r = calcularCompra({ unidade: 'UN', saldoMil: 5000, minimoMil: 10_000, consumoMil: 60_000, janelaDias: 30, aCaminhoMil: 20_000 });
    expect(r.sugeridaMil).toBe(35_000);
    const coberto = calcularCompra({ unidade: 'UN', saldoMil: 5000, minimoMil: 10_000, consumoMil: 0, janelaDias: 30, aCaminhoMil: 5000 });
    expect(coberto.sugeridaMil).toBe(0);
    expect(motivoCurto(coberto, 'UN')).toContain('o que já foi pedido cobre');
  });

  it('lote mínimo e embalagem inteira (pacote com 10 peças)', () => {
    expect(calcularCompra({ unidade: 'UN', saldoMil: 0, minimoMil: 1000, consumoMil: 0, janelaDias: 30, loteMinimoMil: 24_000 })).toMatchObject({ sugeridaMil: 24_000, ajuste: 'lote_minimo' });
    const r = calcularCompra({ unidade: 'PC', unidadeCompra: 'PCT', fatorCompraMil: 10_000, saldoMil: 5000, minimoMil: 10_000, consumoMil: 60_000, janelaDias: 30 });
    expect(r.sugeridaMil).toBe(60_000); // 55 peças → 6 pacotes
    expect(r.ajuste).toBe('embalagem');
  });

  it('quilo: sugestão com 1 casa decimal', () => {
    const r = calcularCompra({ unidade: 'KG', saldoMil: 1200, minimoMil: 3500, consumoMil: 0, janelaDias: 30 });
    expect(r.sugeridaMil).toBe(2300);
  });

  it('quem entra na lista e em que ordem', () => {
    expect(precisaComprar(5000, 10_000, 0)).toBe(true);
    expect(precisaComprar(0, 0, 1000)).toBe(true); // zerado sem mínimo, mas vendeu
    expect(precisaComprar(0, 0, 0)).toBe(false); // zerado e parado: não polui a lista
    expect(precisaComprar(10_000, 10_000, 5000)).toBe(false);
    const l = [
      { nome: 'B', saldoMil: 8000, minimoMil: 10_000, duraDias: 20 },
      { nome: 'C', saldoMil: 0, minimoMil: 10_000, duraDias: 0 },
      { nome: 'A', saldoMil: 5000, minimoMil: 10_000, duraDias: 3 },
      { nome: 'D', saldoMil: 1000, minimoMil: 10_000, duraDias: null },
    ].sort(compararUrgencia).map((x) => x.nome);
    expect(l).toEqual(['C', 'A', 'B', 'D']);
  });

  it('o porquê não tem números lado a lado (o WhatsApp sublinha como telefone)', () => {
    const r = calcularCompra({ unidade: 'UN', saldoMil: 5000, minimoMil: 10_000, consumoMil: 60_000, janelaDias: 30, aCaminhoMil: 10_000, leadTimeDias: 7 });
    expect(trechosParecemTelefone(motivoCurto(r, 'UN', { leadTimeDias: 7 }))).toEqual([]);
  });
});
