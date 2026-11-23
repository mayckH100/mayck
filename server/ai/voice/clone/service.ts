/**
 * v1.47.0 — Voz clonada do vendedor/responsável (grátis, no nosso servidor de voz).
 *
 * Fluxo: aceite por escrito do dono da voz (LGPD: voz é dado biométrico, art. 11) → amostra de 1 a 3 minutos
 * (cifrada com AES-256-GCM no banco) → o servidor de voz aprende a voz (fila) → prévia → o dono ATIVA →
 * a IA passa a responder com áudio nessa voz (motor "Voz clonada" em IA › Voz).
 * Se o servidor de voz estiver fora, a resposta cai para o texto (ou o áudio gravado que a IA escolheu).
 * Exclusão a pedido: apaga amostra, prévia, cache e a voz no servidor de voz (o registro do aceite fica, sem áudio).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { prisma } from '../../../db.js';
import { decryptBytes, decryptOrNull, encryptBytes } from '../../../lib/crypto.js';
import { audit } from '../../../lib/audit.js';
import { AiProviderError } from '../../providers.js';
import { pcmToOggOpus } from '../ogg.js';
import { buildTts, type TranscribeResult, type TtsOptions, type TtsResult, type VoiceKeys, type VoiceProvider } from '../providers.js';
import type { VoiceProfile as VoiceProfileRow } from '@prisma/client';
import { markWorkerDown, voiceWorker, waitJob, workerStatus, WorkerError, type WorkerJob } from './worker.js';

export const CONSENT_VERSION = 'voz-v1-2026-11';
export const MIN_SAMPLE_SECONDS = 60;
export const MAX_SAMPLE_SECONDS = 180;
export const MAX_PROFILES = 5;
const MAX_ATTEMPTS = 30;
const CACHE_PER_ORG = 400;

/** Termo de autorização (o texto aceito é gravado junto do perfil, como foi mostrado). */
export function consentText(a: { ownerName: string; company: string }): string {
  return [
    `TERMO DE AUTORIZAÇÃO DE USO DE VOZ (${CONSENT_VERSION})`,
    `Eu, ${a.ownerName}, autorizo a empresa ${a.company} a usar a gravação da minha voz para criar uma voz sintética parecida com a minha, que será usada SOMENTE para responder, em áudio, os clientes da empresa no WhatsApp pelo MCKBOT.`,
    'Sei que a voz é dado pessoal sensível (biométrico) e dou este consentimento de forma livre, específica e destacada (LGPD, art. 11, I).',
    'A amostra fica guardada cifrada e não é usada para nenhuma outra finalidade, pessoa ou empresa. Os áudios gerados levam marca d’água digital inaudível de conteúdo sintético.',
    'Posso revogar esta autorização a qualquer momento, pedindo a exclusão em IA › Voz › Voz clonada (ou à empresa); com a exclusão, a amostra, a voz criada e os áudios guardados são apagados.',
  ].join('\n');
}

/** Texto para o dono da voz ler na amostra (começa com a autorização falada, prova de que ele mesmo autorizou). */
export function readingScript(ownerName: string, company: string): string {
  return [
    `Eu, ${ownerName}, autorizo a ${company} a usar a minha voz para responder os clientes no WhatsApp.`,
    'Oi, tudo bem? Que bom que você chamou! Eu vou te ajudar com o que precisar, tá bom?',
    'Deixa eu te explicar rapidinho como funciona: você escolhe o produto, a gente confirma o pedido e combina a entrega ou a retirada.',
    'O pagamento pode ser no Pix, no cartão ou em dinheiro. Se preferir, eu te mando o link certinho agora mesmo.',
    'Qualquer dúvida, pode me chamar por aqui, viu? Eu respondo rapidinho. Muito obrigado pela confiança e até já!',
    'Agora fale do seu jeito, por mais um minuto: conte como é o seu trabalho, o que a empresa faz e como você costuma atender, com calma e naturalidade.',
  ].join('\n\n');
}

export const PREVIEW_TEXT = 'Oi, tudo bem? Aqui é do atendimento. Me conta como eu posso te ajudar hoje que eu já te respondo, tá bom?';

const aad = (p: { id: string; orgId: string }) => `${p.orgId}:${p.id}`;
const newWorkerId = () => 'v' + randomBytes(12).toString('hex');

export type PublicProfile = Awaited<ReturnType<typeof listProfiles>>[number];

export async function listProfiles(orgId: string) {
  const [ps, s] = await Promise.all([
    prisma.voiceProfile.findMany({ where: { orgId, status: { not: 'EXCLUIDA' } }, orderBy: { createdAt: 'desc' }, select: { id: true, ownerName: true, ownerRole: true, ownerEmail: true, consentAt: true, consentVersion: true, sampleSeconds: true, status: true, error: true, previewText: true, activatedAt: true, createdAt: true, previewOgg: false } }),
    prisma.aiSettings.findUnique({ where: { orgId }, select: { voiceCloneProfileId: true, voiceProvider: true, voiceEnabled: true } }),
  ]);
  const withPreview = new Set((await prisma.voiceProfile.findMany({ where: { orgId, previewOgg: { not: null } }, select: { id: true } })).map((x) => x.id));
  return ps.map((p) => ({ ...p, hasPreview: withPreview.has(p.id), inUse: s?.voiceCloneProfileId === p.id && s?.voiceProvider === 'clone' }));
}

export async function createProfile(req: Request | null, orgId: string, userId: string | null, b: { ownerName: string; ownerRole: string; ownerEmail?: string; accept: boolean; ip?: string | null; baseVoice?: string }) {
  if (!b.accept) throw new Error('O dono da voz precisa aceitar o termo de autorização.');
  const count = await prisma.voiceProfile.count({ where: { orgId, status: { not: 'EXCLUIDA' } } });
  if (count >= MAX_PROFILES) throw new Error(`Limite de ${MAX_PROFILES} vozes por empresa. Exclua uma para cadastrar outra.`);
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  const company = org?.name ?? 'a empresa';
  const p = await prisma.voiceProfile.create({
    data: {
      orgId, ownerName: b.ownerName, ownerRole: b.ownerRole, ownerEmail: b.ownerEmail ?? '',
      consentText: consentText({ ownerName: b.ownerName, company }), consentVersion: CONSENT_VERSION, consentAt: new Date(),
      consentIp: b.ip ?? null, consentUserId: userId, workerVoiceId: newWorkerId(), baseVoice: b.baseVoice || 'Puck',
    },
  });
  await audit(req, 'voz.clone.aceite', { orgId, entity: 'VoiceProfile', entityId: p.id, meta: { ownerName: b.ownerName, ownerRole: b.ownerRole, versao: CONSENT_VERSION } }).catch(() => undefined);
  return { id: p.id, script: readingScript(b.ownerName, company), consentText: p.consentText };
}

/** Guarda a amostra (OGG/Opus já convertido), cifrada, e coloca na fila do servidor de voz. */
export async function saveSample(req: Request | null, orgId: string, id: string, ogg: Buffer, seconds: number) {
  const p = await prisma.voiceProfile.findFirst({ where: { id, orgId, status: { not: 'EXCLUIDA' } } });
  if (!p) throw new Error('Voz não encontrada.');
  if (seconds < MIN_SAMPLE_SECONDS - 1) throw new Error(`A amostra tem ${Math.round(seconds)} s. Grave pelo menos 1 minuto (ideal: 2 minutos).`);
  if (seconds > MAX_SAMPLE_SECONDS + 5) throw new Error('A amostra passou de 3 minutos. Grave de 1 a 3 minutos.');
  await prisma.voiceProfile.update({ where: { id }, data: { sampleEnc: new Uint8Array(encryptBytes(ogg, undefined, aad(p))), sampleSeconds: seconds, status: 'NA_FILA', error: null, attempts: 0, previewOgg: null } });
  if (p.status === 'ATIVA' || p.status === 'PRONTA') await prisma.voiceCloneCache.deleteMany({ where: { profileId: id } });
  await audit(req, 'voz.clone.amostra', { orgId, entity: 'VoiceProfile', entityId: id, meta: { segundos: Math.round(seconds) } }).catch(() => undefined);
  void processProfile(id).catch(() => undefined);
}

const running = new Set<string>();

/** Ensina a voz ao servidor de voz e gera a prévia. Nunca lança; atualiza o status. */
export async function processProfile(id: string): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    const p = await prisma.voiceProfile.findUnique({ where: { id } });
    if (!p || !p.sampleEnc || !['NA_FILA', 'PROCESSANDO'].includes(p.status)) return;
    const st = await workerStatus(true);
    if (!st.configured || !st.ok) {
      await prisma.voiceProfile.update({ where: { id }, data: { status: 'NA_FILA', error: st.configured ? 'Servidor de voz fora do ar; tentando de novo sozinho.' : 'Aguardando o servidor de voz ser ligado.' } });
      return;
    }
    await prisma.voiceProfile.update({ where: { id }, data: { status: 'PROCESSANDO', error: null, attempts: { increment: 1 } } });
    const sample = decryptBytes(Buffer.from(p.sampleEnc), undefined, aad(p));
    const reg = await voiceWorker().register(p.workerVoiceId, sample);
    const rj = await waitJob(reg.job_id, 300_000, 1500);
    if (rj.status === 'error') throw new WorkerError(rj.error || 'Falha ao aprender a voz', 0, 'job');
    // Prévia pelo mesmo caminho das respostas (rápido com voz-base grátis; senão qualidade).
    const s = await prisma.aiSettings.findUnique({ where: { orgId: p.orgId } });
    const keys = s ? { provider: s.provider, model: s.model, apiKey: decryptOrNull(s.apiKeyEnc), baseUrl: s.baseUrl, voiceApiKey: null, orgId: p.orgId, cloneProfileId: id } : undefined;
    await prisma.voiceCloneCache.deleteMany({ where: { profileId: id } });
    let enc: TtsResult;
    try {
      enc = await new CloneVoice(p.orgId, id, keys, true).tts(PREVIEW_TEXT, { voice: '', style: '', timeoutMs: 300_000 });
    } catch (e) {
      throw new WorkerError((e as Error).message.replace(/^Voz clonada: /, ''), 0, /fora do ar|demorou/.test((e as Error).message) ? 'down' : 'job');
    }
    await prisma.voiceProfile.update({ where: { id }, data: { previewOgg: new Uint8Array(enc.ogg), previewText: PREVIEW_TEXT, status: s?.voiceCloneProfileId === id && s?.voiceProvider === 'clone' ? 'ATIVA' : 'PRONTA', error: null } });
  } catch (e) {
    const err = e as WorkerError;
    const p = await prisma.voiceProfile.findUnique({ where: { id }, select: { attempts: true } }).catch(() => null);
    const transient = err instanceof WorkerError && ['down', 'timeout', 'not_configured'].includes(err.code);
    if (transient) markWorkerDown();
    const giveUp = !transient || (p?.attempts ?? 0) >= MAX_ATTEMPTS;
    await prisma.voiceProfile.update({ where: { id }, data: { status: giveUp ? 'ERRO' : 'NA_FILA', error: (giveUp ? `Não deu para criar a voz: ${err.message}. Grave a amostra de novo (lugar silencioso, voz natural).` : `${err.message}; tentando de novo sozinho.`).slice(0, 400) } }).catch(() => undefined);
    console.warn('[voz-clone] falha ao processar a voz', { profileId: id, error: err.message, code: err.code });
  } finally {
    running.delete(id);
  }
}

function pcmFromB64(b64: string): Int16Array {
  const buf = Buffer.from(b64, 'base64');
  const copy = new Uint8Array(buf.length - (buf.length % 2));
  copy.set(buf.subarray(0, copy.length));
  return new Int16Array(copy.buffer);
}

export async function previewOf(orgId: string, id: string): Promise<Buffer | null> {
  const p = await prisma.voiceProfile.findFirst({ where: { id, orgId, status: { not: 'EXCLUIDA' } }, select: { previewOgg: true } });
  return p?.previewOgg ? Buffer.from(p.previewOgg) : null;
}

/** Ativa a voz (só depois da prévia): passa a ser a voz da IA (motor "Voz clonada"). */
export async function activateProfile(req: Request | null, orgId: string, id: string) {
  const p = await prisma.voiceProfile.findFirst({ where: { id, orgId, status: { in: ['PRONTA', 'ATIVA'] } } });
  if (!p || !p.previewOgg) throw new Error('Ouça a prévia antes: a voz ainda não está pronta.');
  await prisma.$transaction([
    prisma.voiceProfile.updateMany({ where: { orgId, status: 'ATIVA', id: { not: id } }, data: { status: 'PRONTA' } }),
    prisma.voiceProfile.update({ where: { id }, data: { status: 'ATIVA', activatedAt: new Date() } }),
    prisma.aiSettings.upsert({ where: { orgId }, create: { orgId, voiceCloneProfileId: id, voiceProvider: 'clone', voiceEnabled: true }, update: { voiceCloneProfileId: id, voiceProvider: 'clone', voiceEnabled: true } }),
  ]);
  await audit(req, 'voz.clone.ativar', { orgId, entity: 'VoiceProfile', entityId: id }).catch(() => undefined);
}

/** Exclusão a pedido do dono da voz (ou da empresa): apaga amostra, prévia, cache e a voz no servidor de voz. */
export async function deleteProfile(req: Request | null, orgId: string, id: string, reason: string) {
  const p = await prisma.voiceProfile.findFirst({ where: { id, orgId, status: { not: 'EXCLUIDA' } } });
  if (!p) throw new Error('Voz não encontrada.');
  let removedOnWorker = false;
  if (voiceWorker().configured()) { try { await voiceWorker().remove(p.workerVoiceId); removedOnWorker = true; } catch { removedOnWorker = false; } }
  await prisma.$transaction([
    prisma.voiceCloneCache.deleteMany({ where: { profileId: id } }),
    prisma.voiceProfile.update({ where: { id }, data: { status: 'EXCLUIDA', sampleEnc: null, previewOgg: null, deletedAt: new Date(), deletedReason: reason.slice(0, 300), error: removedOnWorker || !voiceWorker().configured() ? null : 'remover_no_servidor' } }),
    prisma.aiSettings.updateMany({ where: { orgId, voiceCloneProfileId: id }, data: { voiceCloneProfileId: null, voiceProvider: 'gemini' } }),
  ]);
  await audit(req, 'voz.clone.excluir', { orgId, entity: 'VoiceProfile', entityId: id, meta: { motivo: reason.slice(0, 200), removidaNoServidor: removedOnWorker } }).catch(() => undefined);
}

// ---------- Falar com a voz clonada (motor "clone") ----------
const cloneTimeoutMs = () => { const v = Number(process.env.VOICE_CLONE_TIMEOUT_MS); return Number.isFinite(v) && v > 0 ? v : 90_000; };
export const textHash = (profileId: string, text: string) => createHash('sha256').update(`${profileId}\n${text.trim()}`).digest('hex');

/** Modo da voz clonada: auto (rápido e, se falhar, qualidade) | rapido | qualidade. VOICE_CLONE_MODE. */
export const cloneMode = (env: Record<string, string | undefined> = process.env): 'auto' | 'rapido' | 'qualidade' => {
  const m = (env.VOICE_CLONE_MODE ?? '').trim();
  return m === 'rapido' || m === 'qualidade' ? m : 'auto';
};

export class CloneVoice implements VoiceProvider {
  name = 'clone';
  constructor(private orgId: string, private profileId: string, private keys?: VoiceKeys, private forPreview = false) {}
  async transcribe(): Promise<TranscribeResult> { throw new AiProviderError('http', 'A voz clonada não transcreve áudios', false); }

  /** Pede ao servidor de voz; se ele perdeu a voz (VM recriada), ensina de novo pela amostra cifrada e repete. */
  private async withVoice(p: VoiceProfileRow, timeout: number, call: () => Promise<{ job_id: string } | { missing: true }>): Promise<WorkerJob> {
    const started = Date.now();
    let t = await call();
    if ('missing' in t) {
      if (!p.sampleEnc) throw new WorkerError('Amostra não encontrada', 0, 'missing');
      const reg = await voiceWorker().register(p.workerVoiceId, decryptBytes(Buffer.from(p.sampleEnc), undefined, aad(p)));
      const rj = await waitJob(reg.job_id, timeout, 1000);
      if (rj.status === 'error') throw new WorkerError(rj.error || 'Falha ao reaprender a voz', 0, 'job');
      t = await call();
      if ('missing' in t) throw new WorkerError('Voz não encontrada no servidor de voz', 0, 'missing');
    }
    const j = await waitJob(t.job_id, Math.max(5000, timeout - (Date.now() - started)), 500);
    if (j.status === 'error' || !j.pcm16_b64) throw new WorkerError(j.error || 'Falha ao gerar o áudio', 0, 'job');
    return j;
  }

  async tts(text: string, opts: TtsOptions): Promise<TtsResult> {
    const p = await prisma.voiceProfile.findFirst({ where: { id: this.profileId, orgId: this.orgId, status: { in: this.forPreview ? ['ATIVA', 'PRONTA', 'PROCESSANDO'] : ['ATIVA', 'PRONTA'] } } });
    if (!p) throw new AiProviderError('http', 'A voz clonada não está pronta (IA › Voz › Voz do vendedor)', false, '400');
    const hash = textHash(p.id, text);
    const hit = await prisma.voiceCloneCache.findUnique({ where: { profileId_textHash: { profileId: p.id, textHash: hash } } }).catch(() => null);
    if (hit) {
      await prisma.voiceCloneCache.update({ where: { id: hit.id }, data: { hits: { increment: 1 }, lastUsedAt: new Date() } }).catch(() => undefined);
      return { ogg: Buffer.from(hit.ogg), seconds: hit.seconds, waveform: hit.waveform ? new Uint8Array(hit.waveform) : undefined, model: 'clone:cache', promptTokens: 0, completionTokens: 0 };
    }
    const st = await workerStatus();
    if (!st.configured) throw new AiProviderError('http', 'Servidor de voz não configurado', false, '503');
    if (!st.ok) throw new AiProviderError('network', 'Servidor de voz fora do ar', true, '503');
    const timeout = Math.max(opts.timeoutMs ?? 0, cloneTimeoutMs());
    const mode = cloneMode();
    let tokens = { promptTokens: 0, completionTokens: 0 };
    let model = 'clone:chatterbox';
    try {
      let j: WorkerJob | null = null;
      if (mode !== 'qualidade' && this.keys) {
        // Rápido: voz-base grátis (Gemini TTS / MCK IA) + troca de timbre no nosso servidor (OpenVoice v2).
        try {
          // Voz-base: Gemini (grátis; chave da empresa ou MCK IA) ou, para quem usa OpenAI, a voz da OpenAI.
          let base: { p: VoiceProvider; usageProvider: string };
          let baseVoice = p.baseVoice || 'Puck';
          try { base = buildTts('gemini', this.keys); } catch {
            base = buildTts('openai', this.keys);
            baseVoice = baseVoice === 'Kore' ? 'coral' : 'ash';
          }
          const b = await base.p.tts(text, { voice: baseVoice, style: opts.style || 'Fale de forma natural, em ritmo de conversa, como um atendente brasileiro.', timeoutMs: Math.min(timeout, 40000) });
          tokens = { promptTokens: b.promptTokens, completionTokens: b.completionTokens };
          j = await this.withVoice(p, timeout, () => voiceWorker().convert(p.workerVoiceId, b.ogg, `${base.usageProvider}-${baseVoice}`));
          model = 'clone:openvoice';
        } catch (e) {
          if (mode === 'rapido') throw e;
          console.warn('[voz-clone] modo rápido falhou; tentando o modo qualidade', { orgId: this.orgId, error: (e as Error).message });
        }
      }
      if (!j) j = await this.withVoice(p, timeout, () => voiceWorker().tts(p.workerVoiceId, text));
      const enc = pcmToOggOpus({ samples: pcmFromB64(j.pcm16_b64!), rate: j.rate || 24000 });
      await prisma.voiceCloneCache.create({ data: { orgId: this.orgId, profileId: p.id, textHash: hash, ogg: new Uint8Array(enc.ogg), seconds: enc.seconds, waveform: new Uint8Array(enc.waveform) } }).catch(() => undefined);
      void trimCache(this.orgId);
      return { ogg: enc.ogg, seconds: enc.seconds, waveform: enc.waveform, model, ...tokens };
    } catch (e) {
      if (e instanceof AiProviderError) throw e;
      const err = e as WorkerError;
      if (err instanceof WorkerError && err.code === 'down') markWorkerDown();
      throw new AiProviderError(err.code === 'timeout' ? 'timeout' : 'network', `Voz clonada: ${err.message}`, err.code === 'down' || err.code === 'timeout', err.status ? String(err.status) : undefined);
    }
  }
}

async function trimCache(orgId: string) {
  const old = await prisma.voiceCloneCache.findMany({ where: { orgId }, orderBy: { lastUsedAt: 'desc' }, skip: CACHE_PER_ORG, select: { id: true } }).catch(() => []);
  if (old.length) await prisma.voiceCloneCache.deleteMany({ where: { id: { in: old.map((o) => o.id) } } }).catch(() => undefined);
}

/** Rotina de fundo: processa vozes na fila e termina exclusões pendentes no servidor de voz. */
export async function voiceCloneTick(): Promise<void> {
  const st = await workerStatus(true);
  if (!st.configured || !st.ok) return;
  const pend = await prisma.voiceProfile.findMany({ where: { status: { in: ['NA_FILA', 'PROCESSANDO'] }, sampleEnc: { not: null } }, select: { id: true }, take: 5, orderBy: { updatedAt: 'asc' } });
  for (const p of pend) await processProfile(p.id);
  const del = await prisma.voiceProfile.findMany({ where: { status: 'EXCLUIDA', error: 'remover_no_servidor' }, select: { id: true, workerVoiceId: true }, take: 20 });
  for (const d of del) {
    try { await voiceWorker().remove(d.workerVoiceId); await prisma.voiceProfile.update({ where: { id: d.id }, data: { error: null } }); } catch { /* tenta no próximo ciclo */ }
  }
}

let timer: NodeJS.Timeout | null = null;
export function startVoiceCloneLoop(everyMs = 120_000) {
  if (timer || process.env.NODE_ENV === 'test') return;
  // Ao subir, vozes que ficaram "processando" (reinício no meio) voltam para a fila.
  void prisma.voiceProfile.updateMany({ where: { status: 'PROCESSANDO' }, data: { status: 'NA_FILA' } }).catch(() => undefined);
  timer = setInterval(() => { void voiceCloneTick().catch((e) => console.warn('[voz-clone] rotina', (e as Error).message)); }, everyMs);
  timer.unref?.();
}
