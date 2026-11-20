/**
 * Camada única de chamada à IA (v1.35.0) para os usos secundários (SDR, follow-up, campanhas, ERP, resposta
 * automática, voz). O atendimento principal (service.ts) já tinha a própria política de tentativas; aqui ela
 * vale para todos os outros:
 *  - modelo reserva (outro Flash grátis da mesma chave) quando a falha é passageira (timeout, rede, 429/5xx);
 *  - espera curta após 429/503;
 *  - timeout por tentativa e total;
 *  - cache curto opcional (mesma pergunta, mesmo modelo) para chamadas determinísticas;
 *  - registro em AiUsage com a finalidade e a versão do prompt (IA › Qualidade).
 * Erros sobem para quem chamou (cada uso tem a sua queda segura: texto padrão, null...).
 */
import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import { decryptOrNull } from '../lib/crypto.js';
import { createProvider, fallbackModelFor, AiProviderError, aiTimeoutMs, type ChatMessage, type ChatResult } from './providers.js';
import { MckIaProvider } from './mckIa.js';
import { promptVersion, type AiPurpose } from './prompts.js';

export interface AiChatSettings { provider: string; model: string; apiKeyEnc?: string | null; baseUrl?: string | null }

export interface AiChatArgs {
  orgId: string;
  conversationId?: string | null;
  purpose: AiPurpose;
  settings: AiChatSettings;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  /** Tempo máximo de cada tentativa (ms). Padrão: AI_TIMEOUT_MS (18 s). */
  timeoutMs?: number;
  /** Tempo total de todas as tentativas (ms). Padrão: 2,5× o da tentativa. */
  totalMs?: number;
  /** Tentativas a mais para falha passageira (padrão 1). */
  retries?: number;
  /** Guarda a resposta por este tempo (ms) para a mesma entrada. 0 = sem cache. */
  cacheTtlMs?: number;
  /** false = não grava AiUsage (quem chama grava). */
  log?: boolean;
  /** Prefixo do erro gravado em AiUsage (ex.: "SDR"). */
  errorPrefix?: string;
  /** Nome do modelo gravado em AiUsage (ex.: "mck-autoresposta"). */
  usageModel?: string;
}

export interface AiChatResult extends ChatResult { model: string; usedModel: string; cached: boolean; attempts: number }

const transient = (e: unknown) => e instanceof AiProviderError && (e.code === 'timeout' || e.code === 'network' || e.code === 'empty' || (e.code === 'http' && e.retryable));
const overloaded = (e: unknown) => e instanceof AiProviderError && e.code === 'http' && (e.detail === '429' || e.detail === '503');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoffMs = () => { const v = Number(process.env.AI_RETRY_BACKOFF_MS); return Number.isFinite(v) && v >= 0 ? v : 1500; };

const cache = new Map<string, { at: number; ttl: number; r: ChatResult; usedModel: string }>();
const MAX_CACHE = 300;
export function resetAiCache() { cache.clear(); }
function cacheKey(a: AiChatArgs): string {
  return createHash('sha256').update(JSON.stringify([a.orgId, a.purpose, a.settings.provider, a.settings.model, a.temperature, a.maxTokens, a.messages])).digest('hex');
}

/** Plano de modelos: principal, depois reserva (se houver), depois principal de novo. Puro, testável. */
export function attemptPlan(model: string, reserve: string | null, retries: number): string[] {
  const plan = [model];
  for (let i = 0; i < retries; i++) plan.push(reserve && i % 2 === 0 ? reserve : model);
  return plan;
}

export async function aiChat(a: AiChatArgs): Promise<AiChatResult> {
  const { orgId, settings: s } = a;
  const version = promptVersion(a.purpose);
  if (a.cacheTtlMs && a.cacheTtlMs > 0) {
    const k = cacheKey(a);
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < hit.ttl) return { ...hit.r, promptTokens: 0, completionTokens: 0, model: s.model, usedModel: hit.usedModel, cached: true, attempts: 0 };
  }
  const apiKey = decryptOrNull(s.apiKeyEnc ?? null);
  const perTry = a.timeoutMs ?? aiTimeoutMs();
  const total = a.totalMs ?? Math.round(perTry * 2.5);
  const reserve = await fallbackModelFor(s.provider, s.model, apiKey).catch(() => null);
  const plan = attemptPlan(s.model, reserve, Math.max(0, a.retries ?? 1));
  const started = Date.now();
  let last: unknown = null;
  let attempts = 0;
  for (const model of plan) {
    if (attempts > 0) {
      if (!transient(last)) break;
      if (overloaded(last)) await sleep(Math.min(backoffMs(), Math.max(0, total - (Date.now() - started) - 2000)));
    }
    const left = total - (Date.now() - started);
    if (attempts > 0 && left < 2000) break;
    attempts++;
    const timeoutMs = Math.max(1000, Math.min(perTry, left));
    try {
      const provider = createProvider(s.provider, apiKey, s.baseUrl);
      const r = await provider.chat(a.messages, { model, temperature: a.temperature, maxTokens: a.maxTokens, timeoutMs });
      if (!r.text?.trim()) throw new AiProviderError('empty', 'Provedor de IA devolveu resposta vazia', true);
      const usedModel = provider instanceof MckIaProvider && provider.lastUsed ? `${s.model}/${provider.lastUsed}` : model;
      if (model !== s.model) console.warn('[ia] respondido pelo modelo reserva', { orgId, purpose: a.purpose, principal: s.model, reserva: model });
      if (a.log !== false) {
        await prisma.aiUsage.create({ data: { orgId, conversationId: a.conversationId || null, provider: s.provider, model: a.usageModel ?? usedModel, promptTokens: r.promptTokens, completionTokens: r.completionTokens, latencyMs: Date.now() - started, success: true, purpose: a.purpose, promptVersion: version } }).catch(() => undefined);
      }
      if (a.cacheTtlMs && a.cacheTtlMs > 0) {
        if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
        cache.set(cacheKey(a), { at: Date.now(), ttl: a.cacheTtlMs, r, usedModel });
      }
      return { ...r, model: s.model, usedModel, cached: false, attempts };
    } catch (e) {
      last = e;
      console.warn('[ia] tentativa falhou', { orgId, purpose: a.purpose, attempt: attempts, model, code: e instanceof AiProviderError ? e.code : 'erro', error: (e as Error).message });
      if (/não configurada|desconhecido|não pode ser usado/.test((e as Error).message)) break;
    }
  }
  const msg = (last as Error | null)?.message ?? 'Sem tempo para chamar a IA';
  if (a.log !== false) {
    await prisma.aiUsage.create({ data: { orgId, conversationId: a.conversationId || null, provider: s.provider, model: a.usageModel ?? s.model, success: false, error: `${a.errorPrefix ? `${a.errorPrefix}: ` : ''}${msg}`.slice(0, 500), latencyMs: Date.now() - started, purpose: a.purpose, promptVersion: version } }).catch(() => undefined);
  }
  throw last instanceof Error ? last : new AiProviderError('timeout', msg, true);
}
