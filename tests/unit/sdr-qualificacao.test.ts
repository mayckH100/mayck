import { describe, it, expect } from 'vitest';
import { fromLegacy, toLegacy, normalizeQualificacao, qualiPromptLines, DEFAULT_LEAD_AI } from '../../server/sdr/qualificacao.js';

/** v1.20.0: mapeamento da antiga "IA de qualificação" (LeadAiSettings) para a etapa de qualificação do SDR com IA. */
describe('SDR com IA — mapeamento da qualificação antiga', () => {
  const antiga = {
    enabled: true, instructions: 'Somos corretora: descubra o veículo e o vencimento do seguro.', offer: 'cotação sem compromisso',
    positiveAction: 'FLOW', positiveFlowId: 'fluxo-1', retryDays: 5, maxAttempts: 4, promptTemplate: 'Você é a Bia, da corretora. {proximo_passo}',
    positiveMessage: 'Me chama aqui, {nome}', negativeAction: 'DISCARD', negativeFlowId: null, doubtAction: 'HANDOFF', doubtFlowId: null,
    tagPositive: 'quer-cotacao', tagWaiting: 'esperar', tagDiscarded: '', retryMessage: 'Oi {nome}, ainda quer a cotação?',
  };

  it('converte todos os campos (abordagem, próximo passo, ações, tentativas, etiquetas, persona)', () => {
    const q = fromLegacy(antiga);
    expect(q).toEqual({
      campanhas: true, abordagem: antiga.instructions, proximoPasso: 'cotação sem compromisso', persona: antiga.promptTemplate,
      positivo: { acao: 'FLOW', fluxoId: 'fluxo-1', mensagem: 'Me chama aqui, {nome}' },
      negativo: { acao: 'DISCARD', fluxoId: null }, duvida: { acao: 'HANDOFF', fluxoId: null },
      tentativas: { dias: 5, max: 4, mensagem: 'Oi {nome}, ainda quer a cotação?' },
      etiquetas: { positivo: 'quer-cotacao', aguardando: 'esperar', descartado: '' },
    });
  });

  it('ida e volta não perde nada: o motor antigo recebe exatamente a configuração antiga', () => {
    expect(toLegacy(fromLegacy(antiga))).toEqual(antiga);
    expect(toLegacy(normalizeQualificacao(JSON.parse(JSON.stringify(fromLegacy(antiga)))))).toEqual(antiga);
  });

  it('sem linha antiga: padrões de antes (desligada, atendente no positivo, nova tentativa no negativo)', () => {
    expect(toLegacy(fromLegacy(null))).toEqual(DEFAULT_LEAD_AI);
    expect(toLegacy(normalizeQualificacao({}))).toEqual(DEFAULT_LEAD_AI);
  });

  it('valores inválidos voltam ao padrão e respeitam os limites', () => {
    const q = fromLegacy({ positiveAction: 'XPTO', negativeAction: '', doubtAction: 'FOO', retryDays: 999, maxAttempts: 0, retryMessage: '  ', promptTemplate: '   ' } as any);
    expect(q.positivo.acao).toBe('HANDOFF');
    expect(q.negativo.acao).toBe('RETRY');
    expect(q.duvida.acao).toBe('AI');
    expect(q.tentativas).toEqual({ dias: 60, max: 1, mensagem: DEFAULT_LEAD_AI.retryMessage });
    expect(q.persona).toBeNull();
  });

  it('abordagem e próximo passo entram no prompt do SDR só quando preenchidos', () => {
    expect(qualiPromptLines({ abordagem: '', proximoPasso: ' ' })).toEqual([]);
    const l = qualiPromptLines({ abordagem: 'Pergunte o modelo do carro.', proximoPasso: 'cotação sem compromisso' }).join('\n');
    expect(l).toContain('Pergunte o modelo do carro.');
    expect(l).toContain('Próximo passo para quem tem interesse: cotação sem compromisso');
  });
});
