import { prisma } from '../db.js';
import { decryptOrNull } from '../lib/crypto.js';
import { sendCloudMessage, GraphApiError, type OutboundPayload } from './cloudClient.js';
import type { Channel, Conversation, Contact, Message } from '@prisma/client';

export const WINDOW_MS = 24 * 3600 * 1000;

export function isWithinWindow(conv: Pick<Conversation, 'lastInboundAt'>, now = new Date()): boolean {
  return !!conv.lastInboundAt && now.getTime() - conv.lastInboundAt.getTime() < WINDOW_MS;
}

function describe(p: OutboundPayload): { type: string; body: string | null; mediaUrl: string | null } {
  switch (p.type) {
    case 'text': return { type: 'text', body: p.text, mediaUrl: null };
    case 'buttons': return { type: 'buttons', body: p.text + '\n' + p.buttons.map((b) => `[${b.title}]`).join(' '), mediaUrl: null };
    case 'template': return { type: 'template', body: `Modelo: ${p.name} (${p.language})`, mediaUrl: null };
    default: return { type: p.type, body: p.caption ?? null, mediaUrl: p.link };
  }
}

/** Escolhe o canal da conversa ou o primeiro canal da organização. */
async function resolveChannel(conv: Conversation): Promise<Channel | null> {
  if (conv.channelId) {
    const ch = await prisma.channel.findFirst({ where: { id: conv.channelId, orgId: conv.orgId } });
    if (ch) return ch;
  }
  return prisma.channel.findFirst({ where: { orgId: conv.orgId }, orderBy: { createdAt: 'asc' } });
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
}): Promise<Message> {
  const { conversation, contact, payload, sender } = args;
  const d = describe(payload);
  const channel = await resolveChannel(conversation);
  const msg = await prisma.message.create({
    data: {
      orgId: conversation.orgId, conversationId: conversation.id, channelId: channel?.id ?? null,
      direction: 'OUT', sender, type: d.type, body: d.body, mediaUrl: d.mediaUrl, status: 'QUEUED', authorUserId: args.authorUserId,
    },
  });
  const fail = async (error: string, attempts = 0) =>
    prisma.message.update({ where: { id: msg.id }, data: { status: 'FAILED', error, attempts } });

  if (contact.optOut && sender !== 'agent') return fail('Contato pediu para não receber mensagens automáticas (opt-out)');
  const accessToken = decryptOrNull(channel?.accessTokenEnc);
  if (!channel || channel.status !== 'CONNECTED' || !channel.phoneNumberId || !accessToken) {
    return fail('Canal WhatsApp não conectado: configure as credenciais da Cloud API em Canais WhatsApp');
  }
  if (payload.type !== 'template' && !isWithinWindow(conversation)) {
    return fail('Fora da janela de 24 horas: só é permitido enviar um modelo (template) aprovado pela Meta');
  }
  try {
    const r = await sendCloudMessage({ phoneNumberId: channel.phoneNumberId, accessToken }, contact.waId, payload);
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
