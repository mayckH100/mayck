import { describe, it, expect } from 'vitest';
import { mckDailyLimit, tierFromSubscriptions, spDayStart, quotaView, clientUsageRow, providerOfModel, MCK_QUOTA_REASON } from '../../server/ai/mckQuota.js';

const future = new Date(Date.now() + 10 * 86_400_000);
const past = new Date(Date.now() - 86_400_000);

describe('MCK IA: cota diária (regras puras)', () => {
  it('limites padrão por plano e override por variável (0 = sem limite; inválido = padrão)', () => {
    expect([mckDailyLimit('teste', {}), mckDailyLimit('pago', {}), mckDailyLimit('completo', {})]).toEqual([30, 300, 600]);
    expect(mckDailyLimit('teste', { MCK_IA_DAILY_TRIAL: '5' })).toBe(5);
    expect(mckDailyLimit('pago', { MCK_IA_DAILY_PAID: '0' })).toBe(0);
    expect(mckDailyLimit('completo', { MCK_IA_DAILY_COMBO: 'abc' })).toBe(600);
  });
  it('plano pelas assinaturas: teste, pago (um produto) e completo (os dois)', () => {
    expect(tierFromSubscriptions([{ product: 'MCKBOT', status: 'TRIAL', validUntil: future }])).toBe('teste');
    expect(tierFromSubscriptions([{ product: 'MCKBOT', status: 'ATIVA', validUntil: past }])).toBe('teste');
    expect(tierFromSubscriptions([{ product: 'MCKBOT', status: 'ATIVA', validUntil: future }, { product: 'MCKMENSAGEM', status: 'TRIAL', validUntil: future }])).toBe('pago');
    expect(tierFromSubscriptions([{ product: 'MCKBOT', status: 'ATIVA', validUntil: future }, { product: 'MCKMENSAGEM', status: 'ATIVA', validUntil: future }])).toBe('completo');
  });
  it('dia começa à meia-noite de Brasília', () => {
    expect(spDayStart(new Date('2026-11-06T02:30:00Z')).toISOString()).toBe('2026-11-05T03:00:00.000Z');
    expect(spDayStart(new Date('2026-11-06T03:30:00Z')).toISOString()).toBe('2026-11-06T03:00:00.000Z');
  });
  it('situação da cota e linha do cliente sem provedor', () => {
    expect(quotaView('teste', 30, 30)).toMatchObject({ reached: true, remaining: 0, percent: 100 });
    expect(quotaView('pago', 10, 0)).toMatchObject({ reached: false, remaining: null, percent: null });
    expect(clientUsageRow({ provider: 'mck', model: 'mck-ia/groq:llama', error: 'Groq HTTP 429' })).toMatchObject({ provider: 'MCK IA', model: '', error: 'MCK IA indisponível no momento' });
    expect(clientUsageRow({ provider: 'mck', model: 'mck-ia', error: MCK_QUOTA_REASON }).error).toBe(MCK_QUOTA_REASON);
    expect(clientUsageRow({ provider: 'gemini', model: 'g', error: null })).toMatchObject({ provider: 'gemini', model: 'g' });
    expect(providerOfModel('mck-ia/openrouter:meta/x')).toBe('openrouter');
    expect(providerOfModel('mck-ia')).toBe('não registrado');
  });
});
