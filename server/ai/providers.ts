import { httpFetch } from '../lib/fetcher.js';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatResult { text: string; promptTokens: number; completionTokens: number }
export interface ChatOptions { model: string; temperature: number; maxTokens: number }
export interface AiProvider { name: string; chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> }

export class OpenAICompatibleProvider implements AiProvider {
  name = 'openai';
  constructor(private apiKey: string, private baseUrl = 'https://api.openai.com/v1') {}
  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const res = await httpFetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, messages, temperature: opts.temperature, max_tokens: opts.maxTokens }),
      signal: AbortSignal.timeout(30000),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(json?.error?.message ?? `Provedor retornou HTTP ${res.status}`);
    return {
      text: String(json.choices?.[0]?.message?.content ?? '').trim(),
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    };
  }
}

export class GeminiProvider implements AiProvider {
  name = 'gemini';
  constructor(private apiKey: string, private baseUrl = 'https://generativelanguage.googleapis.com/v1beta') {}
  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const res = await httpFetch(`${this.baseUrl}/models/${encodeURIComponent(opts.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: opts.temperature, maxOutputTokens: opts.maxTokens },
      }),
      signal: AbortSignal.timeout(30000),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(json?.error?.message ?? `Gemini retornou HTTP ${res.status}`);
    const text = (json.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('').trim();
    return { text, promptTokens: json.usageMetadata?.promptTokenCount ?? 0, completionTokens: json.usageMetadata?.candidatesTokenCount ?? 0 };
  }
}

/**
 * Provedor determinístico usado SOMENTE nos testes automatizados (NODE_ENV=test).
 * Responde com o trecho de contexto mais relevante; sem contexto, pede transferência.
 * Mensagens contendo "falhar" simulam erro do provedor; "inventar" simula preço inventado.
 */
export class FakeProvider implements AiProvider {
  name = 'fake';
  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    if (/falhar/i.test(user)) throw new Error('Falha simulada do provedor');
    if (/inventar/i.test(user)) return { text: 'Custa apenas R$ 9,99 hoje!', promptTokens: 10, completionTokens: 5 };
    if (system.includes('QUALIFICAR o lead')) {
      const u = user.toLowerCase();
      const intencao = /sair|remov|parar/.test(u) ? 'SAIR' : /\bnão\b|nao quero|agora não|sem interesse/.test(u) ? 'NEGATIVO' : /quero|sim|pode|interess/.test(u) ? 'POSITIVO' : 'DUVIDA';
      const text = JSON.stringify({ intencao, resposta: `Resposta ${intencao.toLowerCase()} da IA`, resumo: `lead ${intencao.toLowerCase()}` });
      return { text, promptTokens: 20, completionTokens: 10 };
    }
    const rawCtx = system.split('### CONTEXTO')[1]?.split('### FIM')[0]?.trim() ?? '';
    const ctx = rawCtx.startsWith('(nenhuma informação') ? '' : rawCtx;
    const text = ctx ? `Segundo nossas informações: ${ctx.split('\n').find((l) => l.trim() && !l.startsWith('['))?.trim()}` : '[TRANSFERIR]';
    return { text, promptTokens: Math.ceil((system.length + user.length) / 4), completionTokens: Math.ceil(text.length / 4) };
  }
}

export function createProvider(provider: string, apiKey: string | null, baseUrl?: string | null): AiProvider {
  if (provider === 'fake') {
    if (process.env.NODE_ENV !== 'test') throw new Error('Provedor de teste não pode ser usado fora dos testes');
    return new FakeProvider();
  }
  if (!apiKey) throw new Error('Chave de API da IA não configurada');
  if (provider === 'gemini') return new GeminiProvider(apiKey);
  if (provider === 'openai') return new OpenAICompatibleProvider(apiKey, baseUrl || undefined);
  throw new Error(`Provedor de IA desconhecido: ${provider}`);
}
