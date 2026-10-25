import { prisma } from '../db.js';
import { parseWebhook, type InboundMessage } from './cloudClient.js';
import { applyStatus } from './messaging.js';
import { automateInbound, withConversationLock } from '../flows/engine.js';
import { normalize } from '../flows/logic.js';
import { parseBaileysMessage, mapBaileysStatus } from './qr/parse.js';
import type { WAMessage, WAMessageUpdate } from '@whiskeysockets/baileys';
import type { Channel } from '@prisma/client';

const OPT_OUT = new Set(['sair', 'parar', 'stop', 'descadastrar']);

export interface InboundResult { received: number; duplicates: number; statuses: number; ignored: number }

/** Processa um payload de webhook já autenticado (assinatura válida) para um canal. */
export async function processWebhook(channel: Channel, body: unknown): Promise<InboundResult> {
  const { messages, statuses } = parseWebhook(body);
  const result: InboundResult = { received: 0, duplicates: 0, statuses: 0, ignored: 0 };
  await prisma.channel.update({ where: { id: channel.id }, data: { lastWebhookAt: new Date() } });
  for (const m of messages) {
    if (channel.phoneNumberId && m.phoneNumberId && m.phoneNumberId !== channel.phoneNumberId) { result.ignored++; continue; }
    const r = await handleInboundMessage(channel, m);
    if (r === 'duplicate') result.duplicates++; else result.received++;
  }
  for (const s of statuses) {
    if (await applyStatus(channel.id, s.waMessageId, s.status, s.error)) result.statuses++;
  }
  return result;
}

export async function handleInboundMessage(channel: Channel, m: InboundMessage): Promise<'ok' | 'duplicate'> {
  const orgId = channel.orgId;
  // Idempotência rápida: a Meta reenvia o mesmo evento em caso de timeout.
  const already = await prisma.message.findUnique({ where: { channelId_waMessageId: { channelId: channel.id, waMessageId: m.waMessageId } } });
  if (already) return 'duplicate';

  let contact = await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId: m.from } } });
  const isFirst = !contact || !contact.lastMessageAt;
  if (!contact) {
    try {
      contact = await prisma.contact.create({ data: { orgId, waId: m.from, phone: m.from.includes('@') ? m.from : '+' + m.from, name: m.profileName ?? null } });
    } catch {
      contact = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId, waId: m.from } } });
    }
  } else if (!contact.name && m.profileName) {
    contact = await prisma.contact.update({ where: { id: contact.id }, data: { name: m.profileName } });
  }

  return withConversationLock(`contact:${contact.id}`, async () => {
    let conv = await prisma.conversation.findFirst({ where: { orgId, contactId: contact!.id, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'desc' } });
    if (!conv) conv = await prisma.conversation.create({ data: { orgId, contactId: contact!.id, channelId: channel.id } });

    let message;
    try {
      message = await prisma.message.create({
        data: {
          orgId, conversationId: conv.id, channelId: channel.id, direction: 'IN', sender: 'contact', type: m.type,
          body: m.text || (m.mediaId ? `[${m.type}]` : `[${m.type}]`), waMessageId: m.waMessageId, status: 'RECEIVED', createdAt: m.timestamp > new Date() ? new Date() : m.timestamp,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return 'duplicate' as const;
      throw e;
    }
    const now = new Date();
    conv = await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastInboundAt: now, lastMessageAt: now, unreadCount: { increment: 1 }, channelId: conv.channelId ?? channel.id },
    });
    contact = await prisma.contact.update({ where: { id: contact!.id }, data: { lastMessageAt: now } });

    if (OPT_OUT.has(normalize(m.text))) {
      await prisma.contact.update({ where: { id: contact.id }, data: { optOut: true } });
      await prisma.message.create({ data: { orgId, conversationId: conv.id, direction: 'INTERNAL', sender: 'system', type: 'note', body: 'Contato pediu para não receber mensagens automáticas (opt-out).', status: 'NOTE' } });
      return 'ok' as const;
    }
    if (conv.mode === 'HUMAN' || contact.optOut) return 'ok' as const;
    await withConversationLock(conv.id, () => automateInbound(conv!, contact!, message, { isFirst, replyId: m.replyId }));
    return 'ok' as const;
  });
}

// ---------- Modo QR (Baileys) ----------

/** Mensagem recebida pelo socket do Baileys → mesmo pipeline do webhook (contatos, conversas, fluxos, IA). */
export async function handleQrMessage(channelId: string, raw: WAMessage): Promise<'ok' | 'duplicate' | 'ignored'> {
  const m = parseBaileysMessage(raw);
  if (!m) return 'ignored';
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) return 'ignored';
  await prisma.channel.update({ where: { id: channel.id }, data: { lastWebhookAt: new Date() } });
  return handleInboundMessage(channel, m);
}

/** Atualização de entrega/leitura vinda do Baileys. */
export async function handleQrStatus(channelId: string, u: WAMessageUpdate): Promise<boolean> {
  const st = mapBaileysStatus(u.update?.status ?? null);
  if (!st || !u.key?.id) return false;
  return applyStatus(channelId, u.key.id, st, st === 'failed' ? 'Falha informada pelo WhatsApp' : undefined);
}
