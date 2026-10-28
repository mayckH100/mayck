import { prisma } from '../db.js';
import { decryptOrNull } from '../lib/crypto.js';
import { sendCloudMessage, uploadCloudMedia, isImageMime, GraphApiError, type OutboundPayload } from './cloudClient.js';
import { qrManager } from './qr/manager.js';
import { numberedOptions } from './qr/parse.js';
import { assertPublicUrl } from '../lib/ssrf.js';
import { isProductActive, type Product } from '../billing/service.js';
import type { Channel, Conversation, Contact, Message } from '@prisma/client';

export const PROVIDER_CLOUD = 'whatsapp_cloud';
export const PROVIDER_QR = 'whatsapp_qr';
export const isQrChannel = (c?: Pick<Channel, 'provider'> | null) => c?.provider === PROVIDER_QR;

export const WINDOW_MS = 24 * 3600 * 1000;

export function isWithinWindow(conv: Pick<Conversation, 'lastInboundAt'>, now = new Date()): boolean {
  return !!conv.lastInboundAt && now.getTime() - conv.lastInboundAt.getTime() < WINDOW_MS;
}

/** A regra da janela de 24h é da API oficial; no modo QR (WhatsApp Web) ela não se aplica. */
export function windowApplies(channel?: Pick<Channel, 'provider'> | null): boolean {
  return !isQrChannel(channel);
}

function describe(p: OutboundPayload, qr = false): { type: string; body: string | null; mediaUrl: string | null } {
  switch (p.type) {
    case 'text': return { type: 'text', body: p.text, mediaUrl: null };
    case 'buttons': return qr
      ? { type: 'text', body: numberedOptions(p.text, p.buttons), mediaUrl: null }
      : { type: 'buttons', body: p.text + '\n' + p.buttons.map((b) => `[${b.title}]`).join(' '), mediaUrl: null };
    case 'template': return { type: 'template', body: `Modelo: ${p.name} (${p.language})`, mediaUrl: null };
    case 'file': return { type: isImageMime(p.mime) ? 'image' : 'document', body: p.caption || `[${p.filename}]`, mediaUrl: null };
    case 'media_id': return { type: p.kind, body: p.caption || (p.filename ? `[${p.filename}]` : null), mediaUrl: null };
    default: return { type: p.type, body: p.caption ?? null, mediaUrl: p.link };
  }
}

/** Escolhe o canal da conversa ou, na falta dele, um canal conectado (ou o primeiro) da organização. */
export async function resolveChannel(conv: Pick<Conversation, 'channelId' | 'orgId'>): Promise<Channel | null> {
  if (conv.channelId) {
    const ch = await prisma.channel.findFirst({ where: { id: conv.channelId, orgId: conv.orgId } });
    if (ch) return ch;
  }
  return (await prisma.channel.findFirst({ where: { orgId: conv.orgId, status: 'CONNECTED' }, orderBy: { createdAt: 'asc' } }))
    ?? prisma.channel.findFirst({ where: { orgId: conv.orgId }, orderBy: { createdAt: 'asc' } });
}

/**
 * Envia uma mensagem ao contato. Sempre registra no banco:
 *  - status SENT com o id da Meta quando a Graph API aceita;
 *  - status FAILED com o motivo (canal não conectado, fora da janela de 24h, erro da API).
 * Nunca simula envio: sem credenciais válidas, a mensagem fica FAILED.
 */
export async function sendOutbound(args: {
  conversation: Conversation;
  contact: Contact;
  payload: OutboundPayload;
  sender: 'bot' | 'ai' | 'agent' | 'system';
  authorUserId?: string;
  /** App que está enviando (cobrança por produto). Padrão: MCKBOT. */
  product?: Product;
}): Promise<Message> {
  const { conversation, contact, payload, sender } = args;
  const channel = await resolveChannel(conversation);
  const qr = isQrChannel(channel);
  const d = describe(payload, qr);
  const msg = await prisma.message.create({
    data: {
      orgId: conversation.orgId, conversationId: conversation.id, channelId: channel?.id ?? null,
      direction: 'OUT', sender, type: d.type, body: d.body, mediaUrl: d.mediaUrl, status: 'QUEUED', authorUserId: args.authorUserId,
    },
  });
  const fail = async (error: string, attempts = 0) =>
    prisma.message.update({ where: { id: msg.id }, data: { status: 'FAILED', error, attempts } });

  if (!(await isProductActive(conversation.orgId, args.product ?? 'MCKBOT'))) return fail('Assinatura inativa');
  if (contact.optOut && sender !== 'agent') return fail('Contato pediu para não receber mensagens automáticas (opt-out)');
  if (qr) return sendViaQr(channel!, conversation, contact, payload, msg, fail);
  const accessToken = decryptOrNull(channel?.accessTokenEnc);
  if (!channel || channel.status !== 'CONNECTED' || !channel.phoneNumberId || !accessToken) {
    return fail('Canal WhatsApp não conectado: configure as credenciais da Cloud API em Canais WhatsApp');
  }
  if (payload.type !== 'template' && !isWithinWindow(conversation)) {
    return fail('Fora da janela de 24 horas: só é permitido enviar um modelo (template) aprovado pela Meta');
  }
  try {
    const creds = { phoneNumberId: channel.phoneNumberId, accessToken };
    const final: OutboundPayload = payload.type === 'file'
      ? { type: 'media_id', kind: isImageMime(payload.mime) ? 'image' : 'document', id: await uploadCloudMedia(creds, payload.data, payload.mime, payload.filename), caption: payload.caption, filename: payload.filename }
      : payload;
    const r = await sendCloudMessage(creds, contact.waId, final);
    const now = new Date();
    const updated = await prisma.message.update({ where: { id: msg.id }, data: { status: 'SENT', waMessageId: r.waMessageId, attempts: r.attempts } });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: now, ...(conversation.firstResponseAt ? {} : { firstResponseAt: now }) },
    });
    conversation.firstResponseAt ??= now;
    return updated;
  } catch (e) {
    const attempts = (e as { attempts?: number }).attempts ?? 1;
    const message = e instanceof GraphApiError ? e.message : (e as Error).message;
    await prisma.channel.update({ where: { id: channel.id }, data: { lastError: message } });
    return fail(message, attempts);
  }
}

/** Envio pelo modo QR (Baileys): sem janela de 24h; botões viram opções numeradas; mídia por link. */
async function sendViaQr(
  channel: Channel, conversation: Conversation, contact: Contact, payload: OutboundPayload, msg: Message,
  fail: (error: string, attempts?: number) => Promise<Message>,
): Promise<Message> {
  if (payload.type === 'template') return fail('Modelos (templates) só existem na API oficial. No modo QR envie uma mensagem de texto.');
  if (!qrManager.isConnected(channel.id)) return fail('WhatsApp (QR) não conectado: abra Canais WhatsApp e conecte pelo QR code');
  if (payload.type === 'image' || payload.type === 'video' || payload.type === 'audio' || payload.type === 'document') {
    try {
      await assertPublicUrl(payload.link);
    } catch (e) {
      return fail(`Link de mídia recusado: ${(e as Error).message}`);
    }
  }
  try {
    const r = await qrManager.send(channel.id, contact.waId, payload);
    const now = new Date();
    const updated = await prisma.message.update({ where: { id: msg.id }, data: { status: 'SENT', waMessageId: r.waMessageId, attempts: 1 } });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: now, ...(conversation.firstResponseAt ? {} : { firstResponseAt: now }) },
    });
    conversation.firstResponseAt ??= now;
    return updated;
  } catch (e) {
    const message = (e as Error).message || 'Falha ao enviar pelo WhatsApp (QR)';
    return fail(message, 1);
  }
}

const RANK: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

/** Aplica atualização de status (idempotente; nunca regride sent→delivered→read). */
export async function applyStatus(channelId: string, waMessageId: string, status: string, error?: string) {
  const msg = await prisma.message.findUnique({ where: { channelId_waMessageId: { channelId, waMessageId } } });
  if (!msg) return false;
  const next = status.toUpperCase();
  if (next === 'FAILED') {
    await prisma.message.update({ where: { id: msg.id }, data: { status: 'FAILED', error: error ?? 'Falha informada pela Meta' } });
    return true;
  }
  if ((RANK[next] ?? -1) > (RANK[msg.status] ?? -1)) {
    await prisma.message.update({ where: { id: msg.id }, data: { status: next } });
    return true;
  }
  return false;
}

/** Transfere a conversa para atendimento humano e cancela execuções de fluxo ativas. */
export async function handoffToHuman(conversation: Conversation, reason: string) {
  await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: 'HUMAN', status: 'PENDING' } });
  conversation.mode = 'HUMAN';
  conversation.status = 'PENDING';
  await prisma.flowRun.updateMany({
    where: { conversationId: conversation.id, status: { in: ['RUNNING', 'WAITING'] } },
    data: { status: 'HANDOFF', finishedAt: new Date() },
  });
  await prisma.message.create({
    data: { orgId: conversation.orgId, conversationId: conversation.id, direction: 'INTERNAL', sender: 'system', type: 'note', body: `Transferido para atendimento humano: ${reason}`, status: 'NOTE' },
  });
}
