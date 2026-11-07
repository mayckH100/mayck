import { describe, it, expect } from 'vitest';
import { explainScore, questionsForMetodo, METODO_QUESTIONS, metodoPromptLine, normalizeMetodo } from '../../server/sdr/intel.js';
import { computeScore, mergeAnswers, DEFAULT_QUESTIONS } from '../../server/sdr/core.js';

/** SDR fase 2 (v1.21.0): regras puras da inteligência. */
describe('SDR inteligência — 1) método e explicação', () => {
  it('método escolhe as perguntas; Padrão mantém as da empresa', () => {
    expect(questionsForMetodo('PADRAO', DEFAULT_QUESTIONS)).toBe(DEFAULT_QUESTIONS);
    expect(questionsForMetodo('BANT', DEFAULT_QUESTIONS).map((q) => q.id)).toEqual(['necessidade', 'orcamento', 'decisor', 'prazo']);
    expect(questionsForMetodo('SPIN', []).map((q) => q.id)).toEqual(['situacao', 'problema', 'implicacao', 'necessidade']);
    expect(normalizeMetodo('spin')).toBe('SPIN');
    expect(normalizeMetodo('x')).toBe('PADRAO');
    expect(metodoPromptLine('PADRAO')).toBe('');
    expect(metodoPromptLine('SPIN')).toMatch(/SPIN/);
  });
  it('explica a pontuação: pontos somam o total, fortes/fracos/faltas e próximo passo', () => {
    const qs = METODO_QUESTIONS.BANT;
    const ans = mergeAnswers(qs, {}, { necessidade: { resposta: 'Perco vendas no WhatsApp', nota: 90, motivo: 'dor clara' }, prazo: { resposta: 'este mês', nota: 95 }, orcamento: { resposta: 'não sei', nota: 20 } });
    expect(ans.necessidade.motivo).toBe('dor clara');
    const score = computeScore(qs, ans);
    const e = explainScore(qs, ans, score, 'MORNO');
    expect(e.fatores.reduce((s, f) => s + f.pontos, 0)).toBeGreaterThanOrEqual(score - 2);
    expect(e.porque).toContain('Puxou para cima: necessidade');
    expect(e.porque).toContain('Puxou para baixo: orçamento');
    expect(e.faltam).toEqual(['decisor']);
    expect(e.proximaAcao).toContain('decisor');
    expect(explainScore(qs, ans, 80, 'QUENTE').proximaAcao).toMatch(/Priorize/);
  });
});

import { DEFAULT_OBJECOES, detectObjecao, normalizeObjecoes, objecoesPromptLines } from '../../server/sdr/intel.js';
describe('SDR inteligência — 2) objeções', () => {
  it('detecta por gatilho sem acento/maiúsculas e monta o prompt', () => {
    expect(detectObjecao('Achei MUITO caro, viu', DEFAULT_OBJECOES)?.id).toBe('preco');
    expect(detectObjecao('Ja tenho fornecedor pra isso', DEFAULT_OBJECOES)?.id).toBe('fornecedor');
    expect(detectObjecao('me manda por email por favor', DEFAULT_OBJECOES)?.id).toBe('email');
    expect(detectObjecao('Quero sim, vamos marcar', DEFAULT_OBJECOES)).toBeNull();
    expect(detectObjecao('caroline aqui', DEFAULT_OBJECOES)).toBeNull(); // palavra inteira
    const lines = objecoesPromptLines(DEFAULT_OBJECOES, DEFAULT_OBJECOES[0]);
    expect(lines.join('\n')).toMatch(/nunca invente preço/);
    expect(lines.at(-1)).toContain('Preço');
  });
  it('normaliza itens editados (gatilhos por vírgula, descarta incompletos)', () => {
    const r = normalizeObjecoes([{ titulo: 'Prazo de entrega', gatilhos: 'demora, prazo longo', resposta: 'Informe o prazo real.' }, { titulo: 'x', gatilhos: '', resposta: 'y' }]);
    expect(r).toEqual([{ id: 'prazo_de_entrega', titulo: 'Prazo de entrega', gatilhos: ['demora', 'prazo longo'], resposta: 'Informe o prazo real.' }]);
  });
});

import { findCnpjIn } from '../../server/sdr/cnpj.js';
describe('SDR inteligência — 3) CNPJ', () => {
  it('acha CNPJ válido no texto (com ou sem máscara) e ignora inválidos', () => {
    expect(findCnpjIn('meu cnpj é 11.222.333/0001-81, obrigado')).toBe('11222333000181');
    expect(findCnpjIn('11222333000181')).toBe('11222333000181');
    expect(findCnpjIn('11.222.333/0001-80')).toBeNull();
    expect(findCnpjIn('telefone 5511999998888')).toBeNull();
    expect(findCnpjIn(null)).toBeNull();
  });
});

import { buildHandoff, handoffLines } from '../../server/sdr/intel.js';
import { hotAlertText } from '../../server/sdr/service.js';
describe('SDR inteligência — 4) resumo do handoff', () => {
  it('monta dor/orçamento/prazo/decisor/próximo passo de qualquer método', () => {
    const h = buildHandoff({ problema: { resposta: 'perde leads', nota: 80 }, implicacao: { resposta: 'R$ 5 mil/mês', nota: 90 }, prazo: { resposta: 'já', nota: 90 } }, { stage: 'QUALIFICADO', temperature: 'QUENTE', aiSummary: 'quer automatizar', score: 80 }, 'Priorize');
    expect(h).toMatchObject({ dor: 'perde leads — R$ 5 mil/mês', orcamento: null, prazo: 'já', decisor: null, proximoPasso: 'Priorize', resumo: 'quer automatizar' });
    expect(handoffLines(h)).toEqual(['Dor: perde leads — R$ 5 mil/mês', 'Orçamento: não informado', 'Prazo: já', 'Decisor: não informado', 'Próximo passo: Priorize']);
    expect(buildHandoff({}, { stage: 'REUNIAO', temperature: 'MORNO', aiSummary: null, score: 50 }, 'x').proximoPasso).toMatch(/Reunião marcada/);
    const t = hotAlertText({ name: 'Ana', company: null, score: 80, summary: null, url: 'u', extra: ['Dor: x'] });
    expect(t.split('\n')).toEqual(['🔥 Lead quente (80/100): Ana', 'Dor: x', 'A IA continua a conversa normalmente; nada foi transferido.', 'Abrir: u']);
  });
});
