import { describe, it, expect } from 'vitest';
import { contextoLines, empresaUsaEmoji, polirResposta, frasesDeRobo } from '../../server/sdr/conversa.js';

/** v1.26.0: IA conversacional avançada — funções puras (dados fictícios). */
describe('IA conversacional avançada (puro)', () => {
  it('contexto: sem lead não gera nada; com lead lista respostas já dadas e o que falta', () => {
    expect(contextoLines(null)).toEqual([]);
    const l = contextoLines({ nome: 'Ana', empresa: 'Loja X', receita: { razaoSocial: 'Loja X Ltda', atividade: 'Comércio', cidade: 'Campinas', uf: 'SP', situacao: 'ATIVA' }, etapa: 'Qualificado', pontuacao: 55, temperatura: 'MORNO', respondidas: [{ pergunta: 'Qual o orçamento?', resposta: 'até 500' }], faltam: ['Qual o prazo?'], objecoes: ['Está caro'], campanha: 'Black Friday', resumo: null }).join('\n');
    expect(l).toContain('Receita Federal: Loja X Ltda, Comércio, Campinas/SP (situação ativa)');
    expect(l).toContain('Qual o orçamento? → até 500');
    expect(l).toContain('Veio da campanha: Black Friday');
    expect(l).toContain('AINDA NÃO SABEMOS: Qual o prazo?');
  });

  it('estilo: tira frases de robô, emoji (empresa sem emoji) e nome repetido', () => {
    expect(polirResposta('Entendido perfeitamente! Ótima pergunta. O seguro cobre incêndio. 😊', { usaEmoji: false })).toBe('O seguro cobre incêndio.');
    expect(polirResposta('Claro! Fico feliz em ajudar. Posso te mandar a proposta? 😊', { usaEmoji: true })).toBe('Claro! Posso te mandar a proposta? 😊');
    expect(polirResposta('Oi Ana, tudo certo por aqui. Posso seguir, Ana?', { usaEmoji: false, nome: 'Ana Souza', nomeRecente: true })).toBe('Oi, tudo certo por aqui. Posso seguir?');
    expect(polirResposta('Oi Ana, tudo certo?', { usaEmoji: false, nome: 'Ana', nomeRecente: false })).toBe('Oi Ana, tudo certo?');
    expect(frasesDeRobo('Entendido perfeitamente. Espero ter ajudado!')).toHaveLength(2);
    expect(empresaUsaEmoji('Somos a Loja 😊')).toBe(true);
    expect(empresaUsaEmoji('Somos a Loja', null)).toBe(false);
  });
});
