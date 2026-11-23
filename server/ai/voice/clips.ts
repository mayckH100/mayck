/**
 * v1.47.0 — Biblioteca de áudios gravados.
 *
 * O vendedor/responsável grava (ou envia) até MAX_CLIPS áudios curtos ("Boas-vindas", "Como funciona a entrega",
 * "Formas de pagamento"...), cada um com "quando usar" e o que é dito. Com a biblioteca ligada (IA › Voz), a IA vê a
 * lista e, quando um áudio responde bem ao cliente, põe o marcador [AUDIO:id] na resposta: o áudio sai como áudio
 * gravado (PTT, microfone) e o resto do texto vai por escrito logo depois. Um áudio não se repete na mesma conversa.
 */
import type { Contact, Conversation, Message } from '@prisma/client';
import { prisma } from '../../db.js';
import { decodePcm, isOggOpus, oggOpusDurationSec, pcmToOggOpus } from './ogg.js';

export const MAX_CLIPS = 40;
export const MAX_CLIP_SECONDS = 120;
export const MAX_CLIP_BYTES = 8 * 1024 * 1024;
export const CLIP_BODY_PREFIX = '[áudio gravado]';

/** Marcador que a IA usa para escolher um áudio. */
export const CLIP_MARKER_RE = /\[\s*AUDIO\s*:\s*([A-Za-z0-9_-]{6,40})\s*\]/gi;

/** Tira o(s) marcador(es) do texto e devolve o 1º id. Puro, testável. */
export function extractClipMarker(text: string): { text: string; clipId: string | null } {
  let clipId: string | null = null;
  const out = text.replace(CLIP_MARKER_RE, (_m, id: string) => { if (!clipId) clipId = id; return ' '; });
  return { text: out.replace(/[ \t]{2,}/g, ' ').replace(/^\s+/, '').trim(), clipId };
}

/**
 * Converte o arquivo recebido em OGG/Opus para o WhatsApp. Aceita WAV (gravação no app e arquivos convertidos no
 * navegador) e OGG/Opus (áudio do WhatsApp). Devolve duração e forma de onda.
 */
export function toVoiceNote(buf: Buffer, mime = ''): { ogg: Buffer; seconds: number; waveform: Uint8Array | null } {
  if (!buf.length) throw new Error('Arquivo vazio.');
  if (isOggOpus(buf)) {
    const seconds = oggOpusDurationSec(buf);
    if (!seconds) throw new Error('Áudio OGG inválido.');
    return { ogg: buf, seconds, waveform: null };
  }
  let pcm;
  try { pcm = decodePcm(buf, mime); } catch { throw new Error('Formato não aceito. Grave pelo app ou envie MP3, M4A, OGG ou WAV.'); }
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Formato não aceito. Grave pelo app ou envie MP3, M4A, OGG ou WAV.');
  const enc = pcmToOggOpus(pcm);
  return { ogg: enc.ogg, seconds: enc.seconds, waveform: enc.waveform };
}

/** Títulos dos áudios gravados já enviados nesta conversa (não repetir). */
async function sentTitles(conversationId: string): Promise<Set<string>> {
  if (!conversationId) return new Set();
  const ms = await prisma.message.findMany({ where: { conversationId, direction: 'OUT', body: { startsWith: CLIP_BODY_PREFIX } }, select: { body: true }, take: 100, orderBy: { createdAt: 'desc' } });
  return new Set(ms.map((m) => (m.body ?? '').slice(CLIP_BODY_PREFIX.length).split('\n')[0].trim()));
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** Seção do prompt com os áudios disponíveis (vazia se a biblioteca estiver desligada ou sem áudios). */
export async function clipsPromptSection(orgId: string, conversationId: string, enabled: boolean): Promise<string> {
  if (!enabled) return '';
  // Cliente pediu para conversar por escrito nesta conversa: sem áudio gravado.
  const conv = conversationId ? await prisma.conversation.findUnique({ where: { id: conversationId }, select: { voicePreference: true } }).catch(() => null) : null;
  if (conv?.voicePreference === 'texto') return '';
  const clips = await prisma.voiceClip.findMany({ where: { orgId, active: true }, select: { id: true, title: true, whenToUse: true, transcript: true }, orderBy: { createdAt: 'asc' }, take: MAX_CLIPS });
  if (!clips.length) return '';
  const sent = await sentTitles(conversationId).catch(() => new Set<string>());
  const avail = clips.filter((c) => !sent.has(c.title.trim()));
  if (!avail.length) return '';
  const lines = avail.map((c) => `- [AUDIO:${c.id}] "${oneLine(c.title, 80)}" — usar quando: ${oneLine(c.whenToUse || c.title, 200)}${c.transcript ? ` — o áudio diz: "${oneLine(c.transcript, 300)}"` : ''}`);
  return [
    'ÁUDIOS GRAVADOS PELA EQUIPE (voz real do vendedor):',
    ...lines,
    'Regra: se UM destes áudios responde bem à mensagem atual do cliente, comece a resposta com o marcador dele (ex.: [AUDIO:id]). Use no máximo um por resposta, só quando combinar de verdade com o que o cliente perguntou. Depois do marcador escreva só o que o áudio NÃO diz (pode ficar vazio). Nunca invente marcador e nunca cite o marcador para o cliente.',
  ].join('\n');
}

/** Confere se o áudio escolhido pela IA existe, está ativo e é da organização. */
export async function validClip(orgId: string, clipId: string | null | undefined) {
  if (!clipId) return null;
  return prisma.voiceClip.findFirst({ where: { id: clipId, orgId, active: true } }).catch(() => null);
}

/**
 * Envia o áudio gravado como PTT. Devolve a mensagem (status FAILED se não saiu). Nunca lança.
 * `send` é o sendOutbound (injetado para não criar dependência circular).
 */
export async function sendClip(
  conv: Conversation, contact: Contact, clipId: string,
  send: (payload: any) => Promise<Message>,
): Promise<Message | null> {
  const clip = await validClip(conv.orgId, clipId);
  if (!clip) return null;
  try {
    const m = await send({ type: 'voice', data: Buffer.from(clip.audio), mime: 'audio/ogg; codecs=opus', seconds: clip.seconds, waveform: clip.waveform ? new Uint8Array(clip.waveform) : undefined, text: `${CLIP_BODY_PREFIX} ${clip.title}${clip.transcript ? `\n${clip.transcript}` : ''}` });
    if (m.status !== 'FAILED') await prisma.voiceClip.update({ where: { id: clip.id }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() } }).catch(() => undefined);
    return m;
  } catch (e) {
    console.warn('[voz-biblioteca] falha ao enviar áudio gravado', { orgId: conv.orgId, conversationId: conv.id, error: (e as Error).message });
    return null;
  }
}
