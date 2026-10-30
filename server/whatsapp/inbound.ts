import { prisma } from '../db.js';
import { parseWebhook, downloadCloudMedia, type InboundMessage } from './cloudClient.js';
import { decryptOrNull } from '../lib/crypto.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { receberMidiaWhatsApp } from '../mckmensagem/automacoes/comprovantes.js';
import { applyStatus } from './messaging.js';
import { automateInbound, withConversationLock } from '../flows/engine.js';
import { normalize } from '../flows/logic.js';
import { parseBaileysMessage, mapBaileysStatus } from './qr/parse.js';
import { isSavedInPhone } from './qr/addressBook.js';
import type { WAMessage, WAMessageUpdate } from '@whiskeysockets/baileys';
import type { Channel } from '@prisma/client';
import { onLeadInbound, onLeadOptOut } from '../mckmensagem/hooks.js';
import { qualifyLeadInbound } from '../mckmensagem/qualificacao.js';
import { autoReplyModeOf } from './autoReplyMode.js';

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

export type BaixarMidia = () => Promise<{ dados: Buffer; nome: string; mime?: string }>;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const nomeMidia = (type: string, mime?: string, nome?: string) => nome || `comprovante.${EXT[mime ?? ''] ?? (type === 'image' ? 'jpg' : 'pdf')}`;

/** Download de mídia recebida pela Cloud API (com o token do canal). */
function baixarCloud(channel: Channel, m: InboundMessage): BaixarMidia | undefined {
  if (!m.mediaId) return undefined;
  return async () => {
    const token = decryptOrNull(channel.accessTokenEnc);
    if (!token) throw new Error('Canal sem token para baixar a mídia');
    const r = await downloadCloudMedia(token, m.mediaId!);
    return { dados: r.dados, mime: r.mime, nome: nomeMidia(m.type, r.mime, m.fileName) };
  };
}

/**
 * Contato da mensagem recebida. No modo QR o mesmo cliente pode aparecer pelo número ou pelo LID:
 * um contato criado antes só com o LID passa a ser identificado pelo número quando ele fica conhecido
 * (sem criar um segundo contato).
 */
async function findOrCreateContact(orgId: string, m: InboundMessage) {
  let contact = await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId: m.from } } });
  if (contact) return contact;
  if (m.lid && m.lid !== m.from) {
    const byLid = await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId: m.lid } } });
    if (byLid) {
      try {
        return await prisma.contact.update({ where: { id: byLid.id }, data: { waId: m.from, phone: '+' + m.from } });
      } catch {
        contact = await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId: m.from } } });
        return contact ?? byLid;
      }
    }
  }
  try {
    return await prisma.contact.create({ data: { orgId, waId: m.from, phone: m.from.includes('@') ? m.from : '+' + m.from, name: m.profileName ?? null } });
  } catch {
    return prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId, waId: m.from } } });
  }
}

export async function handleInboundMessage(channel: Channel, m: InboundMessage, baixar?: BaixarMidia): Promise<'ok' | 'duplicate'> {
  const orgId = channel.orgId;
  // Idempotência rápida: a Meta reenvia o mesmo evento em caso de timeout.
  const already = await prisma.message.findUnique({ where: { channelId_waMessageId: { channelId: channel.id, waMessageId: m.waMessageId } } });
  if (already) return 'duplicate';

  let contact = await findOrCreateContact(orgId, m);
  const isFirst = !contact.lastMessageAt;
  if (!contact.name && m.profileName) {
    contact = await prisma.contact.update({ where: { id: contact.id }, data: { name: m.profileName } });
  }

  // Modo QR: contato salvo na agenda do celular conectado não recebe resposta automática
  // (a menos que o canal permita). A mensagem continua entrando no Inbox normalmente.
  let skipAutoReply = false;
  if (channel.provider === 'whatsapp_qr') {
    const saved = await isSavedInPhone(channel.id, [m.from, m.lid, contact.waId]).catch(() => false);
    if (saved && !contact.savedInPhone) contact = await prisma.contact.update({ where: { id: contact.id }, data: { savedInPhone: true } });
    skipAutoReply = saved && !channel.replySavedContacts;
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

    // MCK Mensagens: imagem/PDF de cliente com cobrança em aberto (ou que fala de pagamento) vira comprovante em análise.
    if (m.type === 'image' || m.type === 'document') {
      const dl = baixar ?? baixarCloud(channel, m);
      if (dl) {
        try {
          await receberMidiaWhatsApp(orgId, contact, { waMessageId: m.waMessageId, type: m.type, texto: m.text, baixar: dl });
        } catch (e) {
          console.error('[comprovantes] falha ao registrar mídia recebida:', (e as Error).message);
        }
      }
    }

    const isOptOut = OPT_OUT.has(normalize(m.text));
    if (!isOptOut) await onLeadInbound(orgId, contact);
    if (isOptOut) {
      await prisma.contact.update({ where: { id: contact.id }, data: { optOut: true } });
      await onLeadOptOut(orgId, contact);
      await prisma.message.create({ data: { orgId, conversationId: conv.id, direction: 'INTERNAL', sender: 'system', type: 'note', body: 'Contato pediu para não receber mensagens automáticas (opt-out).', status: 'NOTE' } });
      return 'ok' as const;
    }
    if (conv.mode === 'HUMAN' || contact.optOut || skipAutoReply) return 'ok' as const;
    // "Quem responde automaticamente" deste canal: flows | ai | both (padrão, comportamento original).
    const mode = autoReplyModeOf(channel);
    await withConversationLock(conv.id, async () => {
      // MCK Mensagens: lead abordado por campanha que respondeu → IA de qualificação (quando ligada).
      // No modo "Só fluxos" a IA não responde neste canal, então a qualificação também não roda.
      if (mode !== 'flows' && m.type === 'text' && (await qualifyLeadInbound(conv!, contact!, m.text ?? ''))) return;
      await automateInbound(conv!, contact!, message, { isFirst, replyId: m.replyId, mode });
    });
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
  const baixar: BaixarMidia | undefined = m.type === 'image' || m.type === 'document'
    ? async () => {
      const dados = await downloadMediaMessage(raw, 'buffer', {});
      const c = raw.message?.documentMessage ?? raw.message?.documentWithCaptionMessage?.message?.documentMessage ?? null;
      const mime = c?.mimetype ?? raw.message?.imageMessage?.mimetype ?? undefined;
      return { dados: Buffer.from(dados), mime: mime ?? undefined, nome: nomeMidia(m.type, mime ?? undefined, c?.fileName ?? undefined) };
    }
    : undefined;
  return handleInboundMessage(channel, m, baixar);
}

/** Atualização de entrega/leitura vinda do Baileys. */
export async function handleQrStatus(channelId: string, u: WAMessageUpdate): Promise<boolean> {
  const st = mapBaileysStatus(u.update?.status ?? null);
  if (!st || !u.key?.id) return false;
  return applyStatus(channelId, u.key.id, st, st === 'failed' ? 'Falha informada pelo WhatsApp' : undefined);
}
