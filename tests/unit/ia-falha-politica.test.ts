import { describe, it, expect, afterEach } from 'vitest';
import { pickGeminiFallbackModel } from '../../server/ai/providers.js';
import { failureTextForStreak, SECOND_FAILURE_TEXT } from '../../server/ai/failurePolicy.js';
import { aiFailureAlertText, alertEnabled, aiFailureOrgWindowMs, aiFailureAlertWindowMs } from '../../server/whatsapp/staffAlerts.js';

/** Falha de 2026-11-04 (forza seguros): Gemini sobrecarregado (503 + timeouts de 20 s) e o cliente recebeu 2x o mesmo texto de falha. */
describe('modelo reserva do Gemini', () => {
  const list = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash-preview', 'gemini-3.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-tts', 'text-embedding-004', 'gemma-3-27b-it', 'gemini-2.0-flash-001'];
  it('principal "lite" → Flash normal estável mais novo (nunca pro, tts, prévia se houver estável)', () => {
    expect(pickGeminiFallbackModel('gemini-3.5-flash-lite', list)).toBe('gemini-3.5-flash');
  });
  it('principal Flash → Flash-Lite mais novo', () => {
    expect(pickGeminiFallbackModel('gemini-3.5-flash', list)).toBe('gemini-3.5-flash-lite');
    expect(pickGeminiFallbackModel('models/gemini-2.5-flash', list.map((m) => `models/${m}`))).toBe('gemini-3.5-flash-lite');
  });
  it('nunca devolve o próprio principal; lista vazia ou sem Flash → null', () => {
    expect(pickGeminiFallbackModel('gemini-3.5-flash-lite', ['gemini-3.5-flash-lite'])).toBeNull();
    expect(pickGeminiFallbackModel('gemini-3.5-flash', [])).toBeNull();
    expect(pickGeminiFallbackModel('gemini-3.5-flash', ['gemini-3.5-pro', 'text-embedding-004'])).toBeNull();
  });
  it('só prévia disponível → usa a prévia', () => {
    expect(pickGeminiFallbackModel('gemini-3.5-flash', ['gemini-3.5-flash', 'gemini-3.6-flash-lite-preview'])).toBe('gemini-3.6-flash-lite-preview');
  });
});

describe('texto de falha não se repete', () => {
  const FAIL = 'Desculpe, não consegui responder agora.';
  it('1ª falha: texto normal; 2ª seguida: texto de instabilidade com "atendente"; 3ª: nada', () => {
    expect(failureTextForStreak(null, FAIL)).toBe(FAIL);
    expect(failureTextForStreak('Olá! Como posso ajudar?', FAIL)).toBe(FAIL);
    expect(failureTextForStreak(FAIL, FAIL)).toBe(SECOND_FAILURE_TEXT);
    expect(SECOND_FAILURE_TEXT).toMatch(/"atendente"/);
    expect(failureTextForStreak(SECOND_FAILURE_TEXT, FAIL)).toBeNull();
    expect(failureTextForStreak(` ${FAIL} `, FAIL)).toBe(SECOND_FAILURE_TEXT);
  });
});

describe('alerta de falha da IA', () => {
  it('texto com empresa, contato, horário, motivo e link', () => {
    const t = aiFailureAlertText({ org: 'Forza', who: 'Ana (5511…)', when: '04/11/2026 às 13:57 (horário de Brasília)', reason: 'Provedor de IA não respondeu a tempo', error: 'Gemini não respondeu em 20 s', via: 'WhatsApp 1', url: 'https://x/inbox/c1', others: 2 });
    expect(t.split('\n')[0]).toBe('⚠️ A IA não conseguiu responder um cliente');
    expect(t).toContain('Empresa: Forza');
    expect(t).toContain('Contato: Ana (5511…)');
    expect(t).toContain('Quando: 04/11/2026 às 13:57 (horário de Brasília)');
    expect(t).toContain('Motivo: Provedor de IA não respondeu a tempo (Gemini não respondeu em 20 s)');
    expect(t).toContain('Mais 2 falha(s)');
    expect(t.endsWith('Abrir conversa: https://x/inbox/c1')).toBe(true);
  });
  it('opção "Falha da IA": ausente = ligada; false desliga', () => {
    expect(alertEnabled({}, 'ai_failure')).toBe(true);
    expect(alertEnabled({ alertAiFailure: false }, 'ai_failure')).toBe(false);
  });
});

describe('janelas do alerta de falha da IA (pedido do dono 2026-11-04: 1ª falha de cada conversa)', () => {
  const orig = { org: process.env.AI_FAILURE_ORG_ALERT_MIN, conv: process.env.AI_FAILURE_ALERT_MIN };
  afterEach(() => {
    if (orig.org === undefined) delete process.env.AI_FAILURE_ORG_ALERT_MIN; else process.env.AI_FAILURE_ORG_ALERT_MIN = orig.org;
    if (orig.conv === undefined) delete process.env.AI_FAILURE_ALERT_MIN; else process.env.AI_FAILURE_ALERT_MIN = orig.conv;
  });
  it('agrupamento por organização desligado por padrão (0)', () => {
    delete process.env.AI_FAILURE_ORG_ALERT_MIN;
    expect(aiFailureOrgWindowMs()).toBe(0);
    process.env.AI_FAILURE_ORG_ALERT_MIN = '';
    expect(aiFailureOrgWindowMs()).toBe(0);
    process.env.AI_FAILURE_ORG_ALERT_MIN = 'abc';
    expect(aiFailureOrgWindowMs()).toBe(0);
  });
  it('variável de ambiente continua como opção', () => {
    process.env.AI_FAILURE_ORG_ALERT_MIN = '5';
    expect(aiFailureOrgWindowMs()).toBe(5 * 60_000);
    process.env.AI_FAILURE_ORG_ALERT_MIN = '0';
    expect(aiFailureOrgWindowMs()).toBe(0);
  });
  it('limite por conversa segue 30 min por padrão', () => {
    delete process.env.AI_FAILURE_ALERT_MIN;
    expect(aiFailureAlertWindowMs()).toBe(30 * 60_000);
  });
});
