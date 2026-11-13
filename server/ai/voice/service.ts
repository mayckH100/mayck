/**
 * Voz da IA (v1.23.0): ouvir (transcrever) áudios dos clientes e falar (responder com nota de voz).
 *
 * Tudo conta no uso da IA como as respostas de texto: cada transcrição e cada áudio gerado é um registro
 * em AiUsage (limite diário de respostas, limite mensal de tokens e cota diária da MCK IA). Nenhuma função
 * aqui lança: falha vira { ok: false, reason } e quem chamou cai no texto.
 */
import type { AiSettings } from '@prisma/client';
import { prisma } from '../../db.js';
import { decryptOrNull } from '../../lib/crypto.js';
import { createProvider, AiProviderError } from '../providers.js';
import { HANDOFF_TOKEN } from '../guard.js';
import { mckQuotaStatus } from '../mckQuota.js';
import { buildStt, buildTts, voiceTimeoutMs, INAUDIBLE, MckVoice, type TtsResult, type VoiceKeys, type VoiceProvider } from './providers.js';
import {
  splitForVoice, cleanForSpeech, spokenRewritePrompt, estimateSpeechSeconds,
  DEFAULT_VOICE_BY_ENGINE, DEFAULT_VOICE_STYLE, MAX_INBOUND_AUDIO_BYTES, MAX_INBOUND_AUDIO_SECONDS,
} from './spoken.js';
import { oggOpusDurationSec } from './ogg.js';

const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);

/** Chaves decifradas para os motores de voz (nunca saem do servidor). */
export const voiceKeysOf = (s: AiSettings): VoiceKeys => ({ provider: s.provider, model: s.model, apiKey: decryptOrNull(s.apiKeyEnc), baseUrl: s.baseUrl, voiceApiKey: decryptOrNull(s.voiceApiKeyEnc) });

/**
 * Motivo de bloqueio pelos limites de uso (null = pode usar). Mesmas regras das respostas de texto; a cota
 * diária da MCK IA só vale quando a voz/transcrição usa as chaves da plataforma (`usageProvider` = 'mck').
 */
export async function voiceQuotaBlock(orgId: string, s: AiSettings, usageProvider: string = s.provider): Promise<string | null> {
  const [today, monthAgg] = await Promise.all([
    prisma.aiUsage.count({ where: { orgId, createdAt: { gte: startOfDay() } } }),
    prisma.aiUsage.aggregate({ where: { orgId, createdAt: { gte: startOfMonth() } }, _sum: { promptTokens: true, completionTokens: true } }),
  ]);
  const monthTokens = (monthAgg._sum.promptTokens ?? 0) + (monthAgg._sum.completionTokens ?? 0);
  // v1.27.2: "Usar limite de uso" desligado vale também para ouvir e responder áudio.
  if (s.usageLimitEnabled !== false && (today >= s.dailyLimit || monthTokens >= s.monthlyTokenLimit)) return 'Limite de uso da IA atingido';
  if (usageProvider === 'mck') {
    const q = await mckQuotaStatus(orgId).catch(() => null);
    if (q?.reached) return 'Limite diário da MCK IA atingido';
  }
  return null;
}

function usageModel(s: AiSettings, kind: 'transcricao' | 'voz', model: string, provider: VoiceProvider | null): string {
  if (provider instanceof MckVoice) return `${s.model}/${kind}:${provider.lastUsed ?? '?'}`;
  return `${kind}:${model}`;
}

export type TranscribeOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: string; code: 'desligada' | 'grande' | 'longo' | 'limite' | 'inaudivel' | 'falha' };

/**
 * Transcreve um áudio recebido. Só quando a IA está ativada e a transcrição ligada (padrão ligada).
 * Limites: 10 MB e 2 minutos; acima disso o cliente é convidado a escrever ou mandar um áudio menor.
 */
export async function transcribeAudio(args: { orgId: string; conversationId: string | null; audio: Buffer; mime: string; seconds?: number | null }): Promise<TranscribeOutcome> {
  const { orgId, conversationId } = args;
  const s = await prisma.aiSettings.findUnique({ where: { orgId } }).catch(() => null);
  if (!s || !s.enabled || !s.transcribeAudio) return { ok: false, code: 'desligada', reason: 'Transcrição de áudio desligada' };
  if (args.audio.length > MAX_INBOUND_AUDIO_BYTES) return { ok: false, code: 'grande', reason: 'Áudio maior que 10 MB' };
  const secs = args.seconds ?? oggOpusDurationSec(args.audio);
  if (secs && secs > MAX_INBOUND_AUDIO_SECONDS) return { ok: false, code: 'longo', reason: `Áudio com mais de ${MAX_INBOUND_AUDIO_SECONDS / 60} minutos` };
  let built: { p: VoiceProvider; usageProvider: string };
  try {
    built = buildStt(s.transcribeProvider, voiceKeysOf(s));
  } catch (e) {
    const msg = (e as Error).message;
    console.warn('[voz] transcrição sem motor configurado', { orgId, conversationId, error: msg });
    await prisma.aiUsage.create({ data: { orgId, conversationId, provider: s.provider, model: `transcricao:${s.transcribeProvider}`, success: false, error: `Transcrição: ${msg}`.slice(0, 500) } }).catch(() => undefined);
    return { ok: false, code: 'falha', reason: msg };
  }
  const blocked = await voiceQuotaBlock(orgId, s, built.usageProvider).catch(() => null);
  if (blocked) {
    await prisma.aiUsage.create({ data: { orgId, conversationId, provider: built.usageProvider, model: `transcricao:${s.model}`, success: false, error: blocked } }).catch(() => undefined);
    return { ok: false, code: 'limite', reason: blocked };
  }
  const started = Date.now();
  try {
    const r = await built.p.transcribe(args.audio, args.mime, { timeoutMs: voiceTimeoutMs() });
    const text = r.text.replace(/\s+/g, ' ').trim();
    await prisma.aiUsage.create({ data: { orgId, conversationId, provider: built.usageProvider, model: usageModel(s, 'transcricao', r.model, built.p), promptTokens: r.promptTokens, completionTokens: r.completionTokens, success: true, latencyMs: Date.now() - started } }).catch(() => undefined);
    if (!text || text.includes(INAUDIBLE)) return { ok: false, code: 'inaudivel', reason: 'Não deu para entender o áudio' };
    return { ok: true, text: text.slice(0, 4000) };
  } catch (e) {
    const msg = (e as Error).message;
    console.warn('[voz] falha ao transcrever áudio', { orgId, conversationId, error: msg });
    await prisma.aiUsage.create({ data: { orgId, conversationId, provider: built.usageProvider, model: `transcricao:${s.model}`, success: false, error: `Transcrição: ${msg}`.slice(0, 500), latencyMs: Date.now() - started } }).catch(() => undefined);
    return { ok: false, code: 'falha', reason: 'Falha ao transcrever o áudio' };
  }
}

/** Números/valores do texto (ex.: "22", "22,00"): a reescrita para fala não pode perder nenhum. */
const numbersOf = (t: string) => (t.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/[.,]00$/, ''));

/**
 * Reescreve a resposta em estilo falado (IA da organização, tempo curto). Qualquer problema (falha,
 * pedido de transferência, valor perdido, texto muito maior) → fica o texto limpo original.
 */
export async function rewriteForSpeech(s: AiSettings, spoken: string): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
  const base = { text: spoken, promptTokens: 0, completionTokens: 0 };
  if (spoken.length < 40) return base; // frase curta já é natural
  try {
    const p = createProvider(s.provider, decryptOrNull(s.apiKeyEnc), s.baseUrl);
    const r = await p.chat([{ role: 'system', content: spokenRewritePrompt() }, { role: 'user', content: spoken }], { model: s.model, temperature: 0.4, maxTokens: Math.max(200, s.maxTokens), timeoutMs: 12000 });
    const out = cleanForSpeech(r.text);
    if (!out || out.includes(HANDOFF_TOKEN) || out.length > spoken.length * 1.6 + 40) return base;
    const have = numbersOf(out).join(' ');
    if (numbersOf(spoken).some((n) => !have.includes(n))) return base;
    return { text: out, promptTokens: r.promptTokens, completionTokens: r.completionTokens };
  } catch {
    return base;
  }
}

export type VoiceOutcome =
  | { ok: true; audio: TtsResult; spoken: string; extra: string }
  | { ok: false; reason: string };

/** Gera a nota de voz da resposta. `extra` = links/detalhes para mandar por escrito logo depois. */
export async function synthesizeReply(args: { orgId: string; conversationId: string | null; text: string; settings?: AiSettings | null; rewrite?: boolean; requireEnabled?: boolean }): Promise<VoiceOutcome> {
  const { orgId, conversationId } = args;
  const s = args.settings ?? await prisma.aiSettings.findUnique({ where: { orgId } }).catch(() => null);
  if (!s || (args.requireEnabled !== false && !s.enabled)) return { ok: false, reason: 'IA desativada' };
  const split = splitForVoice(args.text);
  if (!split.spoken) return { ok: false, reason: 'Resposta sem texto para falar' };
  const max = Math.max(5, s.voiceMaxSeconds || 45);
  // Muito longa mesmo antes de reescrever: vai como texto (não gasta cota).
  if (estimateSpeechSeconds(split.spoken) > max * 1.8) return { ok: false, reason: 'Resposta longa demais para áudio' };
  let built: { p: VoiceProvider; usageProvider: string };
  try {
    built = buildTts(s.voiceProvider, voiceKeysOf(s));
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const blocked = await voiceQuotaBlock(orgId, s, built.usageProvider).catch(() => null);
  if (blocked) return { ok: false, reason: blocked };
  const started = Date.now();
  const rw = args.rewrite === false ? { text: split.spoken, promptTokens: 0, completionTokens: 0 } : await rewriteForSpeech(s, split.spoken);
  if (estimateSpeechSeconds(rw.text) > max) return { ok: false, reason: 'Resposta longa demais para áudio' };
  try {
    const voice = s.voiceName || DEFAULT_VOICE_BY_ENGINE[s.voiceProvider] || '';
    const audio = await built.p.tts(rw.text, { voice, style: (s.voiceStyle || DEFAULT_VOICE_STYLE).slice(0, 500), model: s.voiceModel || undefined, timeoutMs: voiceTimeoutMs() });
    await prisma.aiUsage.create({ data: { orgId, conversationId, provider: built.usageProvider, model: usageModel(s, 'voz', audio.model, built.p), promptTokens: audio.promptTokens + rw.promptTokens, completionTokens: audio.completionTokens + rw.completionTokens, success: true, latencyMs: Date.now() - started } }).catch(() => undefined);
    if (audio.seconds > max + 15) return { ok: false, reason: 'Áudio gerado ficou longo demais' };
    return { ok: true, audio, spoken: rw.text, extra: split.extra };
  } catch (e) {
    const msg = (e as Error).message;
    console.warn('[voz] falha ao gerar áudio', { orgId, conversationId, engine: s.voiceProvider, error: msg, code: e instanceof AiProviderError ? e.code : undefined });
    await prisma.aiUsage.create({ data: { orgId, conversationId, provider: built.usageProvider, model: `voz:${s.voiceProvider}`, success: false, error: `Voz: ${msg}`.slice(0, 500), latencyMs: Date.now() - started } }).catch(() => undefined);
    return { ok: false, reason: msg.startsWith('Escolha') || msg.startsWith('Cole') ? msg : `Falha ao gerar o áudio: ${msg}` };
  }
}
