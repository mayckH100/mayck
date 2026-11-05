import { describe, it, expect } from 'vitest';
import { mckIaChain, mckIaReady, MckIaProvider, type MckIaLink } from '../../server/ai/mckIa.js';
import { AiProviderError, createProvider, type AiProvider } from '../../server/ai/providers.js';

const msgs = [{ role: 'user' as const, content: 'oi' }];
const opts = { model: 'mck-ia', temperature: 0.3, maxTokens: 100, timeoutMs: 20000 };

describe('MCK IA', () => {
  it('monta a corrente na ordem Gemini → Groq → OpenRouter, só com as chaves presentes', () => {
    expect(mckIaChain({})).toEqual([]);
    expect(mckIaReady({})).toBe(false);
    const c = mckIaChain({ MCK_IA_OPENROUTER_KEY: 'k3', MCK_IA_GEMINI_KEY: 'k1', MCK_IA_GROQ_MODEL: 'x' });
    expect(c.map((l) => l.name)).toEqual(['gemini', 'openrouter']);
    expect(c[1].baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('passa para o próximo provedor quando um falha e registra quem respondeu', async () => {
    const chain: MckIaLink[] = [{ name: 'gemini', key: 'a', model: 'g' }, { name: 'groq', key: 'b', model: 'l' }];
    const seen: string[] = [];
    const make = (l: MckIaLink): AiProvider => ({ name: l.name, chat: async (_m, o) => {
      seen.push(o.model);
      if (l.name === 'gemini') throw new AiProviderError('http', 'cota', true, '429');
      return { text: 'olá', promptTokens: 1, completionTokens: 1 };
    } });
    const p = new MckIaProvider(chain, make);
    const r = await p.chat(msgs, opts);
    expect(r.text).toBe('olá');
    expect(seen).toEqual(['g', 'l']);
    expect(p.lastUsed).toBe('groq:l');
  });

  it('falha clara quando todos falham ou nada está configurado', async () => {
    const make = (): AiProvider => ({ name: 'x', chat: async () => { throw new AiProviderError('http', 'erro 503', true, '503'); } });
    await expect(new MckIaProvider([{ name: 'gemini', key: 'a', model: 'g' }], make).chat(msgs, opts)).rejects.toThrow(/^MCK IA indisponível no momento$/);
    await expect(new MckIaProvider([], make).chat(msgs, opts)).rejects.toThrow(/não configurada/);
  });

  it('createProvider aceita "mck" sem chave do cliente', () => {
    expect(createProvider('mck', null).name).toBe('mck');
  });
});
