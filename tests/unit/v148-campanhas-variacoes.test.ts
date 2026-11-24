import { describe, it, expect } from 'vitest';
import {
  escolherVersao, textoParaContato, textosPossiveis, aplicarVariaveis, saudacaoDe, lerVariacoes, versoesDaCampanha, variaveisDesconhecidas,
  resultadoPorVersao, escolherVencedora, normalizarDias, diaDaSemanaLocal, diaPermitido, validarAgendamento, resolverVariacoes, randComSemente, AB_ESPERA_MS,
} from '../../server/mckmensagem/variacoes.js';
import { personalize } from '../../server/mckmensagem/dispatcher.js';

describe('v1.48.0 — variações, A/B e dias da semana (puro)', () => {
  it('sem variações, {saudacao} nem {a|b}: texto igual ao personalize antigo', () => {
    for (const [msg, nome] of [['Olá {nome}! Novidade.', 'Ana Souza'], ['Oi {nome}, tudo bem?', null], ['Promo  de hoje , aproveite', 'Zé']] as const) {
      expect(textoParaContato(msg, { campaignId: 'c', leadId: 'l', nome, saudacao: 'Bom dia' })).toBe(personalize(msg, { name: nome }));
    }
  });

  it('variáveis: {nome}, {nome_completo}, {saudacao}; nome vazio não deixa vírgula sobrando', () => {
    expect(aplicarVariaveis('{saudacao}, {nome}! Sr(a). {nome_completo}', { nome: '  Ana   Maria Souza ', saudacao: 'Boa tarde' })).toBe('Boa tarde, Ana! Sr(a). Ana Maria Souza');
    expect(aplicarVariaveis('Oi {nome}, tudo bem?', { nome: '', saudacao: 'Bom dia' })).toBe('Oi, tudo bem?');
    expect(aplicarVariaveis('{SAUDAÇÃO}!', { saudacao: 'Boa noite' })).toBe('Boa noite!');
  });

  it('saudação pelo horário de Brasília', () => {
    expect(saudacaoDe(new Date('2026-11-23T11:00:00Z'))).toBe('Bom dia'); // 08h BRT
    expect(saudacaoDe(new Date('2026-11-23T16:00:00Z'))).toBe('Boa tarde'); // 13h
    expect(saudacaoDe(new Date('2026-11-23T23:30:00Z'))).toBe('Boa noite'); // 20h30
    expect(saudacaoDe(new Date('2026-11-23T06:00:00Z'))).toBe('Boa noite'); // 03h
  });

  it('spintax com sorteio fixo por contato (mesmo texto se tentar de novo) e variado entre contatos', () => {
    const v = '{Olá|Oi|E aí} {nome}, {tudo bem|tudo certo}?';
    const a1 = textoParaContato(v, { campaignId: 'c1', leadId: 'l1', nome: 'Ana', saudacao: 'Bom dia' });
    expect(textoParaContato(v, { campaignId: 'c1', leadId: 'l1', nome: 'Ana', saudacao: 'Bom dia' })).toBe(a1);
    expect(a1).not.toMatch(/[{}|]/);
    const todos = new Set(Array.from({ length: 40 }, (_, i) => textoParaContato(v, { campaignId: 'c1', leadId: `l${i}`, nome: 'Ana', saudacao: 'Bom dia' })));
    expect(todos.size).toBeGreaterThan(2);
    expect(resolverVariacoes('{a|{b|c}}', randComSemente('x'))).toMatch(/^[abc]$/);
  });

  it('textos possíveis cobrem as 3 saudações (trava de duplicidade)', () => {
    const t = textosPossiveis('{saudacao}, {nome}!', { campaignId: 'c', leadId: 'l', nome: 'Ana' });
    expect(t.sort()).toEqual(['Boa noite, Ana!', 'Boa tarde, Ana!', 'Bom dia, Ana!']);
    expect(textosPossiveis('Oi {nome}', { campaignId: 'c', leadId: 'l', nome: 'Ana' })).toEqual(['Oi Ana']);
  });

  it('versão do contato: gravada > vencedora > sorteio fixo; distribuição aproximadamente igual', () => {
    expect(escolherVersao({ campaignId: 'c', leadId: 'l', total: 1 })).toBe(0);
    expect(escolherVersao({ campaignId: 'c', leadId: 'l', total: 3, gravada: 2, vencedora: 1 })).toBe(2);
    expect(escolherVersao({ campaignId: 'c', leadId: 'l', total: 3, gravada: null, vencedora: 1 })).toBe(1);
    expect(escolherVersao({ campaignId: 'c', leadId: 'l', total: 2, gravada: 5 })).toBeLessThan(2); // gravada inválida → sorteio
    const cont = [0, 0];
    for (let i = 0; i < 1000; i++) cont[escolherVersao({ campaignId: 'camp', leadId: `lead${i}`, total: 2 })]++;
    expect(cont[0]).toBeGreaterThan(400); expect(cont[1]).toBeGreaterThan(400);
  });

  it('lê variações com segurança', () => {
    expect(lerVariacoes('lixo')).toEqual([]);
    expect(lerVariacoes(JSON.stringify(['a', '', '  ', 1, 'b', 'c', 'd']))).toEqual(['a', 'b', 'c']);
    expect(versoesDaCampanha({ message: 'm', variacoes: '["b"]' })).toEqual(['m', 'b']);
    expect(variaveisDesconhecidas('Oi {nome} {nomee} {saudacao} {a|b} {preco}')).toEqual(['{nomee}', '{preco}']);
  });

  it('resultado do A/B e vencedora: só decide com mínimo elegível em todas; maior taxa; empate fica com A', () => {
    const now = new Date('2026-11-23T20:00:00Z');
    const velho = new Date(now.getTime() - AB_ESPERA_MS - 1000), novo = new Date(now.getTime() - 60_000);
    const envios = [
      ...Array.from({ length: 10 }, (_, i) => ({ variante: 0, sentAt: velho, respondeuAt: i < 2 ? now : null })),
      ...Array.from({ length: 10 }, (_, i) => ({ variante: 1, sentAt: velho, respondeuAt: i < 5 ? now : null })),
      { variante: 1, sentAt: novo, respondeuAt: null },
      { variante: null, sentAt: velho, respondeuAt: null }, // campanha antiga → conta como A
    ];
    const r = resultadoPorVersao(2, envios, now);
    expect(r[0]).toMatchObject({ enviadas: 11, respostas: 2, elegiveis: 11 });
    expect(r[1]).toMatchObject({ enviadas: 11, respostas: 5, elegiveis: 10, taxa: 45.5 });
    expect(escolherVencedora(r, 10)).toBe(1);
    expect(escolherVencedora(r, 11)).toBeNull(); // B só tem 10 elegíveis
    const empate = resultadoPorVersao(2, [{ variante: 0, sentAt: velho, respondeuAt: now }, { variante: 1, sentAt: velho, respondeuAt: now }], now);
    expect(escolherVencedora(empate, 1)).toBe(0);
    expect(escolherVencedora(resultadoPorVersao(2, [{ variante: 0, sentAt: velho, respondeuAt: null }, { variante: 1, sentAt: velho, respondeuAt: null }], now), 1)).toBeNull();
  });

  it('dias da semana em Brasília e agendamento', () => {
    expect(normalizarDias('5,1,3,3')).toBe('135');
    expect(normalizarDias([6, 0])).toBe('06');
    expect(normalizarDias('')).toBe('0123456');
    // 2026-11-23 é segunda; 02h UTC de terça ainda é segunda 23h em Brasília.
    expect(diaDaSemanaLocal(new Date('2026-11-24T02:00:00Z'))).toBe(1);
    expect(diaPermitido('12345', new Date('2026-11-22T15:00:00Z'))).toBe(false); // domingo
    expect(diaPermitido('12345', new Date('2026-11-23T15:00:00Z'))).toBe(true);
    expect(diaPermitido(undefined, new Date('2026-11-22T15:00:00Z'))).toBe(true);
    const now = new Date('2026-11-23T12:00:00Z');
    expect(validarAgendamento(new Date('2026-11-24T12:00:00Z'), now)).toBeNull();
    expect(validarAgendamento(new Date('2026-11-23T11:00:00Z'), now)).toMatch(/futuro/);
    expect(validarAgendamento(new Date('2027-03-01T12:00:00Z'), now)).toMatch(/60 dias/);
    expect(validarAgendamento(new Date('x'), now)).toMatch(/inválid/);
  });
});
