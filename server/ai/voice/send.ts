/**
 * Voz da IA (v1.23.0): envia a resposta da IA como texto ou como nota de voz, conforme a configuração
 * (Inteligência artificial › Voz), a preferência do cliente nesta conversa (pediu áudio/texto) e o que ele
 * mandou por último (modo "espelhar").
 * Qualquer problema com a voz cai para o texto de sempre: o cliente nunca fica sem resposta.
 */
import type { Contact, Conversation, Message } from '@prisma/client';
import { prisma } from '../../db.js';
import { sendOutbound, resolveChannel, isQrChannel } from '../../whatsapp/messaging.js';
import { qrManager } from '../../whatsapp/qr/manager.js';
import { isAudioType } from './spoken.js';
import { decideWithPreference } from './preference.js';
import { synthesizeReply } from './service.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Divide um texto longo em partes de até `maxChars` caracteres, sem cortar frases (v1.27.3). */
export function splitIntoVoiceChunks(text: string, maxChars: number): string[] {
  const sentences = text.replace(/\r/g, '').split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const sent of sentences) {
    if (cur && (cur + ' ' + sent).length > maxChars) { out.push(cur); cur = sent; } else cur = cur ? `${cur} ${sent}` : sent;
  }
  if (cur) out.push(cur);
  return out;
}

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
    // Preferência do cliente nesta conversa (pediu áudio/texto) vale acima do modo da empresa; lida do banco
    // porque acabou de ser gravada ao gerar a resposta (o objeto `conv` pode estar desatualizado).
    const fresh = await prisma.conversation.findUnique({ where: { id: conv.id }, select: { voicePreference: true } });
    if (!decideWithPreference(s, await lastInboundWasAudio(conv.id), fresh?.voicePreference)) return sendText(text);
    const channel = await resolveChannel(conv);
    const qr = isQrChannel(channel) && channel ? channel.id : null;
    // "gravando áudio..." enquanto a voz é gerada (só no modo QR; a API oficial não tem esse aviso).
    if (qr) await qrManager.presence(qr, contact.waId, 'recording');
    const started = Date.now();
    const v = await synthesizeReply({ orgId: conv.orgId, conversationId: conv.id, text, settings: s });
    if (!v.ok && /longa demais|longo demais/i.test(v.reason)) {
      // v1.27.3: o cliente quer áudio e a resposta é longa → manda em várias notas de voz curtas, em ordem.
      const parts = splitIntoVoiceChunks(text, Math.max(5, s.voiceMaxSeconds || 45) * 14);
      let first: Message | null = null;
      let extras: string[] = [];
      let okAll = parts.length > 1;
      for (const part of okAll ? parts : []) {
        if (qr) await qrManager.presence(qr, contact.waId, 'recording');
        const pv = await synthesizeReply({ orgId: conv.orgId, conversationId: conv.id, text: part, settings: s });
        if (!pv.ok) { okAll = false; if (first) { await sendText(part); continue; } break; }
        const pm = await sendOutbound({ conversation: conv, contact, sender: 'ai', payload: { type: 'voice', data: pv.audio.ogg, mime: 'audio/ogg; codecs=opus', seconds: pv.audio.seconds, waveform: pv.audio.waveform, text: pv.spoken } });
        if (pm.status === 'FAILED') { if (first) { await sendText(part); continue; } okAll = false; break; }
        first = first ?? pm;
        if (pv.extra) extras.push(pv.extra);
      }
      if (qr) await qrManager.presence(qr, contact.waId, 'paused');
      if (first) { if (extras.length) await sendText([...new Set(extras)].join('\n')); return first; }
      if (!okAll) console.warn('[voz] partes em áudio falharam; resposta vai por texto', { orgId: conv.orgId, conversationId: conv.id });
      return sendText(text);
    }
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
