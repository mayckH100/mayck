import { describe, it, expect, afterEach } from 'vitest';
import { GeminiProvider, OpenAICompatibleProvider, AiProviderError, parseGeminiResponse, parseOpenAiResponse } from '../../server/ai/providers.js';
import { setFetch, resetFetch } from '../../server/lib/fetcher.js';
import { withTimeout } from '../../server/ai/service.js';

const opts = { model: 'gemini-3.5-flash-lite', temperature: 0.3, maxTokens: 400 };
const msgs = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'Vocês são a MCK Desenvolvimento de Sistemas LTDA?' }];
const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AiProviderError; } throw new Error('esperava erro'); };

afterEach(() => resetFetch());

describe('Gemini: respostas bloqueadas, vazias e malformadas viram erro classificado', () => {
  it('texto normal é extraído (e partes "thought" ficam de fora)', () => {
    const r = parseGeminiResponse({ candidates: [{ content: { parts: [{ text: 'pensando…', thought: true }, { text: 'Somos a MCK Desenvolvimento.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } });
    expect(r).toEqual({ text: 'Somos a MCK Desenvolvimento.', promptTokens: 5, completionTokens: 3 });
  });
  it('finishReason SAFETY / RECITATION sem texto → blocked (tenta de novo)', () => {
    for (const reason of ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT']) {
      let e: any;
      try { parseGeminiResponse({ candidates: [{ finishReason: reason }] }); } catch (x) { e = x; }
      expect(e).toBeInstanceOf(AiProviderError);
      expect(e.code).toBe('blocked');
      expect(e.retryable).toBe(true);
      expect(e.message).toContain(reason);
    }
  });
  it('promptFeedback.blockReason → blocked; candidates vazio ou ausente → empty; MAX_TOKENS sem texto → empty', () => {
    expect(() => parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/bloqueada.*SAFETY/);
    expect(() => parseGeminiResponse({ candidates: [] })).toThrow(/candidates vazio/);
    expect(() => parseGeminiResponse({})).toThrow(/candidates vazio/);
    expect(() => parseGeminiResponse({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] })).toThrow(/vazia \(MAX_TOKENS\)/);
  });
  it('OpenAI compatível: content_filter → blocked; choices vazio → empty', () => {
    expect(() => parseOpenAiResponse({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] })).toThrow(/content_filter/);
    expect(() => parseOpenAiResponse({ choices: [] })).toThrow(/choices vazio/);
    expect(parseOpenAiResponse({ choices: [{ message: { content: ' oi ' } }] }).text).toBe('oi');
  });

  it('chamada real (fetch simulado): SAFETY, JSON inválido e HTTP 500/400', async () => {
    const g = new GeminiProvider('k');
    setFetch(json({ candidates: [{ finishReason: 'SAFETY', safetyRatings: [] }] }));
    expect((await err(g.chat(msgs, opts))).code).toBe('blocked');
    setFetch(async () => new Response('<html>erro</html>', { status: 200 }));
    expect((await err(g.chat(msgs, opts))).code).toBe('parse');
    setFetch(json({ error: { message: 'interno' } }, 500));
    const e5 = await err(g.chat(msgs, opts));
    expect([e5.code, e5.retryable, e5.message]).toEqual(['http', true, 'interno']);
    setFetch(json({ error: { message: 'API key not valid' } }, 400));
    const e4 = await err(g.chat(msgs, opts));
    expect([e4.code, e4.retryable]).toEqual(['http', false]);
  });

  it('timeout: provedor que não responde é abortado no tempo configurado', async () => {
    setFetch((_i, init) => new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))); }));
    const t0 = Date.now();
    const e = await err(new GeminiProvider('k').chat(msgs, { ...opts, timeoutMs: 150 }));
    expect(e.code).toBe('timeout');
    expect(e.message).toMatch(/não respondeu/);
    expect(Date.now() - t0).toBeLessThan(3000);
    const e2 = await err(new OpenAICompatibleProvider('k').chat(msgs, { ...opts, timeoutMs: 150 }));
    expect(e2.code).toBe('timeout');
  });

  it('withTimeout rejeita promessas que nunca terminam', async () => {
    await expect(withTimeout(new Promise(() => undefined), 50, () => new Error('estourou'))).rejects.toThrow('estourou');
    await expect(withTimeout(Promise.resolve(7), 50, () => new Error('x'))).resolves.toBe(7);
  });
});
