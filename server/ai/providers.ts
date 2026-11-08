import { httpFetch } from '../lib/fetcher.js';
import { safeFetch } from '../lib/ssrf.js';

import { MckIaProvider } from './mckIa.js';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatResult { text: string; promptTokens: number; completionTokens: number }
export interface ChatOptions { model: string; temperature: number; maxTokens: number; timeoutMs?: number; /** Gemini: pesquisa Google (grounding). Se o provedor recusar, repete sem a pesquisa. */ googleSearch?: boolean }

/**
 * Falha classificada do provedor de IA. `retryable`: vale tentar de novo uma vez (timeout, resposta
 * vazia, bloqueio de segurança, HTTP 429/5xx). Erros de chave/modelo (4xx) não adiantam repetir.
 */
export type AiErrorCode = 'timeout' | 'blocked' | 'empty' | 'http' | 'network' | 'parse';
export class AiProviderError extends Error {
  constructor(public code: AiErrorCode, message: string, public retryable: boolean, public detail?: string) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** Tempo máximo de cada chamada ao provedor (ms). AI_TIMEOUT_MS no ambiente; padrão 18 s (com modelo reserva, 3 tentativas cabem no total). */
export function aiTimeoutMs(): number {
  const v = Number(process.env.AI_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 18000;
}

/** Converte erros de rede/abort em AiProviderError com texto legível. */
function fetchError(e: unknown, provider: string, timeoutMs: number): AiProviderError {
  if (e instanceof AiProviderError) return e;
  const err = e as Error;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new AiProviderError('timeout', `${provider} não respondeu em ${Math.round(timeoutMs / 1000)} s`, true);
  }
  return new AiProviderError('network', `Falha de conexão com ${provider}: ${err?.message ?? String(e)}`, true);
}

async function readJson(res: Response, provider: string): Promise<any> {
  const raw = await res.text();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    if (!res.ok) return {};
    throw new AiProviderError('parse', `${provider} devolveu uma resposta que não é JSON`, true, raw.slice(0, 200));
  }
}

/** Motivos de parada do Gemini que significam bloqueio (sem texto útil). */
const GEMINI_BLOCK = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE', 'OTHER', 'MALFORMED_FUNCTION_CALL']);

/** Extrai o texto de uma resposta do Gemini ou lança AiProviderError (bloqueio, vazio). Puro, testável. */
export function parseGeminiResponse(json: any): ChatResult {
  const usage = { promptTokens: json?.usageMetadata?.promptTokenCount ?? 0, completionTokens: json?.usageMetadata?.candidatesTokenCount ?? 0 };
  const block = json?.promptFeedback?.blockReason;
  if (block) throw new AiProviderError('blocked', `Pergunta bloqueada pelo filtro do Gemini (${block})`, true, block);
  const cands = Array.isArray(json?.candidates) ? json.candidates : [];
  if (!cands.length) throw new AiProviderError('empty', 'Gemini não devolveu nenhuma resposta (candidates vazio)', true);
  const c = cands[0];
  // Partes "thought" (raciocínio de modelos com thinking) não vão para o cliente.
  const text = (Array.isArray(c?.content?.parts) ? c.content.parts : []).filter((p: any) => !p?.thought).map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
  const reason = String(c?.finishReason ?? '');
  if (!text) {
    if (GEMINI_BLOCK.has(reason)) throw new AiProviderError('blocked', `Resposta bloqueada pelo filtro do Gemini (${reason})`, true, reason);
    throw new AiProviderError('empty', `Gemini devolveu resposta vazia${reason ? ` (${reason})` : ''}`, true, reason || undefined);
  }
  return { text, ...usage };
}

/** Idem para APIs compatíveis com OpenAI. */
export function parseOpenAiResponse(json: any): ChatResult {
  const usage = { promptTokens: json?.usage?.prompt_tokens ?? 0, completionTokens: json?.usage?.completion_tokens ?? 0 };
  const ch = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  if (!ch) throw new AiProviderError('empty', 'Provedor não devolveu nenhuma resposta (choices vazio)', true);
  const text = String(ch?.message?.content ?? '').trim();
  if (!text) {
    if (ch.finish_reason === 'content_filter') throw new AiProviderError('blocked', 'Resposta bloqueada pelo filtro do provedor (content_filter)', true, 'content_filter');
    throw new AiProviderError('empty', `Provedor devolveu resposta vazia${ch.finish_reason ? ` (${ch.finish_reason})` : ''}`, true, ch.finish_reason);
  }
  return { text, ...usage };
}

const httpError = (provider: string, status: number, msg?: string) =>
  new AiProviderError('http', msg ?? `${provider} retornou HTTP ${status}`, status === 429 || status >= 500, String(status));
export interface AiProvider { name: string; chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> }

export class OpenAICompatibleProvider implements AiProvider {
  name = 'openai';
  constructor(private apiKey: string, private baseUrl = 'https://api.openai.com/v1') {}
  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    // URL própria do cliente (compatível com OpenAI): passa pela proteção SSRF.
    const doFetch = this.baseUrl === 'https://api.openai.com/v1' ? httpFetch : safeFetch;
    const timeoutMs = opts.timeoutMs ?? aiTimeoutMs();
    try {
    const res = await doFetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, messages, temperature: opts.temperature, max_tokens: opts.maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await readJson(res, 'Provedor');
    if (!res.ok) throw httpError('Provedor', res.status, json?.error?.message);
    return parseOpenAiResponse(json);
    } catch (e) {
      throw fetchError(e, 'Provedor de IA', timeoutMs);
    }
  }
}

export class GeminiProvider implements AiProvider {
  name = 'gemini';
  constructor(private apiKey: string, private baseUrl = 'https://generativelanguage.googleapis.com/v1beta') {}
  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const timeoutMs = opts.timeoutMs ?? aiTimeoutMs();
    try {
    const call = (withSearch: boolean) => httpFetch(`${this.baseUrl}/models/${encodeURIComponent(opts.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: opts.temperature, maxOutputTokens: opts.maxTokens },
        ...(withSearch ? { tools: [{ google_search: {} }] } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let res = await call(!!opts.googleSearch);
    let json = await readJson(res, 'Gemini');
    // Pesquisa recusada (modelo/camada sem a ferramenta, cota da pesquisa esgotada): responde sem pesquisar.
    if (!res.ok && opts.googleSearch && res.status >= 400 && res.status < 500) {
      console.warn('[ia] pesquisa Google recusada pelo Gemini; respondendo sem pesquisa', { status: res.status });
      res = await call(false);
      json = await readJson(res, 'Gemini');
    }
    if (!res.ok) throw httpError('Gemini', res.status, json?.error?.message);
    return parseGeminiResponse(json);
    } catch (e) {
      throw fetchError(e, 'Gemini', timeoutMs);
    }
  }
}

/**
 * Modelo reserva do Gemini (falha 2026-11-04: modelo principal sobrecarregado, HTTP 503 "high demand" e
 * timeouts de 20 s). Escolhe, entre os modelos que a chave enxerga (ListModels, grátis), outro modelo Flash
 * da mesma camada gratuita: se o principal é "lite", usa um Flash normal; senão, um Flash-Lite. Nunca "pro"
 * (cota grátis mínima e mais lento). AI_FALLBACK_MODEL no ambiente força o modelo (vazio/"off" desliga).
 * Puro, testável.
 */
export function pickGeminiFallbackModel(primary: string, available: string[]): string | null {
  const clean = (m: string) => m.replace(/^models\//, '');
  const prim = clean(primary);
  const ver = (m: string) => Number(m.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const bad = /(pro|tts|image|imagen|live|audio|embedding|vision|thinking|computer|robotics|native|learnlm|aqa|gemma)/;
  const cands = [...new Set(available.map(clean))].filter((m) => /^gemini-\d/.test(m) && m.includes('flash') && !bad.test(m) && m !== prim);
  if (!cands.length) return null;
  const wantLite = !/lite/.test(prim);
  const score = (m: string) =>
    (/lite/.test(m) === wantLite ? 1000 : 0) + // camada oposta (mais chance de não estar sobrecarregada)
    (/(preview|exp)/.test(m) ? 0 : 200) + // estável antes de prévia
    (/-\d{3}$|-\d{2}-\d{4}$/.test(m) ? 0 : 50) + // alias ("-latest"/sem data) antes de versão fixa
    ver(m) * 10; // mais novo primeiro
  return cands.sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
}

const modelListCache = new Map<string, { at: number; models: string[] }>();
/** Modelos do Gemini que a chave pode usar com generateContent (cache de 6 h). Nunca lança: erro → lista vazia. */
export async function listGeminiModels(apiKey: string, baseUrl = 'https://generativelanguage.googleapis.com/v1beta'): Promise<string[]> {
  const hit = modelListCache.get(apiKey);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.models;
  try {
    const res = await httpFetch(`${baseUrl}/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: any = await res.json();
    const models = (Array.isArray(json?.models) ? json.models : [])
      .filter((m: any) => !Array.isArray(m?.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'))
      .map((m: any) => String(m?.name ?? '').replace(/^models\//, '')).filter(Boolean);
    modelListCache.set(apiKey, { at: Date.now(), models });
    return models;
  } catch (e) {
    console.warn('[ia] não foi possível listar os modelos do Gemini (sem modelo reserva por agora)', (e as Error).message);
    modelListCache.set(apiKey, { at: Date.now() - 5.5 * 3600_000, models: [] }); // tenta de novo em ~30 min
    return [];
  }
}

/** Modelo reserva para o provedor/modelo configurado (null = nenhum). Nunca lança. */
export async function fallbackModelFor(provider: string, model: string, apiKey: string | null): Promise<string | null> {
  const env = process.env.AI_FALLBACK_MODEL;
  if (env !== undefined) {
    const v = env.trim();
    return !v || /^(off|nao|não|none|0)$/i.test(v) || v === model ? null : v;
  }
  if (provider !== 'gemini' || !apiKey) return null;
  return pickGeminiFallbackModel(model, await listGeminiModels(apiKey));
}

/**
 * Provedor determinístico usado SOMENTE nos testes automatizados (NODE_ENV=test).
 * Responde com o trecho de contexto mais relevante; sem contexto, pede transferência.
 * Mensagens contendo "falhar" simulam erro do provedor; "inventar" simula preço inventado.
 */
/** Só para testes: respostas roteirizadas (consumidas em ordem) e as conversas que a IA recebeu. */
export const fakeAi: { script: string[]; calls: ChatMessage[][]; models: string[] } = { script: [], calls: [], models: [] };

export class FakeProvider implements AiProvider {
  name = 'fake';
  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    fakeAi.calls.push(messages);
    if (opts?.model) fakeAi.models.push(opts.model);
    const scripted = fakeAi.script.shift();
    // Roteiros especiais para simular falhas do provedor real.
    if (scripted === '__EMPTY__') throw new AiProviderError('empty', 'Gemini devolveu resposta vazia (STOP)', true);
    if (scripted === '__SAFETY__') throw new AiProviderError('blocked', 'Resposta bloqueada pelo filtro do Gemini (SAFETY)', true, 'SAFETY');
    if (scripted === '__HANG__') return new Promise<ChatResult>(() => undefined); // nunca responde
    if (scripted === '__503__') throw new AiProviderError('http', 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', true, '503');
    if (scripted !== undefined) return { text: scripted, promptTokens: 10, completionTokens: 10 };
    const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    if (/falhar/i.test(user)) throw new Error('Falha simulada do provedor');
    if (/inventar/i.test(user)) return { text: 'Custa apenas R$ 9,99 hoje!', promptTokens: 10, completionTokens: 5 };
    // Voz (testes): reescrita em estilo falado devolve o próprio texto.
    if (system.startsWith('Você reescreve respostas de atendimento')) return { text: user, promptTokens: 10, completionTokens: 10 };
    // SDR com IA (testes): extração das respostas por palavras da conversa.
    if (system.startsWith('Você analisa uma conversa de WhatsApp')) {
      const t = user.toLowerCase();
      const r: Record<string, { resposta: string; nota: number }> = {};
      if (/preciso|quero|automatizar/.test(t)) r.necessidade = { resposta: 'quer automatizar o atendimento', nota: 95 };
      if (/funcion[aá]rios|pessoas|atendentes/.test(t)) r.porte = { resposta: 'equipe pequena', nota: 70 };
      if (/urgente|essa semana|hoje|amanh[aã]/.test(t)) r.prazo = { resposta: 'urgente', nota: 95 };
      if (/or[cç]amento|r\$|reais/.test(t)) r.orcamento = { resposta: 'tem orçamento', nota: 80 };
      return { text: JSON.stringify({ respostas: r, resumo: 'lead de teste' }), promptTokens: 20, completionTokens: 20 };
    }
    if (system.includes('FORMATO DA SUA SAÍDA')) {
      const u = user.toLowerCase();
      const intencao = /sair|remov|parar/.test(u) ? 'SAIR' : /\bnão\b|nao quero|agora não|sem interesse/.test(u) ? 'NEGATIVO' : /quero|sim|pode|interess/.test(u) ? 'POSITIVO' : 'DUVIDA';
      const text = JSON.stringify({ intencao, resposta: `Resposta ${intencao.toLowerCase()} da IA`, resumo: `lead ${intencao.toLowerCase()}` });
      return { text, promptTokens: 20, completionTokens: 10 };
    }
    // Agenda: "agendar" escolhe o 1º horário livre do prompt; "quero o horário X" confirma esse horário.
    if (system.includes('HORÁRIOS LIVRES:') && /agendar|marcar|confirm/i.test(user)) {
      const pick = user.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/)?.[1] ?? system.split('HORÁRIOS LIVRES:')[1].match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/)?.[1];
      if (pick) {
        const text = `Combinado, reunião marcada!\n[AGENDAR:{"inicio":"${pick}","duracao":30,"titulo":"Reunião de teste"}]`;
        return { text, promptTokens: 30, completionTokens: 20 };
      }
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
  // MCK IA: chaves da própria plataforma (sem chave do cliente).
  if (provider === 'mck') return new MckIaProvider();
  if (!apiKey) throw new Error('Chave de API da IA não configurada');
  if (provider === 'gemini') return new GeminiProvider(apiKey);
  if (provider === 'openai') return new OpenAICompatibleProvider(apiKey, baseUrl || undefined);
  throw new Error(`Provedor de IA desconhecido: ${provider}`);
}
