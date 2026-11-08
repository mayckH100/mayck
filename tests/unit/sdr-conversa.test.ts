import { describe, it, expect } from 'vitest';
import { contextoLines, empresaUsaEmoji, polirResposta, frasesDeRobo, extrairPlano, objetivoSugerido, planejamentoLines, verificarResposta, ajusteMecanico, leadIrritado, motivoHandoff, comPassagem } from '../../server/sdr/conversa.js';

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

  it('planejamento: plano sai do texto (mesmo malformado), objetivo sugerido pelo estado do lead', () => {
    expect(extrairPlano('[PLANO: intencao=preço; objetivo=QUALIFICAR]\nCusta R$ 50. Quantas pessoas usariam?')).toEqual({ plano: { intencao: 'preço', objetivo: 'QUALIFICAR' }, texto: 'Custa R$ 50. Quantas pessoas usariam?' });
    expect(extrairPlano('[PLANO intencao=x objetivo=VOAR] Oi')).toEqual({ plano: null, texto: 'Oi' });
    expect(extrairPlano('Sem plano.').plano).toBeNull();
    const base = { nome: null, empresa: null, receita: null, etapa: 'Respondeu', pontuacao: 10, temperatura: 'FRIO', respondidas: [], faltam: ['prazo'], objecoes: [], campanha: null, resumo: null };
    expect(objetivoSugerido(base, 'OUTRO')).toBe('QUALIFICAR');
    expect(objetivoSugerido(base, 'SEM_INTERESSE')).toBe('TRATAR_OBJECAO');
    expect(objetivoSugerido({ ...base, temperatura: 'QUENTE' }, 'OUTRO')).toBe('AGENDAR');
    expect(objetivoSugerido(null, 'OUTRO')).toBe('RESPONDER');
    expect(planejamentoLines({ metodo: 'SPIN', sugerido: 'QUALIFICAR', handoff: false }).join('\n')).toMatch(/SPIN: situação[\s\S]*Não use PASSAR_VENDEDOR/);
  });

  it('checagem final: valores/prazos fora das fontes, dados sensíveis, provedor, tamanho e perguntas', () => {
    const fontes = 'Plano Básico R$ 89,90 por mês. Vistoria em até 2 dias úteis. Desconto de 10% no anual. Contato: (11) 3000-1234.';
    expect(verificarResposta('O Básico sai R$ 89,90 e a vistoria leva 2 dias. No anual tem 10%.', { fontes }).problemas).toEqual([]);
    expect(verificarResposta('Sai R$ 79,90 com entrega em 5 dias.', { fontes }).problemas).toEqual(['valor_fora']);
    expect(verificarResposta('Me passa seu CPF 123.456.789-09?', { fontes }).problemas).toContain('dado_sensivel');
    expect(verificarResposta('Fale com o Pedro: pedro@exemplo.com', { fontes }).problemas).toContain('dado_sensivel');
    expect(verificarResposta('Ligue (11) 3000-1234.', { fontes }).problemas).toEqual([]);
    expect(verificarResposta('Eu uso o Gemini para responder.', { fontes }).problemas).toEqual(['provedor']);
    expect(verificarResposta('Quer o básico? Ou o completo?', { fontes }).problemas).toEqual(['perguntas']);
    expect(verificarResposta('a'.repeat(600), { fontes }).problemas).toEqual(['longa']);
    expect(ajusteMecanico('Temos dois planos. Quer o básico? Ou o completo?')).toBe('Temos dois planos. Quer o básico?');
    expect(ajusteMecanico('Frase curta. '.repeat(60)).length).toBeLessThanOrEqual(500);
  });

  it('handoff: irritação, dúvida fora do escopo, plano e lead quente', () => {
    expect(leadIrritado('já falei isso, vocês não entendem')).toBe(true);
    expect(leadIrritado('QUERO RESOLVER ISSO HOJE AGORA')).toBe(true);
    expect(leadIrritado('ok, pode mandar a proposta')).toBe(false);
    const base = { textoLead: 'ok', plano: null, especialista: false };
    expect(motivoHandoff(base)).toBeNull();
    expect(motivoHandoff({ ...base, especialista: true })).toBe('dúvida fora das Instruções');
    expect(motivoHandoff({ ...base, plano: { intencao: 'x', objetivo: 'PASSAR_VENDEDOR' } })).toBe('hora do vendedor');
    expect(motivoHandoff({ ...base, temperatura: 'QUENTE' })).toBe('lead quente');
    expect(motivoHandoff({ ...base, temperatura: 'QUENTE', agendou: true })).toBeNull();
    expect(comPassagem('Certo.')).toMatch(/especialista da equipe/);
    expect(comPassagem('A equipe já te chama.')).toBe('A equipe já te chama.');
  });
});
