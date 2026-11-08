/**
 * Voz da IA (v1.23.0): transcrição (ouvir) e síntese de voz (falar) por provedor.
 *
 * - Google Gemini (camada gratuita): transcreve com o modelo configurado da organização (áudio inline no
 *   generateContent) e fala com um modelo TTS do Gemini (padrão gemini-3.8-flash-lite-tts, escolhido entre
 *   os que a chave enxerga). O áudio volta em WAV/PCM 24 kHz e vira OGG/Opus aqui (ogg.ts, sem ffmpeg).
 * - OpenAI ou compatível: /audio/transcriptions (Groq: whisper-large-v3-turbo; OpenAI: gpt-4o-mini-transcribe;
 *   outros: whisper-1) e /audio/speech com response_format "opus" (já sai OGG/Opus).
 * - ElevenLabs (voz mais humana; chave própria do cliente, cifrada): /v1/text-to-speech em pcm_24000 (liberado no
 *   plano grátis deles) → OGG/Opus aqui; transcrição /v1/speech-to-text com scribe_v2; vozes por GET /v1/voices.
 * - MCK IA: chaves da plataforma (MCK_IA_GEMINI_KEY; transcrição também pelo Groq, se houver MCK_IA_GROQ_KEY).
 * - fake: só nos testes (NODE_ENV=test), cobre todos os motores.
 *
 * O cliente escolhe o motor da voz (voiceProvider: gemini | openai | elevenlabs) e o da transcrição
 * (transcribeProvider: auto = o mesmo da IA de texto | gemini | openai | elevenlabs).
 */
import { httpFetch } from '../../lib/fetcher.js';
import { safeFetch } from '../../lib/ssrf.js';
import { AiProviderError, listGeminiModels, parseGeminiResponse } from '../providers.js';
import { mckIaChain, type MckIaLink } from '../mckIa.js';
import { decodePcm, isOggOpus, oggOpusDurationSec, pcmToOggOpus } from './ogg.js';
import { openAiVoiceFor, estimateSpeechSeconds, OPENAI_VOICES, isKnownVoice, DEFAULT_VOICE } from './spoken.js';

export interface TranscribeResult { text: string; model: string; promptTokens: number; completionTokens: number }
export interface TtsResult { ogg: Buffer; seconds: number; waveform?: Uint8Array; model: string; promptTokens: number; completionTokens: number }
export interface TtsOptions { voice: string; style: string; timeoutMs?: number; /** modelo de voz escolhido (ElevenLabs) */ model?: string }
export interface VoiceProvider {
  name: string;
  transcribe(audio: Buffer, mime: string, opts?: { timeoutMs?: number }): Promise<TranscribeResult>;
  tts(text: string, opts: TtsOptions): Promise<TtsResult>;
}

/** Tempo máximo de cada chamada de voz (ms). AI_VOICE_TIMEOUT_MS; padrão 40 s. */
export function voiceTimeoutMs(): number {
  const v = Number(process.env.AI_VOICE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 40000;
}

/** Marcador que o modelo devolve quando não há fala compreensível. */
export const INAUDIBLE = '[INAUDIVEL]';
const TRANSCRIBE_PROMPT = `Transcreva fielmente a fala deste áudio de WhatsApp (português do Brasil, pode ter gírias). Responda SOMENTE com a transcrição, sem comentários, aspas ou marcação de tempo. Se não houver fala compreensível, responda exatamente ${INAUDIBLE}.`;

const baseMime = (mime: string) => (mime.split(';')[0].trim().toLowerCase() || 'audio/ogg');

async function readJson(res: Response): Promise<any> {
  const raw = await res.text();
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
const wrap = (e: unknown, who: string, timeoutMs: number) => {
  if (e instanceof AiProviderError) return e;
  const err = e as Error;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new AiProviderError('timeout', `${who} não respondeu em ${Math.round(timeoutMs / 1000)} s`, true);
  return new AiProviderError('network', `Falha de conexão com ${who}: ${err?.message ?? String(e)}`, true);
};
const httpErr = (who: string, status: number, msg?: string) => new AiProviderError('http', msg ?? `${who} retornou HTTP ${status}`, status === 429 || status >= 500, String(status));

// ---------- Gemini ----------
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.8-flash-lite-tts';

/**
 * Modelo TTS do Gemini entre os que a chave enxerga. Puro, testável.
 * GEMINI_TTS_MODEL no ambiente força (opcional). Prefere o gemini-3.8-flash-lite-tts (GA, grátis, feito para
 * conversa); senão o TTS Flash estável mais novo; nunca "pro" (sem camada gratuita).
 */
export function pickGeminiTtsModel(available: string[], env: Record<string, string | undefined> = process.env): string {
  const forced = (env.GEMINI_TTS_MODEL ?? '').trim();
  if (forced) return forced;
  const tts = [...new Set(available.map((m) => m.replace(/^models\//, '')))].filter((m) => /tts/.test(m) && /flash/.test(m) && !/pro/.test(m));
  if (!tts.length || tts.includes(DEFAULT_GEMINI_TTS_MODEL)) return DEFAULT_GEMINI_TTS_MODEL;
  const ver = (m: string) => Number(m.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const score = (m: string) => (/(preview|exp)/.test(m) ? 0 : 1000) + ver(m) * 10 + (/lite/.test(m) ? 1 : 0);
  return tts.sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
}

/** Corpo do pedido de voz. Gemini ≥ 3.8: texto literal + speech_metadata.style; anteriores: estilo como prefixo. */
export function geminiTtsBody(model: string, text: string, voice: string, style: string, shape: 'novo' | 'antigo' = geminiTtsShape(model)): Record<string, unknown> {
  if (shape === 'novo') {
    return {
      contents: [{ role: 'user', parts: [{ text, ...(style ? { speech_metadata: { style } } : {}) }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice } } },
    };
  }
  return {
    contents: [{ role: 'user', parts: [{ text: style ? `${style}\n\n${text}` : text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  };
}
export const geminiTtsShape = (model: string): 'novo' | 'antigo' => (Number(model.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 99) >= 3.8 ? 'novo' : 'antigo');

/** Extrai o áudio (base64) da resposta do Gemini. */
export function geminiAudioOf(json: any): { data: Buffer; mime: string } {
  const parts = json?.candidates?.[0]?.content?.parts;
  const p = Array.isArray(parts) ? parts.find((x: any) => x?.inlineData?.data || x?.inline_data?.data) : null;
  const inline = p?.inlineData ?? p?.inline_data;
  if (!inline?.data) {
    const reason = json?.promptFeedback?.blockReason ?? json?.candidates?.[0]?.finishReason;
    throw new AiProviderError(reason && reason !== 'STOP' ? 'blocked' : 'empty', `Gemini não devolveu áudio${reason ? ` (${reason})` : ''}`, true, reason);
  }
  return { data: Buffer.from(String(inline.data), 'base64'), mime: String(inline.mimeType ?? inline.mime_type ?? '') };
}

export class GeminiVoice implements VoiceProvider {
  name = 'gemini';
  constructor(private apiKey: string, private chatModel: string, private baseUrl = GEMINI_BASE) {}

  async transcribe(audio: Buffer, mime: string, opts: { timeoutMs?: number } = {}): Promise<TranscribeResult> {
    const timeoutMs = opts.timeoutMs ?? voiceTimeoutMs();
    try {
      const res = await httpFetch(`${this.baseUrl}/models/${encodeURIComponent(this.chatModel)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: TRANSCRIBE_PROMPT }, { inlineData: { mimeType: baseMime(mime), data: audio.toString('base64') } }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = await readJson(res);
      if (!res.ok) throw httpErr('Gemini', res.status, json?.error?.message);
      const r = parseGeminiResponse(json);
      return { text: r.text, model: this.chatModel, promptTokens: r.promptTokens, completionTokens: r.completionTokens };
    } catch (e) {
      throw wrap(e, 'Gemini', timeoutMs);
    }
  }

  async tts(text: string, opts: TtsOptions): Promise<TtsResult> {
    const timeoutMs = opts.timeoutMs ?? voiceTimeoutMs();
    const model = pickGeminiTtsModel(await listGeminiModels(this.apiKey, this.baseUrl));
    try {
      const call = (shape: 'novo' | 'antigo') => httpFetch(`${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(geminiTtsBody(model, text, isKnownVoice(opts.voice) ? opts.voice : DEFAULT_VOICE, opts.style, shape)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const first = geminiTtsShape(model);
      let res = await call(first);
      let json = await readJson(res);
      // Formato do pedido recusado (modelo de outra geração): tenta o outro formato uma vez.
      if (res.status === 400) {
        res = await call(first === 'novo' ? 'antigo' : 'novo');
        json = await readJson(res);
      }
      if (!res.ok) throw httpErr('Gemini (voz)', res.status, json?.error?.message);
      const audio = geminiAudioOf(json);
      const enc = isOggOpus(audio.data) ? { ogg: audio.data, seconds: oggOpusDurationSec(audio.data) ?? 0, waveform: undefined } : pcmToOggOpus(decodePcm(audio.data, audio.mime));
      return { ...enc, model, promptTokens: json?.usageMetadata?.promptTokenCount ?? 0, completionTokens: json?.usageMetadata?.candidatesTokenCount ?? 0 };
    } catch (e) {
      throw wrap(e, 'Gemini (voz)', timeoutMs);
    }
  }
}

// ---------- OpenAI e compatíveis ----------
export function openAiTranscribeModel(baseUrl: string): string {
  if (/groq\.com/i.test(baseUrl)) return 'whisper-large-v3-turbo';
  if (/api\.openai\.com/i.test(baseUrl)) return 'gpt-4o-mini-transcribe';
  return 'whisper-1';
}

export class OpenAiVoice implements VoiceProvider {
  name = 'openai';
  constructor(private apiKey: string, private baseUrl = 'https://api.openai.com/v1') {}
  private get doFetch() { return /^https:\/\/api\.(openai|groq)\.com\//.test(this.baseUrl) ? httpFetch : safeFetch; }
  private url(path: string) { return `${this.baseUrl.replace(/\/$/, '')}${path}`; }

  async transcribe(audio: Buffer, mime: string, opts: { timeoutMs?: number } = {}): Promise<TranscribeResult> {
    const timeoutMs = opts.timeoutMs ?? voiceTimeoutMs();
    const model = openAiTranscribeModel(this.baseUrl);
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: baseMime(mime) }), 'audio.ogg');
      form.append('model', model);
      form.append('language', 'pt');
      form.append('response_format', 'json');
      const res = await this.doFetch(this.url('/audio/transcriptions'), { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body: form, signal: AbortSignal.timeout(timeoutMs) });
      const json = await readJson(res);
      if (!res.ok) throw httpErr('Provedor (transcrição)', res.status, json?.error?.message);
      const text = String(json?.text ?? '').trim();
      if (!text) throw new AiProviderError('empty', 'Transcrição vazia', true);
      return { text, model, promptTokens: 0, completionTokens: Math.ceil(text.length / 4) };
    } catch (e) {
      throw wrap(e, 'Provedor de IA (transcrição)', timeoutMs);
    }
  }

  async tts(text: string, opts: TtsOptions): Promise<TtsResult> {
    if (/groq\.com/i.test(this.baseUrl)) throw new AiProviderError('http', 'Este provedor não tem voz em português; use o Google Gemini para respostas em áudio', false, '400');
    const timeoutMs = opts.timeoutMs ?? voiceTimeoutMs();
    const official = /api\.openai\.com/i.test(this.baseUrl);
    const model = official ? 'gpt-4o-mini-tts' : 'tts-1';
    try {
      const res = await this.doFetch(this.url('/audio/speech'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text, voice: OPENAI_VOICES.some((v) => v.id === opts.voice) ? opts.voice : openAiVoiceFor(opts.voice), response_format: 'opus', ...(official && opts.style ? { instructions: opts.style } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { const json = await readJson(res); throw httpErr('Provedor (voz)', res.status, json?.error?.message); }
      const ogg = Buffer.from(await res.arrayBuffer());
      if (!isOggOpus(ogg)) throw new AiProviderError('parse', 'O provedor não devolveu áudio OGG/Opus', false);
      return { ogg, seconds: oggOpusDurationSec(ogg) ?? estimateSpeechSeconds(text), model, promptTokens: Math.ceil(text.length / 4), completionTokens: 0 };
    } catch (e) {
      throw wrap(e, 'Provedor de IA (voz)', timeoutMs);
    }
  }
}

// ---------- ElevenLabs (chave própria do cliente) ----------
export const ELEVEN_BASE = 'https://api.elevenlabs.io';
export const ELEVEN_MODELS = ['eleven_multilingual_v2', 'eleven_flash_v2_5'] as const;
export const ELEVEN_STT_MODEL = 'scribe_v2';
export interface VoiceOption { id: string; label: string; genero?: string; previewUrl?: string | null }

/** Corpo do pedido de voz da ElevenLabs. language_code só no Flash v2.5 (o Multilingual v2 detecta sozinho). */
export function elevenTtsBody(text: string, model: string): Record<string, unknown> {
  const m = (ELEVEN_MODELS as readonly string[]).includes(model) ? model : ELEVEN_MODELS[0];
  return {
    text, model_id: m,
    ...(m === 'eleven_flash_v2_5' ? { language_code: 'pt' } : {}),
    voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
  };
}

export class ElevenLabsVoice implements VoiceProvider {
  name = 'elevenlabs';
  constructor(private apiKey: string, private baseUrl = ELEVEN_BASE) {}

  async transcribe(audio: Buffer, mime: string, opts: { timeoutMs?: number } = {}): Promise<TranscribeResult> {
    const timeoutMs = opts.timeoutMs ?? voiceTimeoutMs();
    try {
      const form = new FormData();
      form.append('model_id', ELEVEN_STT_MODEL);
      form.append('language_code', 'por');
      form.append('file', new Blob([new Uint8Array(audio)], { type: baseMime(mime) }), 'audio.ogg');
      const res = await httpFetch(`${this.baseUrl}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': this.apiKey }, body: form, signal: AbortSignal.timeout(timeoutMs) });
      const json = await readJson(res);
      if (!res.ok) throw httpErr('ElevenLabs (transcrição)', res.status, json?.detail?.message ?? (typeof json?.detail === 'string' ? json.detail : undefined));
      const text = String(json?.text ?? '').trim();
      if (!text) throw new AiProviderError('empty', 'Transcrição vazia', true);
      return { text, model: ELEVEN_STT_MODEL, promptTokens: 0, completionTokens: Math.ceil(text.length / 4) };
    } catch (e) {
      throw wrap(e, 'ElevenLabs (transcrição)', timeoutMs);
    }
  }

  async tts(text: string, opts: TtsOptions): Promise<TtsResult> {
    if (!opts.voice || !/^[\w-]{6,64}$/.test(opts.voice)) throw new AiProviderError('http', 'Escolha uma voz da ElevenLabs em Inteligência artificial › Voz', false, '400');
    const timeoutMs = opts.timeoutMs ?? voiceTimeoutMs();
    const body = elevenTtsBody(text, opts.model ?? '');
    try {
      const res = await httpFetch(`${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(opts.voice)}?output_format=pcm_24000`, {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'audio/*' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { const json = await readJson(res); throw httpErr('ElevenLabs (voz)', res.status, json?.detail?.message ?? (typeof json?.detail === 'string' ? json.detail : undefined)); }
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length < 100) throw new AiProviderError('empty', 'ElevenLabs não devolveu áudio', true);
      const enc = isOggOpus(data) ? { ogg: data, seconds: oggOpusDurationSec(data) ?? 0, waveform: undefined } : pcmToOggOpus(decodePcm(data, 'audio/l16; rate=24000'));
      return { ...enc, model: String(body.model_id), promptTokens: text.length, completionTokens: 0 };
    } catch (e) {
      throw wrap(e, 'ElevenLabs (voz)', timeoutMs);
    }
  }

  /** Vozes da conta (premade + clonadas/da biblioteca adicionadas pelo cliente). */
  async voices(timeoutMs = 15000): Promise<VoiceOption[]> {
    try {
      const res = await httpFetch(`${this.baseUrl}/v1/voices`, { headers: { 'xi-api-key': this.apiKey }, signal: AbortSignal.timeout(timeoutMs) });
      const json = await readJson(res);
      if (!res.ok) throw httpErr('ElevenLabs', res.status, res.status === 401 ? 'Chave da ElevenLabs recusada' : json?.detail?.message);
      const list = Array.isArray(json?.voices) ? json.voices : [];
      return list.filter((v: any) => v?.voice_id).map((v: any) => {
        const g = String(v?.labels?.gender ?? '').toLowerCase();
        const genero = g === 'female' ? 'feminina' : g === 'male' ? 'masculina' : undefined;
        const extra = [genero, v?.labels?.accent, v?.labels?.description ?? v?.labels?.descriptive].filter(Boolean).join(', ');
        return { id: String(v.voice_id), label: `${String(v.name ?? v.voice_id).slice(0, 60)}${extra ? ` — ${extra}` : ''}`, genero, previewUrl: typeof v?.preview_url === 'string' ? v.preview_url : null };
      });
    } catch (e) {
      throw wrap(e, 'ElevenLabs', timeoutMs);
    }
  }
}

// ---------- MCK IA (chaves da plataforma) ----------
export class MckVoice implements VoiceProvider {
  name = 'mck';
  lastUsed: string | null = null;
  constructor(private chain: MckIaLink[] = mckIaChain()) {}
  private gemini() { const l = this.chain.find((x) => x.name === 'gemini'); return l ? { link: l, p: new GeminiVoice(l.key, l.model) } : null; }
  private groq() { const l = this.chain.find((x) => x.name === 'groq'); return l ? { link: l, p: new OpenAiVoice(l.key, l.baseUrl) } : null; }

  async transcribe(audio: Buffer, mime: string, opts: { timeoutMs?: number } = {}): Promise<TranscribeResult> {
    const opts2 = [this.gemini(), this.groq()].filter(Boolean) as { link: MckIaLink; p: VoiceProvider }[];
    if (!opts2.length) throw new AiProviderError('http', 'MCK IA sem transcrição de áudio configurada', false);
    let last: unknown = null;
    for (const o of opts2) {
      try { const r = await o.p.transcribe(audio, mime, opts); this.lastUsed = `${o.link.name}:${r.model}`; return r; } catch (e) { last = e; }
    }
    if (last instanceof AiProviderError) throw new AiProviderError(last.code, 'MCK IA indisponível no momento', last.retryable, last.detail);
    throw new AiProviderError('network', 'MCK IA indisponível no momento', true);
  }

  async tts(text: string, opts: TtsOptions): Promise<TtsResult> {
    const g = this.gemini();
    if (!g) throw new AiProviderError('http', 'MCK IA sem voz configurada', false);
    try {
      const r = await g.p.tts(text, opts);
      this.lastUsed = `gemini:${r.model}`;
      return r;
    } catch (e) {
      const err = e as AiProviderError;
      throw new AiProviderError(err.code ?? 'network', 'MCK IA indisponível no momento', !!err.retryable, err.detail);
    }
  }
}
export const mckVoiceReady = (env: Record<string, string | undefined> = process.env) => mckIaChain(env).some((l) => l.name === 'gemini');

// ---------- Testes ----------
/**
 * Só para testes: transcrição pelo próprio conteúdo ("FAKE:texto" → "texto"; "FALHAR" → erro; outro → "áudio de teste")
 * e voz sintética (seno) passando pelo codificador Opus de verdade.
 */
export const fakeVoice: { transcribed: number; tts: string[]; engines: string[]; voices: string[]; failTts: boolean } = { transcribed: 0, tts: [], engines: [], voices: [], failTts: false };
export class FakeVoice implements VoiceProvider {
  name = 'fake';
  constructor(private engine = 'fake') {}
  async transcribe(audio: Buffer): Promise<TranscribeResult> {
    fakeVoice.transcribed++;
    fakeVoice.engines.push(`stt:${this.engine}`);
    const s = audio.toString('utf8');
    if (s.startsWith('FALHAR')) throw new AiProviderError('http', 'Falha simulada na transcrição', false, '500');
    if (s.startsWith('MUDO')) return { text: INAUDIBLE, model: 'fake-stt', promptTokens: 5, completionTokens: 1 };
    const text = s.startsWith('FAKE:') ? s.slice(5).trim() : 'áudio de teste';
    return { text, model: 'fake-stt', promptTokens: 10, completionTokens: Math.ceil(text.length / 4) };
  }
  async tts(text: string, opts?: TtsOptions): Promise<TtsResult> {
    fakeVoice.tts.push(text);
    fakeVoice.engines.push(`tts:${this.engine}`);
    if (opts?.voice) fakeVoice.voices.push(opts.voice);
    if (fakeVoice.failTts) throw new AiProviderError('http', 'Falha simulada na voz', false, '500');
    const seconds = Math.min(3, Math.max(0.5, estimateSpeechSeconds(text) / 10));
    const rate = 24000;
    const samples = new Int16Array(Math.round(rate * seconds));
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / rate));
    return { ...pcmToOggOpus({ samples, rate }), model: 'fake-tts', promptTokens: 5, completionTokens: 25 };
  }
}

// ---------- Escolha do motor por organização ----------
export type VoiceEngine = 'gemini' | 'openai' | 'elevenlabs';
export const VOICE_ENGINES: readonly VoiceEngine[] = ['gemini', 'openai', 'elevenlabs'];
export const TRANSCRIBE_ENGINES = ['auto', 'gemini', 'openai', 'elevenlabs'] as const;

/** Configuração e chaves (já decifradas) que os motores de voz usam. */
export interface VoiceKeys {
  /** provedor da IA de texto: gemini | openai | mck | fake */
  provider: string;
  model: string;
  apiKey: string | null;
  baseUrl?: string | null;
  /** chave da ElevenLabs (só se o cliente salvou) */
  voiceApiKey: string | null;
}

/** Motor efetivo da transcrição: "auto" segue a IA de texto (MCK IA usa as chaves da plataforma). */
export function sttEngineOf(transcribeProvider: string, textProvider: string): VoiceEngine | 'mck' | 'fake' {
  if (textProvider === 'fake') return 'fake';
  if ((VOICE_ENGINES as readonly string[]).includes(transcribeProvider)) return transcribeProvider as VoiceEngine;
  if (textProvider === 'mck') return 'mck';
  return textProvider === 'openai' ? 'openai' : 'gemini';
}

/** Chave do Gemini disponível: a da organização (provedor Gemini) ou a da plataforma (MCK IA). */
function geminiKeyOf(k: VoiceKeys): { key: string; model: string; platform: boolean } | null {
  if (k.provider === 'gemini' && k.apiKey) return { key: k.apiKey, model: k.model, platform: false };
  if (k.provider === 'mck') { const l = mckIaChain().find((x) => x.name === 'gemini'); return l ? { key: l.key, model: l.model, platform: true } : null; }
  return null;
}

/** Erro claro (vai para o log e para a prévia) quando o motor escolhido não tem chave. */
const noKey = (msg: string) => new AiProviderError('http', msg, false, '400');

/**
 * Provedor para FALAR com o motor escolhido. `usageProvider` = como o uso é registrado (MCK IA conta na cota
 * da plataforma; ElevenLabs/OpenAI usam a chave do cliente). Lança AiProviderError se faltar chave.
 */
export function buildTts(engine: string, k: VoiceKeys): { p: VoiceProvider; usageProvider: string } {
  const e = (VOICE_ENGINES as readonly string[]).includes(engine) ? (engine as VoiceEngine) : 'gemini';
  if (k.provider === 'fake') {
    if (process.env.NODE_ENV !== 'test') throw new Error('Provedor de teste não pode ser usado fora dos testes');
    if (e === 'elevenlabs' && !k.voiceApiKey) throw noKey('Cole a sua chave da ElevenLabs para usar essa voz');
    return { p: new FakeVoice(e), usageProvider: e === 'gemini' ? 'fake' : e };
  }
  if (e === 'elevenlabs') {
    if (!k.voiceApiKey) throw noKey('Cole a sua chave da ElevenLabs para usar essa voz');
    return { p: new ElevenLabsVoice(k.voiceApiKey), usageProvider: 'elevenlabs' };
  }
  if (e === 'openai') {
    if (k.provider !== 'openai' || !k.apiKey) throw noKey('A voz da OpenAI usa a chave da OpenAI da IA de texto (Provedor: OpenAI)');
    return { p: new OpenAiVoice(k.apiKey, k.baseUrl || undefined), usageProvider: 'openai' };
  }
  const g = geminiKeyOf(k);
  if (!g) throw noKey('A voz do Gemini precisa de uma chave do Google Gemini (Provedor: Google Gemini ou MCK IA)');
  return g.platform ? { p: new MckVoice(), usageProvider: 'mck' } : { p: new GeminiVoice(g.key, g.model), usageProvider: 'gemini' };
}

/** Provedor para OUVIR (transcrever) com o motor escolhido. */
export function buildStt(transcribeProvider: string, k: VoiceKeys): { p: VoiceProvider; usageProvider: string } {
  const e = sttEngineOf(transcribeProvider, k.provider);
  if (e === 'fake') {
    if (process.env.NODE_ENV !== 'test') throw new Error('Provedor de teste não pode ser usado fora dos testes');
    const named = (VOICE_ENGINES as readonly string[]).includes(transcribeProvider) ? transcribeProvider : 'fake';
    if (named === 'elevenlabs' && !k.voiceApiKey) throw noKey('Cole a sua chave da ElevenLabs para transcrever com ela');
    return { p: new FakeVoice(named), usageProvider: named };
  }
  if (e === 'mck') return { p: new MckVoice(), usageProvider: 'mck' };
  if (e === 'elevenlabs') {
    if (!k.voiceApiKey) throw noKey('Cole a sua chave da ElevenLabs para transcrever com ela');
    return { p: new ElevenLabsVoice(k.voiceApiKey), usageProvider: 'elevenlabs' };
  }
  if (e === 'openai') {
    if (k.provider === 'openai' && k.apiKey) return { p: new OpenAiVoice(k.apiKey, k.baseUrl || undefined), usageProvider: 'openai' };
    if (k.provider === 'mck') { const l = mckIaChain().find((x) => x.name === 'groq'); if (l) return { p: new OpenAiVoice(l.key, l.baseUrl), usageProvider: 'mck' }; }
    throw noKey('A transcrição da OpenAI usa a chave da OpenAI da IA de texto (Provedor: OpenAI)');
  }
  const g = geminiKeyOf(k);
  if (!g) throw noKey('A transcrição do Gemini precisa de uma chave do Google Gemini (Provedor: Google Gemini ou MCK IA)');
  return g.platform ? { p: new MckVoice(), usageProvider: 'mck' } : { p: new GeminiVoice(g.key, g.model), usageProvider: 'gemini' };
}
