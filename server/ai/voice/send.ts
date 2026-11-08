/**
 * Voz da IA (v1.23.0): envia a resposta da IA como texto ou como nota de voz, conforme a configuração
 * (Inteligência artificial › Voz) e o que o cliente mandou por último (modo "espelhar").
 * Qualquer problema com a voz cai para o texto de sempre: o cliente nunca fica sem resposta.
 */
import type { Contact, Conversation, Message } from '@prisma/client';
import { prisma } from '../../db.js';
import { sendOutbound, resolveChannel, isQrChannel } from '../../whatsapp/messaging.js';
import { qrManager } from '../../whatsapp/qr/manager.js';
import { decideReplyAsAudio, isAudioType } from './spoken.js';
import { synthesizeReply } from './service.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A última mensagem do cliente nesta conversa foi um áudio? */
export async function lastInboundWasAudio(conversationId: string): Promise<boolean> {
  const m = await prisma.message.findFirst({ where: { conversationId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { type: true } });
  return isAudioType(m?.type);
}

/** Envia a resposta da IA (texto ou nota de voz + detalhes por escrito). Devolve a mensagem principal. */
export async function sendAiReply(conv: Conversation, contact: Contact, text: string): Promise<Message> {
  const sendText = (t: string) => sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: t }, sender: 'ai' });
  try {
    const s = await prisma.aiSettings.findUnique({ where: { orgId: conv.orgId } });
    if (!s?.voiceEnabled || contact.optOut) return sendText(text);
    if (!decideReplyAsAudio(s, await lastInboundWasAudio(conv.id))) return sendText(text);
    const channel = await resolveChannel(conv);
    const qr = isQrChannel(channel) && channel ? channel.id : null;
    // "gravando áudio..." enquanto a voz é gerada (só no modo QR; a API oficial não tem esse aviso).
    if (qr) await qrManager.presence(qr, contact.waId, 'recording');
    const started = Date.now();
    const v = await synthesizeReply({ orgId: conv.orgId, conversationId: conv.id, text, settings: s });
    if (!v.ok) {
      if (qr) await qrManager.presence(qr, contact.waId, 'paused');
      console.warn('[voz] resposta vai por texto', { orgId: conv.orgId, conversationId: conv.id, reason: v.reason });
      return sendText(text);
    }
    // Ritmo humano: o "gravando" fica visível pelo menos ~1,5 s (não nos testes).
    if (qr && process.env.NODE_ENV !== 'test') { const wait = 1500 - (Date.now() - started); if (wait > 0) await sleep(wait); }
    const m = await sendOutbound({
      conversation: conv, contact, sender: 'ai',
      payload: { type: 'voice', data: v.audio.ogg, mime: 'audio/ogg; codecs=opus', seconds: v.audio.seconds, waveform: v.audio.waveform, text: v.spoken },
    });
    if (qr) await qrManager.presence(qr, contact.waId, 'paused');
    if (m.status === 'FAILED') {
      // Nota de voz recusada (formato, upload): manda a mesma resposta por texto.
      console.warn('[voz] falha ao enviar a nota de voz, enviando texto', { orgId: conv.orgId, conversationId: conv.id, error: m.error });
      return sendText(text);
    }
    if (v.extra) await sendText(v.extra);
    return m;
  } catch (e) {
    console.error('[voz] erro inesperado; resposta vai por texto', { orgId: conv.orgId, conversationId: conv.id, error: (e as Error).message });
    return sendText(text);
  }
}
