/**
 * MCK IA: a IA própria da plataforma MCK DESENVOLVIMENTO.
 *
 * O cliente escolhe o provedor "MCK IA" e não precisa de chave: a plataforma usa as próprias chaves
 * gratuitas (variáveis de ambiente no Render, nunca no repositório) e passa para o próximo provedor
 * da corrente quando um falha (cota, sobrecarga, timeout). Ordem: Gemini → Groq → OpenRouter.
 *
 * Variáveis (todas opcionais; a MCK IA fica pronta com pelo menos uma chave):
 *   MCK_IA_GEMINI_KEY      (+ MCK_IA_GEMINI_MODEL, padrão gemini-3.5-flash-lite)
 *   MCK_IA_GROQ_KEY        (+ MCK_IA_GROQ_MODEL, padrão llama-3.3-70b-versatile)
 *   MCK_IA_OPENROUTER_KEY  (+ MCK_IA_OPENROUTER_MODEL, padrão meta-llama/llama-3.3-70b-instruct:free)
 */
import { GeminiProvider, OpenAICompatibleProvider, AiProviderError, aiTimeoutMs, type AiProvider, type ChatMessage, type ChatOptions, type ChatResult } from './providers.js';

export const MCK_IA_MODEL = 'mck-ia';

export interface MckIaLink { name: 'gemini' | 'groq' | 'openrouter'; model: string; key: string; baseUrl?: string }

type Env = Record<string, string | undefined>;

/** Corrente de provedores gratuitos configurados, na ordem de tentativa. */
export function mckIaChain(env: Env = process.env): MckIaLink[] {
  const v = (k: string) => (env[k] ?? '').trim();
  const chain: MckIaLink[] = [];
  if (v('MCK_IA_GEMINI_KEY')) chain.push({ name: 'gemini', key: v('MCK_IA_GEMINI_KEY'), model: v('MCK_IA_GEMINI_MODEL') || 'gemini-3.5-flash-lite' });
  if (v('MCK_IA_GROQ_KEY')) chain.push({ name: 'groq', key: v('MCK_IA_GROQ_KEY'), model: v('MCK_IA_GROQ_MODEL') || 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' });
  if (v('MCK_IA_OPENROUTER_KEY')) chain.push({ name: 'openrouter', key: v('MCK_IA_OPENROUTER_KEY'), model: v('MCK_IA_OPENROUTER_MODEL') || 'meta-llama/llama-3.3-70b-instruct:free', baseUrl: 'https://openrouter.ai/api/v1' });
  return chain;
}

/** A plataforma tem pelo menos uma chave para a MCK IA? */
export const mckIaReady = (env: Env = process.env) => mckIaChain(env).length > 0;

/** Nomes dos provedores ativos (sem chaves), para o Painel Master. */
export const mckIaProviders = (env: Env = process.env) => mckIaChain(env).map((l) => l.name);

const defaultMake = (l: MckIaLink): AiProvider => (l.name === 'gemini' ? new GeminiProvider(l.key) : new OpenAICompatibleProvider(l.key, l.baseUrl));

export class MckIaProvider implements AiProvider {
  name = 'mck';
  /** Último provedor que respondeu (para o registro de uso). */
  lastUsed: string | null = null;
  constructor(private chain: MckIaLink[] = mckIaChain(), private make: (l: MckIaLink) => AiProvider = defaultMake) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    if (!this.chain.length) throw new AiProviderError('http', 'MCK IA não configurada', false);
    const total = opts.timeoutMs ?? aiTimeoutMs();
    const started = Date.now();
    let last: unknown = null;
    for (let i = 0; i < this.chain.length; i++) {
      const link = this.chain[i];
      const left = total - (Date.now() - started);
      if (left < 1500) break;
      // Cada elo usa no máximo a sua parte do tempo restante, para sobrar tempo aos seguintes.
      const timeoutMs = Math.max(1500, Math.floor(left / (this.chain.length - i)));
      try {
        const r = await this.make(link).chat(messages, { ...opts, model: link.model, googleSearch: false, timeoutMs });
        this.lastUsed = `${link.name}:${link.model}`;
        return r;
      } catch (e) {
        last = e;
        console.warn('[mck-ia] provedor falhou, tentando o próximo', { provider: link.name, error: (e as Error).message });
      }
    }
    // Para o cliente, só "MCK IA indisponível": quais provedores existem e qual falhou fica no log do servidor.
    console.warn('[mck-ia] nenhum provedor respondeu', { error: (last as Error | null)?.message ?? 'sem tempo' });
    if (last instanceof AiProviderError) throw new AiProviderError(last.code, 'MCK IA indisponível no momento', last.retryable, last.detail);
    throw new AiProviderError('timeout', 'MCK IA indisponível no momento', true);
  }
}
