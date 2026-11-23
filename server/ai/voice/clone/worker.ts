/**
 * v1.47.0 — Cliente do servidor de voz (MCK Voz, voice-worker/): clonagem de voz grátis no nosso servidor.
 *
 * Configuração (Render › Environment): VOICE_WORKER_URL (https://…) e VOICE_WORKER_SECRET (o mesmo da VM).
 * Cada pedido é assinado com HMAC-SHA256 sobre "<ts>.<nonce>.<MÉTODO>.<caminho>.<sha256(corpo)>" (anti-replay no worker).
 * Sem a configuração, a voz clonada fica "aguardando servidor" e a IA segue com texto/biblioteca.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

export interface WorkerJob { status: 'queued' | 'running' | 'done' | 'error'; error?: string; code?: string; rate?: number; pcm16_b64?: string; seconds?: number }
export interface VoiceWorkerClient {
  configured(): boolean;
  health(): Promise<{ ok: boolean; ready: boolean; queue: number }>;
  register(voiceId: string, audio: Buffer): Promise<{ job_id: string }>;
  tts(voiceId: string, text: string): Promise<{ job_id: string } | { missing: true }>;
  /** Modo rápido: troca o timbre de um áudio-base pela voz clonada. */
  convert(voiceId: string, base: Buffer, baseKey: string): Promise<{ job_id: string } | { missing: true }>;
  job(jobId: string): Promise<WorkerJob>;
  remove(voiceId: string): Promise<void>;
}

export class WorkerError extends Error {
  constructor(message: string, public status = 0, public code = '') { super(message); }
}

/** Assinatura: HMAC-SHA256(segredo, "<ts>.<nonce>.<MÉTODO>.<caminho>.<sha256(corpo)>"); nonce aleatório = cada pedido é único (anti-replay). */
export function signRequest(secret: string, method: string, path: string, body: string, ts = Math.floor(Date.now() / 1000), nonce = randomBytes(12).toString('hex')): { ts: string; nonce: string; sig: string } {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const sig = createHmac('sha256', secret).update(`${ts}.${nonce}.${method.toUpperCase()}.${path}.${bodyHash}`).digest('hex');
  return { ts: String(ts), nonce, sig };
}

export class HttpVoiceWorker implements VoiceWorkerClient {
  constructor(private base = (process.env.VOICE_WORKER_URL ?? '').replace(/\/+$/, ''), private secret = process.env.VOICE_WORKER_SECRET ?? '') {}
  /** Só HTTPS (ou http no próprio computador, para testes locais). */
  configured() { return (/^https:\/\//.test(this.base) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(this.base)) && this.secret.length >= 32; }

  private async call(method: string, path: string, body?: unknown, timeoutMs = 20000): Promise<any> {
    if (!this.configured()) throw new WorkerError('Servidor de voz não configurado', 0, 'not_configured');
    const raw = body === undefined ? '' : JSON.stringify(body);
    const { ts, nonce, sig } = signRequest(this.secret, method, path, raw);
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method, body: raw || undefined, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-mck-ts': ts, 'x-mck-nonce': nonce, 'x-mck-sig': sig },
      });
    } catch (e) {
      throw new WorkerError(`Servidor de voz fora do ar (${(e as Error).name === 'TimeoutError' ? 'tempo esgotado' : 'sem conexão'})`, 0, 'down');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new WorkerError(String(data?.error ?? `Servidor de voz respondeu ${res.status}`), res.status, String(data?.code ?? ''));
    return data;
  }
  async health() {
    if (!this.configured()) return { ok: false, ready: false, queue: 0 };
    try {
      const r = await fetch(this.base + '/healthz', { signal: AbortSignal.timeout(8000), redirect: 'error' });
      const j: any = await r.json().catch(() => ({}));
      return { ok: r.ok && !!j.ok, ready: !!j.ready, queue: Number(j.queue ?? 0) };
    } catch { return { ok: false, ready: false, queue: 0 }; }
  }
  register(voiceId: string, audio: Buffer) { return this.call('POST', `/v1/voices/${voiceId}`, { audio_b64: audio.toString('base64') }, 60000); }
  async tts(voiceId: string, text: string) {
    try { return await this.call('POST', '/v1/tts', { voice_id: voiceId, text }); } catch (e) {
      if (e instanceof WorkerError && e.code === 'voice_missing') return { missing: true as const };
      throw e;
    }
  }
  async convert(voiceId: string, base: Buffer, baseKey: string) {
    try { return await this.call('POST', '/v1/convert', { voice_id: voiceId, audio_b64: base.toString('base64'), base_key: baseKey }); } catch (e) {
      if (e instanceof WorkerError && e.code === 'voice_missing') return { missing: true as const };
      throw e;
    }
  }
  job(jobId: string) { return this.call('GET', `/v1/jobs/${jobId}`); }
  async remove(voiceId: string) { await this.call('DELETE', `/v1/voices/${voiceId}`); }
}

let current: VoiceWorkerClient | null = null;
export const voiceWorker = (): VoiceWorkerClient => (current ??= new HttpVoiceWorker());
/** Só testes: troca o cliente (null volta ao HTTP). */
export function setVoiceWorkerForTests(c: VoiceWorkerClient | null) { current = c; healthCache = null; }

let healthCache: { at: number; ok: boolean; ready: boolean; queue: number } | null = null;
/** Situação do servidor de voz com cache de 60 s (não atrasa respostas quando ele está fora). */
export async function workerStatus(force = false): Promise<{ configured: boolean; ok: boolean; ready: boolean; queue: number }> {
  const w = voiceWorker();
  if (!w.configured()) return { configured: false, ok: false, ready: false, queue: 0 };
  if (!force && healthCache && Date.now() - healthCache.at < 60_000) return { configured: true, ...healthCache };
  const h = await w.health();
  healthCache = { at: Date.now(), ...h };
  return { configured: true, ...h };
}
export function markWorkerDown() { healthCache = { at: Date.now(), ok: false, ready: false, queue: 0 }; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Espera um pedido da fila terminar (consulta a cada `everyMs`). */
export async function waitJob(jobId: string, timeoutMs: number, everyMs = 800): Promise<WorkerJob> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const j = await voiceWorker().job(jobId);
    if (j.status === 'done' || j.status === 'error') return j;
    if (Date.now() + everyMs > until) throw new WorkerError('Servidor de voz demorou demais', 0, 'timeout');
    await sleep(process.env.NODE_ENV === 'test' ? 5 : everyMs);
  }
}
